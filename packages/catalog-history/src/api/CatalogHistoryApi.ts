import { createApiRef } from '@backstage/core-plugin-api';
import type {
  HistoryChangeFeedRequest,
  HistoryChangeFeedResponse,
  HistoryEntityTimelineRequest,
  HistoryEntityTimelineResponse,
  HistoryEntityVersionRequest,
  HistoryEntityVersionResponse,
  HistoryProviderSearchRequest,
  HistoryProviderSearchResponse,
} from '@kunickiaj/backstage-plugin-catalog-history-common';

/** Read recorded events and their exact snapshots. @public */
export interface CatalogHistoryApi {
  /** Optional retained-provider discovery; absent APIs keep exact-name input. */
  getProviders?(
    request: HistoryProviderSearchRequest,
  ): Promise<HistoryProviderSearchResponse>;
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
