import { CycleInput } from './types';

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
  loadCurrentEtags(provider: string): Promise<Map<string, string>>;

  /**
   * Returns the latest non-delete etag per entity_ref across all providers.
   * When the same entity_ref has been recorded by multiple providers, the
   * globally most recent row wins. Used by the reconciler to detect drift
   * regardless of which provider originally claimed the entity.
   */
  loadAllCurrentEtags(): Promise<Map<string, CurrentEtag>>;

  recordCycle(input: CycleInput): Promise<void>;
}
