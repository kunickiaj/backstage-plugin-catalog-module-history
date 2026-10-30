import type { CaptureSource, CycleInput } from './types';
import type { HistoryQueryService } from '../query/HistoryQueryService';

/**
 * The provider name under which the reconciler records its drift cycles.
 *
 * @public
 */
export const RECONCILER_PROVIDER = 'reconciler';

/**
 * The latest etag recorded for an entity, along with the provider that
 * recorded it.
 *
 * @public
 */
export type CurrentEtag = {
  etag: string;
  provider: string;
};

/**
 * Reads and recording available only during a provider mutation callback.
 * Both methods are restricted to the selected provider and source `provider`.
 *
 * @public
 */
export type ProviderMutationStore = Pick<
  HistoryStore,
  'loadCurrentEtags' | 'recordCycle'
>;

/**
 * Selects history eligible for retention removal.
 *
 * @public
 */
export type HistoryRetentionRequest = {
  /** Rows and cycles recorded before this instant may be removed. */
  cutoff: Date;
};

/**
 * Rows and cycles that retention removes, or would remove, for one cutoff.
 *
 * Retention never removes the newest row of an entity's capture stream
 * (entity ref, source, and provider) unless every stream of that entity ends
 * in a delete recorded before the cutoff.
 *
 * @public
 */
export type HistoryRetentionCounts = {
  /** Rows of entities whose every capture stream ended in a delete before the cutoff. */
  deletedEntityRows: number;
  /** Older rows superseded by a newer row in the same capture stream. */
  supersededRows: number;
  /** Cycles that finished before the cutoff and have no remaining rows. */
  emptyCycles: number;
};

/**
 * Rejection from {@link HistoryStore.applyRetention} when its signal aborts.
 * Batches committed before the abort stay removed.
 *
 * @public
 */
export class HistoryRetentionAbortedError extends Error {
  readonly name = 'HistoryRetentionAbortedError';

  constructor(
    readonly counts: HistoryRetentionCounts,
    options?: { cause?: unknown },
  ) {
    super('History retention stopped before it finished', options);
  }
}

/**
 * Write-side contract for catalog history storage backends.
 *
 * @public
 */
export interface HistoryStore {
  /** Optional reads backed by the same storage as this recorder. */
  readonly query?: Pick<
    HistoryQueryService,
    'getEntityTimeline' | 'getEntityVersions' | 'getEntityVersion'
  > &
    Partial<
      Pick<
        HistoryQueryService,
        | 'getChangeFeed'
        | 'getProviders'
        | 'getEntities'
        | 'getKinds'
        | 'listCycles'
        | 'getCycle'
        | 'getEntityAsOf'
        | 'getEntityDiff'
      >
    >;

  /**
   * Prepares the backing store for reads and writes.
   *
   * Implementations that need schema bootstrap or other startup work should
   * perform it here. Implementations that are always ready can omit this
   * method. Callers should treat it as idempotent.
   */
  ensureReady?(): Promise<void>;

  /**
   * Serializes baseline reads, catalog forwarding, and history commit across
   * cooperating writers for one provider. The callback must await its store
   * calls and record exactly one cycle. Its scoped store expires when it ends.
   * Implementations assign ordered storage timestamps and never retry `work`.
   * Callback failures propagate unchanged. Exclusion cannot fence an external
   * catalog call if the storage session is lost during that call.
   */
  withProviderMutation?<T>(
    provider: string,
    work: (store: ProviderMutationStore) => Promise<T>,
  ): Promise<T>;

  /**
   * Registers work that must complete before the backing store is shut down.
   *
   * Implementations that own their database connection should run these hooks
   * before closing that connection. This is primarily used by buffered capture
   * layers that need to flush before a self-managed pool is destroyed.
   */
  addShutdownHook?(hook: () => Promise<void>): void;

  /**
   * Flushes registered shutdown hooks and releases store-owned resources.
   *
   * Implementations that use Backstage-managed services may only need to run
   * registered hooks. Callers should treat it as idempotent.
   */
  shutdown?(): Promise<void>;

  /**
   * Returns the latest non-delete etag per entity_ref recorded for the
   * given provider.
   */
  loadCurrentEtags(
    provider: string,
    opts?: { source?: CaptureSource },
  ): Promise<Map<string, string>>;

  /**
   * Returns the latest non-delete etag per entity_ref across all providers.
   * When the same entity_ref has been recorded by multiple providers, the
   * most recent row within the queried scope wins.
   *
   * Callers comparing etags should scope with `opts.source`: etags from
   * different capture layers are computed over different content and are
   * not comparable (the reconciler passes `{ source: 'reconciler' }` for
   * exactly this reason). The unscoped union is only meaningful for
   * queries that don't compare etag values across sources.
   */
  loadAllCurrentEtags(opts?: {
    source?: CaptureSource;
  }): Promise<Map<string, CurrentEtag>>;

  recordCycle(input: CycleInput): Promise<void>;

  /**
   * Counts what {@link HistoryStore.applyRetention} would remove for the same
   * cutoff, without changing data. Optional; scheduled retention requires it.
   */
  planRetention?(
    request: HistoryRetentionRequest,
  ): Promise<HistoryRetentionCounts>;

  /**
   * Removes history older than the cutoff in short batched transactions and
   * returns what was removed. Stops between batches when `signal` aborts and
   * rejects with {@link HistoryRetentionAbortedError}, whose `counts` report
   * what committed batches removed before the abort.
   * Optional; scheduled retention requires it.
   */
  applyRetention?(
    request: HistoryRetentionRequest & {
      /** Maximum rows or cycles removed per transaction. */
      batchSize: number;
      signal?: AbortSignal;
    },
  ): Promise<HistoryRetentionCounts>;
}
