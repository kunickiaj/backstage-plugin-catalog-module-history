import { CaptureSource, CycleInput } from './types';

/**
 * The provider name under which the reconciler records its drift cycles.
 */
export const RECONCILER_PROVIDER = 'reconciler';

export type CurrentEtag = {
  etag: string;
  provider: string;
};

export interface HistoryStore {
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
