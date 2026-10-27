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
} from '@kunickiaj/backstage-plugin-catalog-history-common';
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
    entityVersion: [] as HistoryEntityVersionRequest[],
    entityAsOf: [] as HistoryEntityAsOfRequest[],
    entityDiff: [] as HistoryEntityDiffRequest[],
    cycleList: [] as HistoryCycleListRequest[],
    cycleDetail: [] as HistoryCycleDetailRequest[],
    changeFeed: [] as HistoryChangeFeedRequest[],
  };

  entityTimeline: HistoryEntityTimelineResponse = { items: [] };
  entityVersions: HistoryEntityVersionsResponse = { items: [] };
  entityVersion: HistoryEntityVersionResponse = {
    id: '',
    cycleId: '',
    entityRef: '',
    source: 'provider',
    provider: '',
    op: 'delete',
    changedAt: '',
    summary: {},
  };
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

  async getEntityVersion(
    request: HistoryEntityVersionRequest,
  ): Promise<HistoryEntityVersionResponse> {
    this.requests.entityVersion.push(request);
    return this.entityVersion;
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
}
