import { randomUUID } from 'node:crypto';
import { LoggerService } from '@backstage/backend-plugin-api';
import type { MetricsService } from '@backstage/backend-plugin-api/alpha';
import {
  EntityProvider,
  EntityProviderConnection,
  EntityProviderMutation,
} from '@backstage/plugin-catalog-node';
import {
  EntityRow,
  HistoryStore,
} from '@kunickiaj/backstage-plugin-catalog-history-node';
import { entityToRow } from '../mapping/entityToRow';
import { createCaptureMetrics } from '../telemetry/captureMetrics';

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
 * catalog, using history refs to infer removals. Incoming entries are never
 * filtered by history etags, which cannot describe location-key-only changes
 * or every content change that the catalog detects.
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
        let operationOutcome: 'success' | 'error' = 'error';
        try {
          // Forward-first failure isolation: only the conversion path needs
          // to preload etags before the catalog write, because it has to know
          // what to forward. The default passthrough path keeps its original
          // behavior — forward to the catalog first, then try to record —
          // so a slow or unavailable history store never delays catalog
          // updates.
          const needsConversion =
            this.convertFullToDelta && mutation.type === 'full';
          if (!needsConversion) {
            const stopForward = this.captureMetrics.startPhase('forward');
            let forwarded = false;
            try {
              await connection.applyMutation(mutation);
              forwarded = true;
            } finally {
              stopForward(forwarded ? 'success' : 'error');
            }
            try {
              await this.recordMutation(mutation);
              operationOutcome = 'success';
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
            const stopBaseline = this.captureMetrics.startPhase('baseline');
            let loaded = false;
            try {
              existing = await this.store.loadCurrentEtags(
                this.getProviderName(),
              );
              loaded = true;
            } finally {
              stopBaseline(loaded ? 'success' : 'error');
            }
          } catch (err) {
            // Etag read failed and we need it to convert. Fall back to
            // forwarding the original full unchanged so the catalog hot path
            // is preserved, and skip recording for this cycle.
            this.logger.error(
              `Failed to read history etags for provider ${this.getProviderName()}; forwarding mutation unchanged and skipping recording`,
              err instanceof Error ? err : { error: String(err) },
            );
            const stopForward = this.captureMetrics.startPhase('forward');
            let forwarded = false;
            try {
              await connection.applyMutation(mutation);
              forwarded = true;
            } finally {
              stopForward(forwarded ? 'success' : 'error');
            }
            this.lastForwardedFullAt = new Date();
            return;
          }

          const stopPrepare = this.captureMetrics.startPhase('prepare');
          let prepared = false;
          let forwarded: EntityProviderMutation;
          try {
            forwarded = this.maybeConvertToDelta(mutation, existing);
            prepared = true;
          } finally {
            stopPrepare(prepared ? 'success' : 'error');
          }
          const stopForward = this.captureMetrics.startPhase('forward');
          let applied = false;
          try {
            await connection.applyMutation(forwarded);
            applied = true;
          } finally {
            stopForward(applied ? 'success' : 'error');
          }

          if (forwarded.type === 'full') {
            this.lastForwardedFullAt = new Date();
          }

          try {
            await this.recordMutation(mutation, existing);
            operationOutcome = 'success';
          } catch (err) {
            this.logger.error(
              `Failed to record history cycle for provider ${this.getProviderName()}`,
              err instanceof Error ? err : { error: String(err) },
            );
          }
        } finally {
          stopOperation(operationOutcome);
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
    mutation: EntityProviderMutation,
    preloadedEtags?: Map<string, string>,
  ): Promise<void> {
    const provider = this.getProviderName();
    const startedAt = new Date();
    let existing = preloadedEtags;
    if (!existing) {
      const stopBaseline = this.captureMetrics.startPhase('baseline');
      let loaded = false;
      try {
        existing = await this.store.loadCurrentEtags(provider);
        loaded = true;
      } finally {
        stopBaseline(loaded ? 'success' : 'error');
      }
    }

    const inserts: EntityRow[] = [];
    const updates: EntityRow[] = [];
    let unchangedCount = 0;
    let deletes: string[] = [];

    const stopPrepare = this.captureMetrics.startPhase('prepare');
    let prepared = false;
    try {
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

      prepared = true;
    } finally {
      stopPrepare(prepared ? 'success' : 'error');
    }

    const stopRecord = this.captureMetrics.startPhase('record');
    let recorded = false;
    try {
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
      recorded = true;
    } finally {
      stopRecord(recorded ? 'success' : 'error');
    }
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
