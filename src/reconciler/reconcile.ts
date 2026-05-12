import { randomUUID } from 'node:crypto';
import { LoggerService } from '@backstage/backend-plugin-api';
import { HistoryStore, RECONCILER_PROVIDER } from '../store/HistoryStore';
import { EntityRow } from '../store/types';
import { entityToRow } from '../mapping/entityToRow';
import { EntityFetcher } from './EntityFetcher';

export type ReconcileOptions = {
  fetcher: EntityFetcher;
  store: HistoryStore;
  logger: LoggerService;
};

/**
 * Snapshots the catalog via the EntityFetcher, diffs it against the union
 * of all per-provider current etags from the HistoryStore, and records a
 * single cycle attributed to provider='reconciler' summarizing the drift.
 *
 * Records a heartbeat cycle (no row changes) when the catalog and the
 * history agree, so an operator can tell from the cycles table that the
 * reconciler is running on schedule.
 */
export async function reconcile(opts: ReconcileOptions): Promise<void> {
  const { fetcher, store, logger } = opts;
  const startedAt = new Date();

  const entities = await fetcher.getEntities();
  const rows: EntityRow[] = entities.map(entity => entityToRow(entity));
  const incomingRefs = new Set(rows.map(r => r.entityRef));

  const existing = await store.loadAllCurrentEtags();

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
