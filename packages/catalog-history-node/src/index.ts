/**
 * Backend-only contracts and service refs for the Backstage catalog history
 * plugin family.
 *
 * @packageDocumentation
 */

export type {
  CaptureSource,
  CycleInput,
  EntityRow,
  MutationType,
} from './store/types';
export type {
  CurrentEtag,
  HistoryRetentionCounts,
  HistoryRetentionRequest,
  HistoryStore,
} from './store/HistoryStore';
export {
  HistoryRetentionAbortedError,
  RECONCILER_PROVIDER,
} from './store/HistoryStore';
export type { HistoryQueryService } from './query/HistoryQueryService';
export { historyStoreServiceRef } from './service/historyStoreServiceRef';
