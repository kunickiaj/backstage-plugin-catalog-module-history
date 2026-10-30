import { randomUUID } from 'node:crypto';
import type {
  LoggerService,
  RootConfigService,
} from '@backstage/backend-plugin-api';
import type { MetricsService } from '@backstage/backend-plugin-api/alpha';
import type {
  EntityProvider,
  EntityProviderConnection,
  EntityProviderMutation,
} from '@backstage/plugin-catalog-node';
import type {
  EntityRow,
  HistoryStore,
  ProviderMutationStore,
} from '@kunickiaj/backstage-plugin-catalog-history-node';
import { readHistoryLayers } from '../config/readHistoryLayers';
import { OrderedQueue } from './orderedQueue';
import { entityToRow } from '../mapping/entityToRow';
import { createCaptureMetrics } from '../telemetry/captureMetrics';

/** History items (waiting plus running) above which the wrapper warns. */
const HISTORY_BACKLOG_WARNING = 20;

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
  metrics?: MetricsService;
  /**
   * When true, full mutations with a history baseline are forwarded as deltas.
   * Every incoming deferred entry is forwarded unchanged; the catalog compares
   * its full entity content and location key. History refs are used only to
   * infer removals, never to filter incoming entries by entity etag.
   *
   * Off by default. Combine with {@link forceFullEvery} when you want a
   * periodic re-convergence safety valve.
   *
   * History records the original mutation type using its existing entity-etag
   * comparison. Its counts can differ from catalog changes. Conversion does not
   * avoid catalog comparisons for unchanged entries or provide deletion safety.
   */
  convertFullToDelta?: boolean;
  /**
   * When {@link convertFullToDelta} is on, this controls how often a real
   * full mutation is allowed through unchanged. Acts as a safety valve so
   * the catalog can periodically reconcile removals against its own provider
   * refs when history refs drift. The first full after this wrapper starts is
   * also forwarded unchanged, even when history already has a baseline.
   *
   * If unset, full mutations with a nonempty history baseline are converted.
   * An empty history baseline always forwards the full mutation as-is.
   */
  forceFullEvery?: ForceFullEveryDuration;
  /**
   * When false, the wrapper becomes a pure passthrough: mutations are
   * forwarded to the catalog untouched and nothing is recorded to history.
   * Lets consumers wire the flag from `catalog.history.provider.enabled`
   * at backend setup without needing config access inside the wrapper.
   *
   * Defaults to true.
   */
  enabled?: boolean;
};

/**
 * Wraps an EntityProvider so every applyMutation call is mirrored to a
 * HistoryStore. The inner provider's normal write to Backstage's catalog
 * succeeds before history is recorded. History failures are logged without
 * rejecting successful catalog ingestion.
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
 * Shared-store coordination spans baseline reads, catalog forwarding and
 * history commit for the provider. Local calls enter in arrival order.
 * Across instances, the store determines their order before forwarding.
 * Slow history delays later catalog writes for the same provider, including
 * when conversion is off. Different providers coordinate independently.
 * A store without the coordination capability receives no recordings, and
 * the original mutation is forwarded unchanged.
 *
 * When {@link HistoryRecordingEntityProviderOptions.convertFullToDelta} is
 * set, full mutations are converted to deltas before forwarding to the
 * catalog, using history refs to infer removals. Incoming entries are never
 * filtered by history etags, which cannot describe location-key-only changes
 * or every content change that the catalog detects. A converted full must
 * read its baseline before it forwards. The store must limit history work
 * and release coordination on failure. Coordination cannot fence an external
 * catalog call after the database connection is lost, or atomically commit
 * catalog and history changes.
 */
export class HistoryRecordingEntityProvider implements EntityProvider {
  private readonly inner: EntityProvider;
  private readonly store: HistoryStore;
  private readonly logger: LoggerService;
  private readonly convertFullToDelta: boolean;
  private readonly forceFullEveryMs?: number;
  private readonly enabled: boolean;
  private lastForwardedFullAt?: Date;
  private readonly captureMetrics;
  // Keep local arrival order while the store coordinates separate instances.
  private readonly history = new OrderedQueue();
  private backlogWarned = false;

  constructor(options: HistoryRecordingEntityProviderOptions) {
    this.inner = options.inner;
    this.store = options.store;
    this.logger = options.logger;
    this.captureMetrics = createCaptureMetrics('provider', options.metrics);
    this.enabled = options.enabled ?? true;
    this.convertFullToDelta = options.convertFullToDelta ?? false;
    this.forceFullEveryMs = options.forceFullEvery
      ? durationToMs(options.forceFullEvery)
      : undefined;
  }

  /**
   * Creates a wrapper whose recording follows the history configuration.
   *
   * Recording runs only when both `catalog.history.enabled` and
   * `catalog.history.provider.enabled` are on (both default to true).
   * Otherwise the wrapper is a passthrough that never calls the store, so a
   * lazily initialized store acquires no database client. Which providers to
   * wrap stays the caller's decision.
   */
  static fromConfig(
    config: RootConfigService,
    options: Omit<HistoryRecordingEntityProviderOptions, 'enabled'>,
  ): HistoryRecordingEntityProvider {
    return new HistoryRecordingEntityProvider({
      ...options,
      enabled: readHistoryLayers(config).provider,
    });
  }

  getProviderName(): string {
    return this.inner.getProviderName();
  }

  async connect(connection: EntityProviderConnection): Promise<void> {
    if (!this.enabled) {
      // Pure passthrough: hand the inner provider the raw connection so
      // this wrapper adds zero overhead when provider-layer capture is
      // disabled via config.
      await this.inner.connect(connection);
      return;
    }

    const wrapped: EntityProviderConnection = {
      applyMutation: async mutation => {
        const stopOperation =
          this.captureMetrics.startOperation('provider_mutation');
        let recorded = false;
        try {
          recorded = await this.enqueueHistory(() =>
            this.applyCoordinated(connection, mutation),
          );
        } finally {
          stopOperation(recorded ? 'success' : 'error');
        }
      },
      refresh: connection.refresh.bind(connection),
    };

    await this.inner.connect(wrapped);
  }

  private async applyCoordinated(
    connection: EntityProviderConnection,
    mutation: EntityProviderMutation,
  ): Promise<boolean> {
    let forwarded: Promise<void> | undefined;
    let phase = 'coordination';
    const forward = (target: EntityProviderMutation) => {
      forwarded ??= Promise.resolve()
        .then(() => connection.applyMutation(target))
        .then(() => {
          if (target.type === 'full') this.lastForwardedFullAt = new Date();
        });
      return forwarded;
    };
    try {
      if (!this.store.withProviderMutation) {
        throw new Error('History store does not support provider coordination');
      }
      return await this.store.withProviderMutation(
        this.getProviderName(),
        async store => {
          phase = 'baseline';
          const existing = await this.prepareMutation(store, mutation);
          phase = 'conversion';
          const target = existing
            ? this.maybeConvertToDelta(mutation, existing)
            : mutation;
          phase = 'forward';
          await forward(target);
          phase = 'record';
          await this.recordMutation(store, mutation, existing);
          return true;
        },
      );
    } catch (error) {
      // Preserve the catalog's original rejection even if transaction cleanup
      // fails. Never repeat a catalog write after a history or commit failure.
      if (forwarded) await forwarded;
      if (phase === 'conversion') throw error;
      this.logRecordingError(error, { baseline: phase === 'baseline' });
      if (!forwarded) await forward(mutation);
      return false;
    }
  }

  private async prepareMutation(
    store: ProviderMutationStore,
    mutation: EntityProviderMutation,
  ): Promise<Map<string, string> | undefined> {
    if (!this.convertFullToDelta || mutation.type !== 'full') return undefined;
    return store.loadCurrentEtags(this.getProviderName(), {
      source: 'provider',
    });
  }

  private enqueueHistory(work: () => Promise<boolean>): Promise<boolean> {
    const result = this.history.run(work);
    this.warnIfHistoryBacklogged();
    return result;
  }

  private warnIfHistoryBacklogged(): void {
    const backlog = this.history.size;
    // Re-arm only once the backlog has drained, so a backlog hovering near
    // the threshold does not repeat the warning.
    if (backlog <= 1) this.backlogWarned = false;
    if (backlog <= HISTORY_BACKLOG_WARNING || this.backlogWarned) return;
    this.backlogWarned = true;
    this.logger.warn(
      `History recording for provider ${this.getProviderName()} is ${backlog} mutations behind. Catalog writes for this provider wait for earlier history recordings.`,
    );
  }

  private logRecordingError(
    error: unknown,
    options: { baseline: boolean },
  ): void {
    this.logger.error(
      options.baseline
        ? `Failed to read history etags for provider ${this.getProviderName()}; forwarding mutation unchanged and skipping recording`
        : `Failed to record history cycle for provider ${this.getProviderName()}`,
      error instanceof Error ? error : { error: String(error) },
    );
  }

  private maybeConvertToDelta(
    mutation: EntityProviderMutation,
    existing: Map<string, string>,
  ): EntityProviderMutation {
    if (!this.convertFullToDelta || mutation.type !== 'full') return mutation;
    if (existing.size === 0) return mutation; // first run, no baseline
    if (this.shouldForceFull()) return mutation;

    const incomingRefs = new Set<string>();
    for (const entry of mutation.entities) {
      const row = entityToRow(entry.entity);
      incomingRefs.add(row.entityRef);
    }
    const removed: Array<{ entityRef: string }> = [];
    for (const ref of existing.keys()) {
      if (!incomingRefs.has(ref)) removed.push({ entityRef: ref });
    }
    return { type: 'delta', added: mutation.entities, removed };
  }

  private shouldForceFull(): boolean {
    if (this.forceFullEveryMs === undefined) return false;
    if (!this.lastForwardedFullAt) return true;
    return (
      Date.now() - this.lastForwardedFullAt.getTime() >= this.forceFullEveryMs
    );
  }

  private async recordMutation(
    store: ProviderMutationStore,
    mutation: EntityProviderMutation,
    preloadedEtags?: Map<string, string>,
  ): Promise<void> {
    const provider = this.getProviderName();
    let existing = preloadedEtags;
    if (!existing) {
      existing = await store.loadCurrentEtags(provider, { source: 'provider' });
    }

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

    await store.recordCycle({
      cycleId: randomUUID(),
      provider,
      source: 'provider',
      mutationType: mutation.type,
      startedAt: new Date(),
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
