import { CaptureSource, CycleInput } from './types';

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
 * Write-side contract for catalog history storage backends.
 *
 * @public
 */
export interface HistoryStore {
  /**
   * Prepares the backing store for reads and writes.
   *
   * Implementations that need schema bootstrap or other startup work should
   * perform it here. Implementations that are always ready can omit this
   * method. Callers should treat it as idempotent.
   */
  ensureReady?(): Promise<void>;

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
}
