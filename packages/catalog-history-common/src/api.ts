/**
 * API DTOs and pagination contracts for the catalog history query API.
 *
 * These shapes are shared between the backend query service/router and the
 * frontend plugin API client. They intentionally avoid any backend-only
 * dependencies.
 *
 */
import type {
  HistoryMutationType,
  HistoryOperation,
  HistorySource,
} from './types';

/**
 * JSON value carried by history API DTOs.
 *
 * @public
 */
export type HistoryJsonValue =
  | string
  | number
  | boolean
  | null
  | HistoryJsonValue[]
  | { [key: string]: HistoryJsonValue };

/**
 * JSON object carried by entity payload fields such as metadata and spec.
 *
 * @public
 */
export type HistoryJsonObject = { [key: string]: HistoryJsonValue };

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
   * clamped. Backends should reject non-positive or non-integer values.
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
  /** Owner entity ref, e.g. `group:default/platform`. */
  owner?: string;
  source?: HistorySource;
  provider?: string;
  op?: HistoryOperation;
  /** ISO 8601 timestamp; only include changes at or after this instant. */
  changedAfter?: string;
  /** ISO 8601 timestamp; only include changes at or before this instant. */
  changedBefore?: string;
}

/**
 * Filters accepted by cycle-list endpoints.
 *
 * @public
 */
export interface HistoryCycleFilter {
  source?: HistorySource;
  provider?: string;
  /** Only include cycles that contain at least one change with this operation. */
  op?: HistoryOperation;
  mutationType?: HistoryMutationType;
  /** ISO 8601 timestamp; only include cycles starting at or after this instant. */
  startedAfter?: string;
  /** ISO 8601 timestamp; only include cycles starting at or before this instant. */
  startedBefore?: string;
  /** ISO 8601 timestamp; only include cycles finishing at or after this instant. */
  finishedAfter?: string;
  /** ISO 8601 timestamp; only include cycles finishing at or before this instant. */
  finishedBefore?: string;
}

/**
 * Entity identity fields repeated across API responses.
 *
 * @public
 */
export interface HistoryEntityIdentity {
  /** Canonical lowercase entity ref, e.g. `component:default/example`. */
  entityRef: string;
  /** Entity kind, e.g. `Component`. */
  kind: string;
  namespace: string;
  name: string;
}

/**
 * Entity payload captured in one history row.
 *
 * @public
 */
export interface HistoryEntitySnapshot extends HistoryEntityIdentity {
  etag?: string;
  displayName?: string;
  email?: string;
  parent?: string;
  memberOf?: string[];
  owner?: string;
  metadata?: HistoryJsonObject;
  spec?: HistoryJsonObject;
  relations?: HistoryJsonObject[];
  statusItems?: HistoryJsonObject[];
  orphan?: boolean;
}

/**
 * High-level change flags for timeline badges and filter UIs.
 *
 * These fields summarize common catalog changes without requiring clients to
 * fetch or compute a full structured diff for every timeline row.
 *
 * @public
 */
export interface HistoryTimelineSummary {
  ownerChanged?: boolean;
  relationsChanged?: boolean;
  statusChanged?: boolean;
  orphanChanged?: boolean;
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
  summary: HistoryTimelineSummary;
}

/**
 * Timeline request options for one entity.
 *
 * @public
 */
export interface HistoryEntityTimelineRequest
  extends HistoryPageOptions, Omit<HistoryChangeFilter, 'entityRef' | 'kind'> {
  entityRef: string;
}

/**
 * Timeline response for one entity.
 *
 * @public
 */
export type HistoryEntityTimelineResponse = HistoryPage<HistoryTimelineItem>;

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

/**
 * Cycle list request options.
 *
 * @public
 */
export interface HistoryCycleListRequest
  extends HistoryPageOptions, HistoryCycleFilter {}

/**
 * Cycle list response.
 *
 * @public
 */
export type HistoryCycleListResponse = HistoryPage<HistoryCycle>;

/**
 * One entity change included in a cycle detail response.
 *
 * @public
 */
export interface HistoryCycleChange
  extends HistoryTimelineItem, HistoryEntityIdentity {}

/**
 * Cycle detail request options. The cycle metadata is returned with a page of
 * changed entities; use `cursor` to fetch additional changed-entity pages for
 * large cycles.
 *
 * @public
 */
export interface HistoryCycleDetailRequest extends HistoryPageOptions {
  cycleId: string;
}

/**
 * Cycle detail response including changed entities.
 *
 * @public
 */
export interface HistoryCycleDetailResponse {
  cycle: HistoryCycle;
  changes: HistoryPage<HistoryCycleChange>;
}

/**
 * Cross-entity change-feed request options.
 *
 * @public
 */
export interface HistoryChangeFeedRequest
  extends HistoryPageOptions, HistoryChangeFilter {}

/**
 * Cross-entity change-feed response.
 *
 * @public
 */
export type HistoryChangeFeedResponse = HistoryPage<HistoryCycleChange>;

/**
 * Distinct persisted version of one entity.
 *
 * @public
 */
export interface HistoryEntityVersion extends HistoryTimelineItem {
  snapshot?: HistoryEntitySnapshot;
}

/**
 * Entity version request options.
 *
 * @public
 */
export interface HistoryEntityVersionsRequest
  extends
    HistoryPageOptions,
    Omit<HistoryChangeFilter, 'entityRef' | 'kind' | 'op'> {
  entityRef: string;
}

/**
 * Entity version response.
 *
 * @public
 */
export type HistoryEntityVersionsResponse = HistoryPage<HistoryEntityVersion>;

/**
 * Entity as-of request options.
 *
 * @public
 */
export interface HistoryEntityAsOfRequest {
  entityRef: string;
  /** ISO 8601 timestamp. */
  timestamp: string;
  source?: HistorySource;
  provider?: string;
}

/**
 * Entity state as of a timestamp.
 *
 * @public
 */
export interface HistoryEntityAsOfResponse {
  entityRef: string;
  asOf: string;
  version?: HistoryEntityVersion;
  snapshot?: HistoryEntitySnapshot;
}

/**
 * Reference to a history version, cycle, or timestamp used by diff requests.
 *
 * @public
 */
export type HistoryDiffTarget =
  | { kind: 'history-row'; id: string }
  | { kind: 'cycle'; cycleId: string }
  | { kind: 'timestamp'; timestamp: string };

/**
 * Diff request for one entity.
 *
 * @public
 */
export interface HistoryEntityDiffRequest {
  entityRef: string;
  from: HistoryDiffTarget;
  to: HistoryDiffTarget;
  source?: HistorySource;
  provider?: string;
}

/**
 * JSON-path-like pointer to a changed field.
 *
 * @public
 */
export type HistoryDiffPath = string[];

/**
 * One structured diff entry.
 *
 * @public
 */
export interface HistoryDiffEntry {
  path: HistoryDiffPath;
  op: 'add' | 'remove' | 'replace';
  before?: HistoryJsonValue;
  after?: HistoryJsonValue;
}

/**
 * Diff response for one entity.
 *
 * @public
 */
export interface HistoryEntityDiffResponse {
  entityRef: string;
  from?: HistoryEntityVersion;
  to?: HistoryEntityVersion;
  changes: HistoryDiffEntry[];
}

/**
 * Facet bucket for filter UIs.
 *
 * @public
 */
export interface HistoryFacetBucket<TValue extends string = string> {
  value: TValue;
  count: number;
}

/**
 * Facets response for history filters.
 *
 * @public
 */
export interface HistoryFacetsResponse {
  sources: Array<HistoryFacetBucket<HistorySource>>;
  providers: HistoryFacetBucket[];
  operations: Array<HistoryFacetBucket<HistoryOperation>>;
  mutationTypes: Array<HistoryFacetBucket<HistoryMutationType>>;
  kinds: HistoryFacetBucket[];
}

/**
 * Facets request options.
 *
 * @public
 */
export interface HistoryFacetsRequest extends HistoryChangeFilter {}

/**
 * Aggregate stats request options.
 *
 * @public
 */
export interface HistoryStatsRequest extends HistoryChangeFilter {
  /** Optional grouping dimension for stats endpoints. */
  groupBy?: 'source' | 'provider' | 'op' | 'kind' | 'day';
}

/**
 * One stats bucket.
 *
 * @public
 */
export interface HistoryStatsBucket {
  key: string;
  counts: HistoryCycleCounts;
}

/**
 * Aggregate stats response.
 *
 * @public
 */
export interface HistoryStatsResponse {
  totals: HistoryCycleCounts;
  buckets: HistoryStatsBucket[];
}
