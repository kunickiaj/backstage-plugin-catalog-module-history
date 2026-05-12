import { randomUUID } from 'node:crypto';
import { LoggerService } from '@backstage/backend-plugin-api';
import {
  EntityProvider,
  EntityProviderConnection,
  EntityProviderMutation,
} from '@backstage/plugin-catalog-node';
import { HistoryStore } from '../store/HistoryStore';
import { EntityRow } from '../store/types';
import { entityToRow } from '../mapping/entityToRow';

export type HistoryRecordingEntityProviderOptions = {
  inner: EntityProvider;
  store: HistoryStore;
  logger: LoggerService;
};

/**
 * Wraps an EntityProvider so every applyMutation call is mirrored to a
 * HistoryStore. The inner provider's normal write to Backstage's catalog
 * happens first and is unaffected by store failures; history recording is
 * best-effort and its errors are swallowed (the reconciler is the safety
 * net).
 *
 * Only `full` mutations are recorded in v1. `delta` mutations log a warning
 * and are skipped; coalescing them into cycles is deferred to v2.
 */
export class HistoryRecordingEntityProvider implements EntityProvider {
  private readonly inner: EntityProvider;
  private readonly store: HistoryStore;
  private readonly logger: LoggerService;

  constructor(options: HistoryRecordingEntityProviderOptions) {
    this.inner = options.inner;
    this.store = options.store;
    this.logger = options.logger;
  }

  getProviderName(): string {
    return this.inner.getProviderName();
  }

  async connect(connection: EntityProviderConnection): Promise<void> {
    const wrapped: EntityProviderConnection = {
      applyMutation: async mutation => {
        await connection.applyMutation(mutation);
        try {
          await this.recordMutation(mutation);
        } catch (err) {
          this.logger.error(
            `Failed to record history cycle for provider ${this.getProviderName()}`,
            err instanceof Error ? err : { error: String(err) },
          );
        }
      },
      refresh: connection.refresh.bind(connection),
    };

    await this.inner.connect(wrapped);
  }

  private async recordMutation(
    mutation: EntityProviderMutation,
  ): Promise<void> {
    if (mutation.type !== 'full') {
      this.logger.warn(
        `Delta mutations are not recorded in v1; skipping for provider ${this.getProviderName()}`,
      );
      return;
    }

    const provider = this.getProviderName();
    const startedAt = new Date();
    const rows: EntityRow[] = mutation.entities.map(({ entity }) =>
      entityToRow(entity),
    );

    const existing = await this.store.loadCurrentEtags(provider);

    const inserts: EntityRow[] = [];
    const updates: EntityRow[] = [];
    let unchangedCount = 0;
    const incomingRefs = new Set<string>();

    for (const row of rows) {
      incomingRefs.add(row.entityRef);
      const prev = existing.get(row.entityRef);
      if (prev === undefined) {
        inserts.push(row);
      } else if (prev !== row.etag) {
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

    await this.store.recordCycle({
      cycleId: randomUUID(),
      provider,
      mutationType: 'full',
      startedAt,
      finishedAt: new Date(),
      inserts,
      updates,
      deletes,
      unchangedCount,
    });
  }
}
