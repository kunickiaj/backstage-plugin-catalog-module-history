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
  HistoryFacetsResponse,
  HistoryFacetsRequest,
  HistoryStatsRequest,
  HistoryStatsResponse,
} from '@kunickiaj/catalog-history-common';

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

  getFacets(request: HistoryFacetsRequest): Promise<HistoryFacetsResponse>;

  getStats(request: HistoryStatsRequest): Promise<HistoryStatsResponse>;
}
