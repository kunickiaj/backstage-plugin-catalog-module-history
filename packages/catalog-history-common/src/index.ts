/**
 * Frontend/backend-safe types and API contracts for the Backstage catalog
 * history plugin family.
 *
 * @packageDocumentation
 */

export {
  HISTORY_SOURCES,
  HISTORY_OPERATIONS,
  HISTORY_MUTATION_TYPES,
  isHistorySource,
  isHistoryOperation,
  isHistoryMutationType,
} from './types';
export type {
  HistorySource,
  HistoryOperation,
  HistoryMutationType,
} from './types';

export { DEFAULT_HISTORY_PAGE_LIMIT, MAX_HISTORY_PAGE_LIMIT } from './api';
export type {
  HistoryPageCursor,
  HistoryPage,
  HistoryPageOptions,
  HistoryChangeFilter,
  HistoryTimelineItem,
  HistoryCycleCounts,
  HistoryCycle,
} from './api';
