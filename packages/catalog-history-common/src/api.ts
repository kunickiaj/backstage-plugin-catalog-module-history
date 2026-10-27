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
  /**
   * Exact match on the recorded `spec.owner` string, as written in the entity
   * (`platform` and `group:default/platform` are different values). Delete rows
   * store no owner and never match. Supported only by direct Node
   * `HistoryQueryService` entity timeline and version queries; the HTTP API,
   * frontend client, and change feed reject it.
   */
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
  /** Only include cycles with at least one retained entity row with this operation. */
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
 * Optional flags compare saved fields between adjacent events for the same
 * entity, source, and provider. For an update with a non-delete predecessor,
 * `true` means known changed values and `false` means known unchanged values.
 * A flag is omitted when either value or the comparison is unavailable,
 * including inserts, deletes, and missing or deleted predecessors. Providers
 * and query implementations may leave summaries empty.
 *
 * Arrays are compared as whole, order-sensitive values; object key order is
 * ignored. These flags describe saved field differences, not upstream deltas
 * or graph semantics, without requiring a full structured diff.
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
 * Aggregate counts recorded for one history cycle, not a count of the current
 * catalog, retained rows, or the displayed change page.
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
 * Cycle list request options. Lists newest started cycles first, breaking ties
 * by native UUID order. Includes cycles with no retained entity rows unless an
 * operation filter excludes them. Cursors bind the filters, not the page limit.
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
 * One entity change included in a cycle detail response. Cycle change summaries
 * may be empty when saved-field comparisons are unavailable.
 *
 * @public
 */
export interface HistoryCycleChange
  extends HistoryTimelineItem, HistoryEntityIdentity {}

/**
 * Cycle detail request options. Cycle IDs are PostgreSQL UUIDs. Metadata is
 * returned with a page of changed entities; use `cursor` to fetch additional
 * changed-entity pages for large cycles, ordered by stored change timestamp
 * and row ID, newest first.
 * Cursors bind the cycle identity, not the page limit.
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
 * Discover provider names represented by retained entity-history rows.
 *
 * Context filters apply before distinct-name pagination. This is separate from
 * the exact `provider` filter on history requests and does not enumerate live
 * provider registrations or providers represented only by empty cycles.
 *
 * @public
 */
export interface HistoryProviderSearchRequest
  extends
    HistoryPageOptions,
    Pick<
      HistoryChangeFilter,
      'entityRef' | 'kind' | 'source' | 'op' | 'changedAfter' | 'changedBefore'
    > {
  /**
   * Case-insensitive literal prefix, using PostgreSQL LOWER matching.
   * Omitted or empty lists the first names in scope. Whitespace is preserved;
   * percent, underscore and backslash have no wildcard meaning.
   */
  prefix?: string;
  /** Discovery does not accept the currently selected exact provider filter. */
  provider?: never;
  /** Owner filtering is not part of provider discovery. */
  owner?: never;
  /** Opaque provider-search cursor bound to the prefix and context filters. */
  cursor?: HistoryPageCursor;
}

/**
 * Original provider names, distinct and ascending under PostgreSQL C collation.
 * Case variants remain separate names. Pagination is live, not a snapshot.
 *
 * @public
 */
export type HistoryProviderSearchResponse = HistoryPage<string>;

/**
 * Discover distinct identities represented by retained entity-history rows,
 * including delete tombstones. Filters select matching observations before
 * choosing the latest matching row for each canonical entity reference.
 *
 * @public
 */
export interface HistoryEntitySearchRequest
  extends
    HistoryPageOptions,
    Pick<
      HistoryChangeFilter,
      'kind' | 'source' | 'provider' | 'op' | 'changedAfter' | 'changedBefore'
    > {
  /**
   * Case-insensitive literal name prefix using PostgreSQL LOWER. Omitted or
   * empty lists the first identities in scope. Whitespace is preserved;
   * percent, underscore and backslash have no wildcard meaning.
   */
  prefix?: string;
  /** The already selected entity must not restrict discovery of alternatives. */
  entityRef?: never;
  /** Owner filtering is not part of identity discovery. */
  owner?: never;
}

/**
 * Identities ordered by PostgreSQL-folded name, then canonical reference, using
 * C collation. Fields come from one latest matching observation, not the live
 * catalog. Cursors bind prefix and context; pagination is live, not a snapshot.
 *
 * @public
 */
export type HistoryEntitySearchResponse = HistoryPage<HistoryEntityIdentity>;

/**
 * Discover all retained kinds independently of the selected history filters.
 *
 * @public
 */
export interface HistoryKindSearchRequest extends HistoryPageOptions {
  /** Case-insensitive literal kind prefix; omitted or empty lists first kinds. */
  prefix?: string;
}

/**
 * One stored spelling per PostgreSQL-folded kind, choosing the smallest stored
 * spelling under C collation. Pages sort by the folded kind under C collation
 * and include kinds represented only by delete tombstones. No live status or
 * event counts are implied. Cursors bind the prefix; pagination is live.
 *
 * @public
 */
export type HistoryKindSearchResponse = HistoryPage<string>;

/**
 * Distinct persisted version of one entity.
 *
 * @public
 */
export interface HistoryEntityVersion extends HistoryTimelineItem {
  snapshot?: HistoryEntitySnapshot;
}

/**
 * Exact recorded row to retrieve, scoped to its entity reference.
 *
 * @public
 */
export interface HistoryEntityVersionRequest {
  entityRef: string;
  id: string;
}

/**
 * One exact recorded row; delete tombstones have no snapshot.
 *
 * @public
 */
export interface HistoryEntityVersionResponse extends HistoryEntityVersion {
  /** Immediately preceding recorded row for the same entity, source and provider. */
  previousVersion?: HistoryEntityVersion;
  /**
   * Differences between saved snapshots, or removals from the preceding saved
   * snapshot to a delete tombstone. Omitted when no prior snapshot is available.
   * Arrays are compared as whole values, with order preserved.
   */
  changes?: HistoryDiffEntry[];
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
 * Request the latest physical retained observation at or before a timestamp.
 * Optional source and provider predicates match exactly. Without them, the
 * latest matching observation can come from any capture layer; fields are
 * never combined across observations or filled from the live catalog.
 *
 * @public
 */
export interface HistoryEntityAsOfRequest {
  entityRef: string;
  /** Inclusive ISO 8601 cutoff; database comparison preserves microseconds. */
  timestamp: string;
  source?: HistorySource;
  provider?: string;
}

/**
 * One saved observation at the requested cutoff, with its recorded provenance.
 * A deletion returns its tombstone version without a snapshot. No eligible
 * retained observation leaves version and snapshot absent; this is unknown
 * from retained data, not evidence that the entity never existed.
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
 * Diff request for one entity. Changes describe how `from` became `to`.
 *
 * The default store supports only `history-row` targets, which may come from
 * different capture streams. Two rows must differ.
 *
 * @public
 */
export interface HistoryEntityDiffRequest {
  entityRef: string;
  from: HistoryDiffTarget;
  to: HistoryDiffTarget;
  /** Selects a capture stream for cycle and timestamp targets. The default store rejects it with row targets. */
  source?: HistorySource;
  /** Selects a provider for cycle and timestamp targets. The default store rejects it with row targets. */
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
