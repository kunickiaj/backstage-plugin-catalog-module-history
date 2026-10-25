import type {
  HistoryChangeFeedRequest,
  HistoryChangeFeedResponse,
  HistoryCycleDetailRequest,
  HistoryCycleDetailResponse,
  HistoryCycleListRequest,
  HistoryCycleListResponse,
  HistoryEntityAsOfRequest,
  HistoryEntityAsOfResponse,
  HistoryEntityDiffRequest,
  HistoryEntityDiffResponse,
  HistoryEntityTimelineRequest,
  HistoryEntityTimelineResponse,
  HistoryEntityVersionsRequest,
  HistoryEntityVersionsResponse,
  HistoryEntityVersionRequest,
  HistoryEntityVersionResponse,
  HistoryFacetsResponse,
  HistoryFacetsRequest,
  HistoryStatsRequest,
  HistoryStatsResponse,
  HistoryProviderSearchRequest,
  HistoryProviderSearchResponse,
  HistoryEntitySearchRequest,
  HistoryEntitySearchResponse,
  HistoryKindSearchRequest,
  HistoryKindSearchResponse,
} from '@kunickiaj/backstage-plugin-catalog-history-common';

/**
 * Backend query contract for catalog history reads.
 *
 * Implementations should enforce validation, pagination limits, and
 * permissions at the service or router boundary before returning these DTOs
 * to frontend clients.
 *
 * @public
 */
export interface HistoryQueryService {
  getEntityTimeline(
    request: HistoryEntityTimelineRequest,
  ): Promise<HistoryEntityTimelineResponse>;

  getEntityVersions(
    request: HistoryEntityVersionsRequest,
  ): Promise<HistoryEntityVersionsResponse>;

  getEntityVersion(
    request: HistoryEntityVersionRequest,
  ): Promise<HistoryEntityVersionResponse>;

  getEntityAsOf(
    request: HistoryEntityAsOfRequest,
  ): Promise<HistoryEntityAsOfResponse>;

  getEntityDiff(
    request: HistoryEntityDiffRequest,
  ): Promise<HistoryEntityDiffResponse>;

  listCycles(
    request: HistoryCycleListRequest,
  ): Promise<HistoryCycleListResponse>;

  getCycle(
    request: HistoryCycleDetailRequest,
  ): Promise<HistoryCycleDetailResponse>;

  getChangeFeed(
    request: HistoryChangeFeedRequest,
  ): Promise<HistoryChangeFeedResponse>;

  /** Optional discovery of retained provider names; history filters remain exact. */
  getProviders?(
    request: HistoryProviderSearchRequest,
  ): Promise<HistoryProviderSearchResponse>;

  /** Optional retained-identity discovery; history entity-ref filters remain exact. */
  getEntities?(
    request: HistoryEntitySearchRequest,
  ): Promise<HistoryEntitySearchResponse>;

  /** Optional paginated discovery of retained kinds, independent of active filters. */
  getKinds?(
    request: HistoryKindSearchRequest,
  ): Promise<HistoryKindSearchResponse>;

  getFacets(request: HistoryFacetsRequest): Promise<HistoryFacetsResponse>;

  getStats(request: HistoryStatsRequest): Promise<HistoryStatsResponse>;
}
