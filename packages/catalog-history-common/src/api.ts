/**
 * API DTOs and pagination contracts for the catalog history query API.
 *
 * These shapes are shared between the backend query service/router and the
 * frontend plugin API client. They intentionally avoid any backend-only
 * dependencies.
 *
 * Diff request/response contracts are intentionally not defined yet; they
 * will be added together with the diff endpoint implementation so the
 * published shapes are validated by real code.
 */
import type {
  HistoryMutationType,
  HistoryOperation,
  HistorySource,
} from './types';

/**
 * Default page size applied by history list endpoints when the caller does
 * not specify a limit.
 *
 * @public
 */
export const DEFAULT_HISTORY_PAGE_LIMIT = 25;

/**
 * Maximum page size accepted by history list endpoints. Limits above this
 * value are clamped to it by the backend.
 *
 * @public
 */
export const MAX_HISTORY_PAGE_LIMIT = 100;

/**
 * Opaque pagination cursor returned by history list endpoints.
 *
 * Callers must treat this value as opaque; its encoding may change between
 * releases.
 *
 * @public
 */
export type HistoryPageCursor = string;

/**
 * One page of results from a cursor-paginated history endpoint.
 *
 * @public
 */
export interface HistoryPage<TItem> {
  items: TItem[];
  /**
   * Cursor for fetching the next page, or undefined when this is the last
   * page.
   */
  nextCursor?: HistoryPageCursor;
}

/**
 * Common pagination options accepted by history list endpoints.
 *
 * @public
 */
export interface HistoryPageOptions {
  /**
   * Maximum items to return; values above {@link MAX_HISTORY_PAGE_LIMIT} are
   * clamped.
   */
  limit?: number;
  /** Opaque cursor from a previous {@link HistoryPage.nextCursor}. */
  cursor?: HistoryPageCursor;
}

/**
 * Filters accepted by entity timeline and change-feed endpoints.
 *
 * @public
 */
export interface HistoryChangeFilter {
  /** Canonical lowercase entity ref, e.g. `component:default/example`. */
  entityRef?: string;
  /** Entity kind, e.g. `Component`. */
  kind?: string;
  source?: HistorySource;
  provider?: string;
  op?: HistoryOperation;
  /** ISO 8601 timestamp; only include changes at or after this instant. */
  changedAfter?: string;
  /** ISO 8601 timestamp; only include changes at or before this instant. */
  changedBefore?: string;
}

/**
 * One entry in an entity history timeline.
 *
 * @public
 */
export interface HistoryTimelineItem {
  /** Stable identifier of the history row. */
  id: string;
  /** Identifier of the cycle that recorded this change. */
  cycleId: string;
  /** Canonical lowercase entity ref, e.g. `component:default/example`. */
  entityRef: string;
  source: HistorySource;
  /**
   * Entity provider name for provider-source rows; `processing` or
   * `reconciler` for cycles owned by those capture layers.
   */
  provider: string;
  op: HistoryOperation;
  /** ISO 8601 timestamp of when the change was recorded. */
  changedAt: string;
  etag?: string;
}

/**
 * Aggregate counts recorded for one history cycle.
 *
 * Field names use the same verb vocabulary as {@link HistoryOperation}:
 * `insert` operations tally into `inserted`, and so on.
 *
 * @public
 */
export interface HistoryCycleCounts {
  inserted: number;
  updated: number;
  deleted: number;
  unchanged: number;
}

/**
 * One recorded history cycle.
 *
 * @public
 */
export interface HistoryCycle {
  cycleId: string;
  /**
   * Entity provider name for provider-source cycles; `processing` or
   * `reconciler` for cycles owned by those capture layers.
   */
  provider: string;
  source: HistorySource;
  mutationType: HistoryMutationType;
  /** ISO 8601 timestamp. */
  startedAt: string;
  /** ISO 8601 timestamp. */
  finishedAt: string;
  counts: HistoryCycleCounts;
}
