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
 * best-effort and its errors are swallowed.
 *
 * Both `full` and `delta` mutations are recorded, one cycle per
 * applyMutation call. `delta` mutations record the explicit added/removed
 * lists; full mutations additionally infer deletes for refs present in
 * history but missing from the incoming entity set.
 *
 * Bursty delta coalescing (debounce a burst of webhook events into one
 * cycle) is deferred to a later phase; today every applyMutation
 * invocation produces its own cycle.
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
    const provider = this.getProviderName();
    const startedAt = new Date();
    const existing = await this.store.loadCurrentEtags(provider);

    const inserts: EntityRow[] = [];
    const updates: EntityRow[] = [];
    let unchangedCount = 0;
    let deletes: string[] = [];

    if (mutation.type === 'full') {
      const incomingRefs = new Set<string>();
      for (const { entity } of mutation.entities) {
        const row = entityToRow(entity);
        incomingRefs.add(row.entityRef);
        const prev = existing.get(row.entityRef);
        if (prev === undefined) inserts.push(row);
        else if (prev !== row.etag) updates.push(row);
        else unchangedCount++;
      }
      // Full mutations imply deletes for any ref the provider previously
      // emitted but is now silent on.
      for (const ref of existing.keys()) {
        if (!incomingRefs.has(ref)) deletes.push(ref);
      }
    } else {
      for (const { entity } of mutation.added) {
        const row = entityToRow(entity);
        const prev = existing.get(row.entityRef);
        if (prev === undefined) inserts.push(row);
        else if (prev !== row.etag) updates.push(row);
        else unchangedCount++;
      }
      // Delta mutations carry the explicit removal list. Each entry is
      // either { entityRef } or { entity }; normalize to the canonical
      // lowercase ref that the rest of the module uses, so a delete for
      // `User:Default/Bob` matches the previously-recorded
      // `user:default/bob` key in the history table.
      deletes = mutation.removed.map(r =>
        'entityRef' in r
          ? r.entityRef.toLowerCase()
          : entityToRow(r.entity).entityRef,
      );
    }

    await this.store.recordCycle({
      cycleId: randomUUID(),
      provider,
      mutationType: mutation.type,
      startedAt,
      finishedAt: new Date(),
      inserts,
      updates,
      deletes,
      unchangedCount,
    });
  }
}
