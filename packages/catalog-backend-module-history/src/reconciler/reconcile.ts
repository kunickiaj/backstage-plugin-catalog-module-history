import { randomUUID } from 'node:crypto';
import { LoggerService } from '@backstage/backend-plugin-api';
import {
  EntityRow,
  HistoryStore,
  RECONCILER_PROVIDER,
} from '@kunickiaj/catalog-history-node';
import { entityToRow } from '../mapping/entityToRow';
import { EntityFetcher } from './EntityFetcher';

export type ReconcileOptions = {
  fetcher: EntityFetcher;
  store: HistoryStore;
  logger: LoggerService;
};

/**
 * Snapshots the catalog via the EntityFetcher, diffs it against the
 * reconciler's own previously recorded state, and records a single cycle
 * attributed to provider='reconciler' / source='reconciler' summarizing
 * the changes in served catalog truth.
 *
 * The baseline is intentionally scoped to source='reconciler'. Etags from
 * other capture layers are computed over different content (provider rows
 * over pre-processing envelopes, processing rows over pre-stitch output),
 * so comparing the served-catalog etag against them would report phantom
 * updates on every real change. Each source keeps its own baseline; the
 * first reconcile run therefore records the entire catalog as inserts —
 * an expected one-time cost, same as first enabling processing capture.
 *
 * Records a heartbeat cycle (no row changes) when the served catalog and
 * the reconciler's baseline agree, so an operator can tell from the
 * cycles table that the reconciler is running on schedule.
 */
export async function reconcile(opts: ReconcileOptions): Promise<void> {
  const { fetcher, store, logger } = opts;
  const startedAt = new Date();

  const entities = await fetcher.getEntities();
  const rows: EntityRow[] = entities.map(entity => entityToRow(entity));
  const incomingRefs = new Set(rows.map(r => r.entityRef));

  const existing = await store.loadAllCurrentEtags({ source: 'reconciler' });

  const inserts: EntityRow[] = [];
  const updates: EntityRow[] = [];
  let unchangedCount = 0;

  for (const row of rows) {
    const prev = existing.get(row.entityRef);
    if (prev === undefined) {
      inserts.push(row);
    } else if (prev.etag !== row.etag) {
      updates.push(row);
    } else {
      unchangedCount++;
    }
  }

  const deletes: string[] = [];
  for (const ref of existing.keys()) {
    if (!incomingRefs.has(ref)) {
      deletes.push(ref);
    }
  }

  await store.recordCycle({
    cycleId: randomUUID(),
    provider: RECONCILER_PROVIDER,
    source: 'reconciler',
    mutationType: 'full',
    startedAt,
    finishedAt: new Date(),
    inserts,
    updates,
    deletes,
    unchangedCount,
  });

  const total = inserts.length + updates.length + deletes.length;
  if (total === 0) {
    logger.info(
      `Reconciler heartbeat: no drift across ${unchangedCount} entities`,
    );
  } else {
    logger.info(
      `Reconciler recorded drift: ${inserts.length} insert(s), ${updates.length} update(s), ${deletes.length} delete(s); ${unchangedCount} unchanged`,
    );
  }
}
