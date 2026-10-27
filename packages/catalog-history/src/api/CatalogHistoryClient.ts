import { parseEntityRef, stringifyEntityRef } from '@backstage/catalog-model';
import type { DiscoveryApi, FetchApi } from '@backstage/core-plugin-api';
import {
  DEFAULT_HISTORY_PAGE_LIMIT,
  MAX_HISTORY_PAGE_LIMIT,
} from '@kunickiaj/backstage-plugin-catalog-history-common';
import type {
  HistoryChangeFeedRequest,
  HistoryChangeFeedResponse,
  HistoryCycleDetailRequest,
  HistoryCycleDetailResponse,
  HistoryCycleListRequest,
  HistoryCycleListResponse,
  HistoryEntityAsOfRequest,
  HistoryEntityAsOfResponse,
  HistoryDiffTarget,
  HistoryEntityDiffRequest,
  HistoryEntityDiffResponse,
  HistoryEntitySearchRequest,
  HistoryEntitySearchResponse,
  HistoryEntityTimelineRequest,
  HistoryEntityTimelineResponse,
  HistoryEntityVersionRequest,
  HistoryEntityVersionResponse,
  HistoryKindSearchRequest,
  HistoryKindSearchResponse,
  HistoryProviderSearchRequest,
  HistoryProviderSearchResponse,
} from '@kunickiaj/backstage-plugin-catalog-history-common';
import { CatalogHistoryApi, CatalogHistoryApiError } from './CatalogHistoryApi';

// The history API compares recorded rows only; see its diff route.
function rowTarget(target: HistoryDiffTarget): string {
  if (target.kind !== 'history-row') {
    throw new Error('History comparison supports recorded events only.');
  }
  return `row:${target.id}`;
}

/** Dependencies supplied by Backstage, including authenticated fetch. @public */
export interface CatalogHistoryClientOptions {
  discoveryApi: DiscoveryApi;
  fetchApi: FetchApi;
}

/** Catalog history HTTP client. @public */
export class CatalogHistoryClient implements CatalogHistoryApi {
  constructor(private readonly options: CatalogHistoryClientOptions) {}

  async listCycles(
    request: HistoryCycleListRequest,
  ): Promise<HistoryCycleListResponse> {
    const query = this.cyclePageQuery(request);
    (
      [
        'source',
        'provider',
        'op',
        'mutationType',
        'startedAfter',
        'startedBefore',
        'finishedAfter',
        'finishedBefore',
      ] as const
    ).forEach(key => {
      if (request[key] !== undefined) query.set(key, request[key]);
    });
    return this.fetch(`/history/cycles?${query}`);
  }

  async getCycle(
    request: HistoryCycleDetailRequest,
  ): Promise<HistoryCycleDetailResponse> {
    const query = this.cyclePageQuery(request);
    return this.fetch(
      `/history/cycles/${encodeURIComponent(request.cycleId)}?${query}`,
    );
  }

  async getEntities(
    request: HistoryEntitySearchRequest,
  ): Promise<HistoryEntitySearchResponse> {
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
    if (request.prefix) query.set('prefix', request.prefix);
    if (request.kind !== undefined) query.set('kind', request.kind.trim());
    return this.fetch(`/history/entities?${query}`);
  }

  async getKinds(
    request: HistoryKindSearchRequest,
  ): Promise<HistoryKindSearchResponse> {
    const limit = request.limit ?? DEFAULT_HISTORY_PAGE_LIMIT;
    if (!Number.isInteger(limit) || limit < 1) {
      throw new Error('History page size must be a positive integer.');
    }
    const query = new URLSearchParams({
      limit: String(Math.min(limit, MAX_HISTORY_PAGE_LIMIT)),
    });
    if (request.prefix) query.set('prefix', request.prefix);
    if (request.cursor !== undefined) query.set('cursor', request.cursor);
    return this.fetch(`/history/kinds?${query}`);
  }

  async getProviders(
    request: HistoryProviderSearchRequest,
  ): Promise<HistoryProviderSearchResponse> {
    const limit = request.limit ?? DEFAULT_HISTORY_PAGE_LIMIT;
    if (!Number.isInteger(limit) || limit < 1) {
      throw new Error('History page size must be a positive integer.');
    }
    const query = new URLSearchParams({
      limit: String(Math.min(limit, MAX_HISTORY_PAGE_LIMIT)),
    });
    (
      ['source', 'op', 'changedAfter', 'changedBefore', 'cursor'] as const
    ).forEach(key => {
      if (request[key] !== undefined) query.set(key, request[key]);
    });
    if (request.prefix) query.set('prefix', request.prefix);
    if (request.entityRef !== undefined) {
      query.set(
        'entityRef',
        stringifyEntityRef(
          parseEntityRef(request.entityRef, {
            defaultKind: 'Component',
            defaultNamespace: 'default',
          }),
        ),
      );
    }
    if (request.kind !== undefined) query.set('kind', request.kind.trim());
    return this.fetch(`/history/providers?${query}`);
  }

  async getChangeFeed(
    request: HistoryChangeFeedRequest,
  ): Promise<HistoryChangeFeedResponse> {
    if (request.owner !== undefined) {
      throw new Error('Owner filtering is not supported by the history API.');
    }
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
    if (request.entityRef !== undefined) {
      query.set(
        'entityRef',
        stringifyEntityRef(
          parseEntityRef(request.entityRef, {
            defaultKind: 'Component',
            defaultNamespace: 'default',
          }),
        ),
      );
    }
    if (request.kind !== undefined) query.set('kind', request.kind.trim());
    return this.fetch(`/history/changes?${query}`);
  }

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

  async getEntityAsOf(
    request: HistoryEntityAsOfRequest,
  ): Promise<HistoryEntityAsOfResponse> {
    const query = new URLSearchParams({ timestamp: request.timestamp });
    (['source', 'provider'] as const).forEach(key => {
      if (request[key] !== undefined) query.set(key, request[key]);
    });
    return this.get(request.entityRef, `/as-of?${query}`);
  }

  async getEntityDiff(
    request: HistoryEntityDiffRequest,
  ): Promise<HistoryEntityDiffResponse> {
    const query = new URLSearchParams({
      from: rowTarget(request.from),
      to: rowTarget(request.to),
    });
    return this.get(request.entityRef, `/diff?${query}`);
  }

  async getEntityVersion(
    request: HistoryEntityVersionRequest,
  ): Promise<HistoryEntityVersionResponse> {
    return this.get(
      request.entityRef,
      `/versions/${encodeURIComponent(request.id)}`,
    );
  }

  private cyclePageQuery(request: {
    limit?: number;
    cursor?: string;
  }): URLSearchParams {
    const limit = request.limit ?? DEFAULT_HISTORY_PAGE_LIMIT;
    if (!Number.isInteger(limit) || limit < 1) {
      throw new Error('History page size must be a positive integer.');
    }
    const query = new URLSearchParams({
      limit: String(Math.min(limit, MAX_HISTORY_PAGE_LIMIT)),
    });
    if (request.cursor !== undefined) query.set('cursor', request.cursor);
    return query;
  }

  private async get<T>(entityRef: string, suffix: string): Promise<T> {
    const { kind, namespace, name } = parseEntityRef(entityRef, {
      defaultKind: 'Component',
      defaultNamespace: 'default',
    });
    const path = [kind, namespace, name]
      .map(part => encodeURIComponent(part.toLowerCase()))
      .join('/');
    return this.fetch(`/history/entities/${path}${suffix}`);
  }

  private async fetch<T>(path: string): Promise<T> {
    const baseUrl = await this.options.discoveryApi.getBaseUrl('catalog');
    const response = await this.options.fetchApi.fetch(`${baseUrl}${path}`);
    if (!response.ok) throw new CatalogHistoryApiError(response.status);
    return response.json();
  }
}
