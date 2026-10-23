import { createApiRef } from '@backstage/core-plugin-api';
import type {
  HistoryEntityTimelineRequest,
  HistoryEntityTimelineResponse,
  HistoryEntityVersionRequest,
  HistoryEntityVersionResponse,
} from '@kunickiaj/backstage-plugin-catalog-history-common';

/** Read recorded events and their exact snapshots. @public */
export interface CatalogHistoryApi {
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
