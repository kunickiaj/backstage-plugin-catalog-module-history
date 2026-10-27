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

/** Starts a query with a validated page size, capped at the API maximum. */
function pageQuery(requested: number | undefined): URLSearchParams {
  const limit = requested ?? DEFAULT_HISTORY_PAGE_LIMIT;
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error('History page size must be a positive integer.');
  }
  return new URLSearchParams({
    limit: String(Math.min(limit, MAX_HISTORY_PAGE_LIMIT)),
  });
}

/** Adds each listed field that the request sets, in the listed order. */
function setDefined<T extends object>(
  query: URLSearchParams,
  request: T,
  keys: readonly (keyof T & string)[],
): void {
  for (const key of keys) {
    const value = request[key];
    if (value !== undefined) query.set(key, String(value));
  }
}

/** Canonical entity reference, defaulting kind and namespace like the catalog. */
function canonicalRef(ref: string): string {
  return stringifyEntityRef(
    parseEntityRef(ref, {
      defaultKind: 'Component',
      defaultNamespace: 'default',
    }),
  );
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
    const query = pageQuery(request.limit);
    if (request.cursor !== undefined) query.set('cursor', request.cursor);
    setDefined(query, request, [
      'source',
      'provider',
      'op',
      'mutationType',
      'startedAfter',
      'startedBefore',
      'finishedAfter',
      'finishedBefore',
    ]);
    return this.fetch(`/history/cycles?${query}`);
  }

  async getCycle(
    request: HistoryCycleDetailRequest,
  ): Promise<HistoryCycleDetailResponse> {
    const query = pageQuery(request.limit);
    if (request.cursor !== undefined) query.set('cursor', request.cursor);
    return this.fetch(
      `/history/cycles/${encodeURIComponent(request.cycleId)}?${query}`,
    );
  }

  async getEntities(
    request: HistoryEntitySearchRequest,
  ): Promise<HistoryEntitySearchResponse> {
    const query = pageQuery(request.limit);
    setDefined(query, request, [
      'source',
      'provider',
      'op',
      'changedAfter',
      'changedBefore',
      'cursor',
    ]);
    if (request.prefix) query.set('prefix', request.prefix);
    if (request.kind !== undefined) query.set('kind', request.kind.trim());
    return this.fetch(`/history/entities?${query}`);
  }

  async getKinds(
    request: HistoryKindSearchRequest,
  ): Promise<HistoryKindSearchResponse> {
    const query = pageQuery(request.limit);
    if (request.prefix) query.set('prefix', request.prefix);
    if (request.cursor !== undefined) query.set('cursor', request.cursor);
    return this.fetch(`/history/kinds?${query}`);
  }

  async getProviders(
    request: HistoryProviderSearchRequest,
  ): Promise<HistoryProviderSearchResponse> {
    const query = pageQuery(request.limit);
    setDefined(query, request, [
      'source',
      'op',
      'changedAfter',
      'changedBefore',
      'cursor',
    ]);
    if (request.prefix) query.set('prefix', request.prefix);
    if (request.entityRef !== undefined) {
      query.set('entityRef', canonicalRef(request.entityRef));
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
    const query = pageQuery(request.limit);
    setDefined(query, request, [
      'source',
      'provider',
      'op',
      'changedAfter',
      'changedBefore',
      'cursor',
    ]);
    if (request.entityRef !== undefined) {
      query.set('entityRef', canonicalRef(request.entityRef));
    }
    if (request.kind !== undefined) query.set('kind', request.kind.trim());
    return this.fetch(`/history/changes?${query}`);
  }

  async getEntityTimeline(
    request: HistoryEntityTimelineRequest,
  ): Promise<HistoryEntityTimelineResponse> {
    const query = pageQuery(request.limit);
    setDefined(query, request, [
      'source',
      'provider',
      'op',
      'changedAfter',
      'changedBefore',
      'cursor',
    ]);
    return this.get(request.entityRef, `/history?${query}`);
  }

  async getEntityAsOf(
    request: HistoryEntityAsOfRequest,
  ): Promise<HistoryEntityAsOfResponse> {
    const query = new URLSearchParams({ timestamp: request.timestamp });
    setDefined(query, request, ['source', 'provider']);
    return this.get(request.entityRef, `/as-of?${query}`);
  }

  async getEntityDiff(
    request: HistoryEntityDiffRequest,
  ): Promise<HistoryEntityDiffResponse> {
    const query = new URLSearchParams({
      from: `row:${request.from.id}`,
      to: `row:${request.to.id}`,
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
