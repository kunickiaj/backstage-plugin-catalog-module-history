import { parseEntityRef } from '@backstage/catalog-model';
import type { DiscoveryApi, FetchApi } from '@backstage/core-plugin-api';
import {
  DEFAULT_HISTORY_PAGE_LIMIT,
  MAX_HISTORY_PAGE_LIMIT,
} from '@kunickiaj/backstage-plugin-catalog-history-common';
import type {
  HistoryEntityTimelineRequest,
  HistoryEntityTimelineResponse,
  HistoryEntityVersionRequest,
  HistoryEntityVersionResponse,
} from '@kunickiaj/backstage-plugin-catalog-history-common';
import { CatalogHistoryApi, CatalogHistoryApiError } from './CatalogHistoryApi';

/** Dependencies supplied by Backstage, including authenticated fetch. @public */
export interface CatalogHistoryClientOptions {
  discoveryApi: DiscoveryApi;
  fetchApi: FetchApi;
}

/** Catalog history HTTP client. @public */
export class CatalogHistoryClient implements CatalogHistoryApi {
  constructor(private readonly options: CatalogHistoryClientOptions) {}

  async getEntityTimeline(
    request: HistoryEntityTimelineRequest,
  ): Promise<HistoryEntityTimelineResponse> {
    const limit = request.limit ?? DEFAULT_HISTORY_PAGE_LIMIT;
    if (!Number.isInteger(limit) || limit < 1) {
      throw new Error('History page size must be a positive integer.');
    }
    const query = new URLSearchParams({
      limit: String(Math.min(limit, MAX_HISTORY_PAGE_LIMIT)),
    });
    (
      [
        'source',
        'provider',
        'op',
        'changedAfter',
        'changedBefore',
        'cursor',
      ] as const
    ).forEach(key => {
      if (request[key] !== undefined) query.set(key, request[key]);
    });
    return this.get(request.entityRef, `/history?${query}`);
  }

  async getEntityVersion(
    request: HistoryEntityVersionRequest,
  ): Promise<HistoryEntityVersionResponse> {
    return this.get(
      request.entityRef,
      `/versions/${encodeURIComponent(request.id)}`,
    );
  }

  private async get<T>(entityRef: string, suffix: string): Promise<T> {
    const { kind, namespace, name } = parseEntityRef(entityRef, {
      defaultKind: 'Component',
      defaultNamespace: 'default',
    });
    const path = [kind, namespace, name]
      .map(part => encodeURIComponent(part.toLowerCase()))
      .join('/');
    const baseUrl = await this.options.discoveryApi.getBaseUrl('catalog');
    const response = await this.options.fetchApi.fetch(
      `${baseUrl}/history/entities/${path}${suffix}`,
    );
    if (!response.ok) throw new CatalogHistoryApiError(response.status);
    return response.json();
  }
}
