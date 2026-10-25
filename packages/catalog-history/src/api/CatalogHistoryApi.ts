import { createApiRef } from '@backstage/core-plugin-api';
import type {
  HistoryChangeFeedRequest,
  HistoryChangeFeedResponse,
  HistoryCycleListRequest,
  HistoryCycleListResponse,
  HistoryCycleDetailRequest,
  HistoryCycleDetailResponse,
  HistoryEntityAsOfRequest,
  HistoryEntityAsOfResponse,
  HistoryEntityTimelineRequest,
  HistoryEntityTimelineResponse,
  HistoryEntityVersionRequest,
  HistoryEntityVersionResponse,
  HistoryProviderSearchRequest,
  HistoryProviderSearchResponse,
  HistoryEntitySearchRequest,
  HistoryEntitySearchResponse,
  HistoryKindSearchRequest,
  HistoryKindSearchResponse,
} from '@kunickiaj/backstage-plugin-catalog-history-common';

/** Read recorded events and their exact snapshots. @public */
export interface CatalogHistoryApi {
  /** Optional latest retained observation at or before the requested timestamp. */
  getEntityAsOf?(
    request: HistoryEntityAsOfRequest,
  ): Promise<HistoryEntityAsOfResponse>;
  /** Optional reads of recorded cycles, including cycles without entity changes. */
  listCycles?(
    request: HistoryCycleListRequest,
  ): Promise<HistoryCycleListResponse>;
  /** Optional cycle metadata and paginated retained changes; not live state. */
  getCycle?(
    request: HistoryCycleDetailRequest,
  ): Promise<HistoryCycleDetailResponse>;
  /** Optional retained-provider discovery; absent APIs keep exact-name input. */
  getProviders?(
    request: HistoryProviderSearchRequest,
  ): Promise<HistoryProviderSearchResponse>;
  /** Optional name-prefix discovery over retained identities, including deletes. */
  getEntities?(
    request: HistoryEntitySearchRequest,
  ): Promise<HistoryEntitySearchResponse>;
  /** Optional paginated discovery of retained kinds. */
  getKinds?(
    request: HistoryKindSearchRequest,
  ): Promise<HistoryKindSearchResponse>;
  getChangeFeed?(
    request: HistoryChangeFeedRequest,
  ): Promise<HistoryChangeFeedResponse>;
  getEntityTimeline(
    request: HistoryEntityTimelineRequest,
  ): Promise<HistoryEntityTimelineResponse>;
  getEntityVersion(
    request: HistoryEntityVersionRequest,
  ): Promise<HistoryEntityVersionResponse>;
}

/** API used by the entity History tab. @public */
export const catalogHistoryApiRef = createApiRef<CatalogHistoryApi>({
  id: 'plugin.catalog-history',
});

/** Safe HTTP failure without backend response bodies. @public */
export class CatalogHistoryApiError extends Error {
  constructor(public readonly status: number) {
    super(`Catalog history request failed (HTTP ${status}).`);
    this.name = 'CatalogHistoryApiError';
  }
}
