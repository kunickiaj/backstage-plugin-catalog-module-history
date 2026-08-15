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
import type { HistoryQueryService } from '../query/HistoryQueryService';

/**
 * Programmable test double for {@link HistoryQueryService}.
 *
 * Each method records the requests it receives and returns the corresponding
 * mutable response property. Tests can assign only the responses they care
 * about while the default empty responses keep setup lightweight.
 */
export class InMemoryHistoryQueryService implements HistoryQueryService {
  readonly requests = {
    entityTimeline: [] as HistoryEntityTimelineRequest[],
    entityVersions: [] as HistoryEntityVersionsRequest[],
    entityAsOf: [] as HistoryEntityAsOfRequest[],
    entityDiff: [] as HistoryEntityDiffRequest[],
    cycleList: [] as HistoryCycleListRequest[],
    cycleDetail: [] as HistoryCycleDetailRequest[],
    changeFeed: [] as HistoryChangeFeedRequest[],
    facets: [] as HistoryFacetsRequest[],
    stats: [] as HistoryStatsRequest[],
  };

  entityTimeline: HistoryEntityTimelineResponse = { items: [] };
  entityVersions: HistoryEntityVersionsResponse = { items: [] };
  entityAsOf: HistoryEntityAsOfResponse = {
    entityRef: '',
    asOf: '',
  };
  entityDiff: HistoryEntityDiffResponse = {
    entityRef: '',
    changes: [],
  };
  cycleList: HistoryCycleListResponse = { items: [] };
  cycleDetail: HistoryCycleDetailResponse = {
    cycle: {
      cycleId: '',
      provider: '',
      source: 'provider',
      mutationType: 'full',
      startedAt: '',
      finishedAt: '',
      counts: { inserted: 0, updated: 0, deleted: 0, unchanged: 0 },
    },
    changes: { items: [] },
  };
  changeFeed: HistoryChangeFeedResponse = { items: [] };
  facets: HistoryFacetsResponse = {
    sources: [],
    providers: [],
    operations: [],
    mutationTypes: [],
    kinds: [],
  };
  stats: HistoryStatsResponse = {
    totals: { inserted: 0, updated: 0, deleted: 0, unchanged: 0 },
    buckets: [],
  };

  async getEntityTimeline(
    request: HistoryEntityTimelineRequest,
  ): Promise<HistoryEntityTimelineResponse> {
    this.requests.entityTimeline.push(request);
    return this.entityTimeline;
  }

  async getEntityVersions(
    request: HistoryEntityVersionsRequest,
  ): Promise<HistoryEntityVersionsResponse> {
    this.requests.entityVersions.push(request);
    return this.entityVersions;
  }

  async getEntityAsOf(
    request: HistoryEntityAsOfRequest,
  ): Promise<HistoryEntityAsOfResponse> {
    this.requests.entityAsOf.push(request);
    return this.entityAsOf;
  }

  async getEntityDiff(
    request: HistoryEntityDiffRequest,
  ): Promise<HistoryEntityDiffResponse> {
    this.requests.entityDiff.push(request);
    return this.entityDiff;
  }

  async listCycles(
    request: HistoryCycleListRequest,
  ): Promise<HistoryCycleListResponse> {
    this.requests.cycleList.push(request);
    return this.cycleList;
  }

  async getCycle(
    request: HistoryCycleDetailRequest,
  ): Promise<HistoryCycleDetailResponse> {
    this.requests.cycleDetail.push(request);
    return this.cycleDetail;
  }

  async getChangeFeed(
    request: HistoryChangeFeedRequest,
  ): Promise<HistoryChangeFeedResponse> {
    this.requests.changeFeed.push(request);
    return this.changeFeed;
  }

  async getFacets(
    request: HistoryFacetsRequest,
  ): Promise<HistoryFacetsResponse> {
    this.requests.facets.push(request);
    return this.facets;
  }

  async getStats(request: HistoryStatsRequest): Promise<HistoryStatsResponse> {
    this.requests.stats.push(request);
    return this.stats;
  }
}
