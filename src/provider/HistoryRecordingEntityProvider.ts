import { randomUUID } from 'node:crypto';
import { LoggerService } from '@backstage/backend-plugin-api';
import { Entity } from '@backstage/catalog-model';
import {
  EntityProvider,
  EntityProviderConnection,
  EntityProviderMutation,
} from '@backstage/plugin-catalog-node';
import { HistoryStore } from '../store/HistoryStore';
import { EntityRow } from '../store/types';
import { entityToRow } from '../mapping/entityToRow';

export type ForceFullEveryDuration = {
  days?: number;
  hours?: number;
  minutes?: number;
  seconds?: number;
};

export type HistoryRecordingEntityProviderOptions = {
  inner: EntityProvider;
  store: HistoryStore;
  logger: LoggerService;
  /**
   * When true, full mutations from the inner provider are diffed against the
   * history table and forwarded to the catalog as delta mutations instead.
   * Lets full-snapshot providers act as incremental from the catalog's
   * perspective, so the catalog's own scan-and-diff sweep is skipped.
   *
   * Off by default. Combine with {@link forceFullEvery} when you want a
   * periodic re-convergence safety valve.
   *
   * The cycle recorded in history always reflects the mutation the provider
   * actually emitted (audit-honest), regardless of what was forwarded to the
   * catalog.
   */
  convertFullToDelta?: boolean;
  /**
   * When {@link convertFullToDelta} is on, this controls how often a real
   * full mutation is allowed through unchanged. Acts as a safety valve so
   * the catalog can occasionally re-converge against the provider's full
   * snapshot in case our history etags drift.
   *
   * If unset, every full past the first is converted. The first full for a
   * provider is always forwarded as-is because there is no etag baseline.
   */
  forceFullEvery?: ForceFullEveryDuration;
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
 *
 * When {@link HistoryRecordingEntityProviderOptions.convertFullToDelta} is
 * set, full mutations are converted to deltas before forwarding to the
 * catalog, using the history etag table as the diff baseline.
 */
export class HistoryRecordingEntityProvider implements EntityProvider {
  private readonly inner: EntityProvider;
  private readonly store: HistoryStore;
  private readonly logger: LoggerService;
  private readonly convertFullToDelta: boolean;
  private readonly forceFullEveryMs?: number;
  private lastForwardedFullAt?: Date;

  constructor(options: HistoryRecordingEntityProviderOptions) {
    this.inner = options.inner;
    this.store = options.store;
    this.logger = options.logger;
    this.convertFullToDelta = options.convertFullToDelta ?? false;
    this.forceFullEveryMs = options.forceFullEvery
      ? durationToMs(options.forceFullEvery)
      : undefined;
  }

  getProviderName(): string {
    return this.inner.getProviderName();
  }

  async connect(connection: EntityProviderConnection): Promise<void> {
    const wrapped: EntityProviderConnection = {
      applyMutation: async mutation => {
        // Forward-first failure isolation: only the conversion path needs
        // to preload etags before the catalog write, because it has to know
        // what to forward. The default passthrough path keeps its original
        // behavior — forward to the catalog first, then try to record —
        // so a slow or unavailable history store never delays catalog
        // updates.
        const needsConversion =
          this.convertFullToDelta && mutation.type === 'full';
        if (!needsConversion) {
          await connection.applyMutation(mutation);
          try {
            await this.recordMutation(mutation);
          } catch (err) {
            this.logger.error(
              `Failed to record history cycle for provider ${this.getProviderName()}`,
              err instanceof Error ? err : { error: String(err) },
            );
          }
          return;
        }

        let existing: Map<string, string>;
        try {
          existing = await this.store.loadCurrentEtags(this.getProviderName());
        } catch (err) {
          // Etag read failed and we need it to convert. Fall back to
          // forwarding the original full unchanged so the catalog hot path
          // is preserved, and skip recording for this cycle.
          this.logger.error(
            `Failed to read history etags for provider ${this.getProviderName()}; forwarding mutation unchanged and skipping recording`,
            err instanceof Error ? err : { error: String(err) },
          );
          await connection.applyMutation(mutation);
          return;
        }

        const forwarded = this.maybeConvertToDelta(mutation, existing);
        await connection.applyMutation(forwarded);

        if (forwarded.type === 'full') {
          this.lastForwardedFullAt = new Date();
        }

        try {
          await this.recordMutation(mutation, existing);
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

  private maybeConvertToDelta(
    mutation: EntityProviderMutation,
    existing: Map<string, string>,
  ): EntityProviderMutation {
    if (!this.convertFullToDelta || mutation.type !== 'full') return mutation;
    if (existing.size === 0) return mutation; // first run, no baseline
    if (this.shouldForceFull()) return mutation;

    const added: Array<{ entity: Entity }> = [];
    const incomingRefs = new Set<string>();
    for (const { entity } of mutation.entities) {
      const row = entityToRow(entity);
      incomingRefs.add(row.entityRef);
      const prev = existing.get(row.entityRef);
      if (prev === undefined || prev !== row.etag) {
        added.push({ entity });
      }
    }
    const removed: Array<{ entityRef: string }> = [];
    for (const ref of existing.keys()) {
      if (!incomingRefs.has(ref)) removed.push({ entityRef: ref });
    }
    return { type: 'delta', added, removed };
  }

  private shouldForceFull(): boolean {
    if (this.forceFullEveryMs === undefined) return false;
    if (!this.lastForwardedFullAt) return false;
    return (
      Date.now() - this.lastForwardedFullAt.getTime() >= this.forceFullEveryMs
    );
  }

  private async recordMutation(
    mutation: EntityProviderMutation,
    preloadedEtags?: Map<string, string>,
  ): Promise<void> {
    const provider = this.getProviderName();
    const startedAt = new Date();
    const existing =
      preloadedEtags ?? (await this.store.loadCurrentEtags(provider));

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
      source: 'provider',
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

function durationToMs(d: ForceFullEveryDuration): number {
  return (
    (d.days ?? 0) * 86_400_000 +
    (d.hours ?? 0) * 3_600_000 +
    (d.minutes ?? 0) * 60_000 +
    (d.seconds ?? 0) * 1_000
  );
}
