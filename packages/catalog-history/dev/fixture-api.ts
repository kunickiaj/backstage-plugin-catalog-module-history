import type {
  HistoryChangeFeedRequest,
  HistoryEntityVersion,
  HistoryEntityVersionResponse,
  HistoryProviderSearchRequest,
  HistoryProviderSearchResponse,
} from '@kunickiaj/backstage-plugin-catalog-history-common';
import {
  DEFAULT_HISTORY_PAGE_LIMIT,
  MAX_HISTORY_PAGE_LIMIT,
} from '@kunickiaj/backstage-plugin-catalog-history-common';
import { CatalogHistoryApiError } from '../src';
import type { CatalogHistoryApi } from '../src';
import {
  crossEntityChanges,
  crossEntityRecords,
  previewRecords,
} from './fixtures';
import { parseEntityRef, stringifyEntityRef } from '@backstage/catalog-model';

function matches(row: HistoryEntityVersion, request: HistoryChangeFeedRequest) {
  return (
    (!request.entityRef ||
      row.entityRef ===
        stringifyEntityRef(
          parseEntityRef(request.entityRef, {
            defaultKind: 'Component',
            defaultNamespace: 'default',
          }),
        )) &&
    (!request.kind ||
      parseEntityRef(row.entityRef).kind.toLowerCase() ===
        request.kind.trim().toLowerCase()) &&
    (!request.source || row.source === request.source) &&
    (!request.provider || row.provider === request.provider) &&
    (!request.op || row.op === request.op) &&
    (!request.changedAfter ||
      Date.parse(row.changedAt) >= Date.parse(request.changedAfter)) &&
    (!request.changedBefore ||
      Date.parse(row.changedAt) <= Date.parse(request.changedBefore))
  );
}

const providerCursorPrefix = 'preview-providers:';

function providerCursorAfter(cursor: string | undefined, scope: string) {
  if (cursor === undefined) return undefined;
  try {
    if (
      typeof cursor !== 'string' ||
      !cursor.startsWith(providerCursorPrefix)
    ) {
      throw new CatalogHistoryApiError(400);
    }
    const value: unknown = JSON.parse(
      decodeURIComponent(cursor.slice(providerCursorPrefix.length)),
    );
    if (
      typeof value !== 'object' ||
      value === null ||
      !('version' in value) ||
      value.version !== 1 ||
      !('lastName' in value) ||
      typeof value.lastName !== 'string' ||
      !('scope' in value) ||
      value.scope !== scope
    ) {
      throw new CatalogHistoryApiError(400);
    }
    return value.lastName;
  } catch {
    throw new CatalogHistoryApiError(400);
  }
}

/** In-memory preview only: no network, credentials, or production client changes. */
export function createFixtureApi(): CatalogHistoryApi {
  return {
    async getProviders(
      request: HistoryProviderSearchRequest,
    ): Promise<HistoryProviderSearchResponse> {
      try {
        const limit =
          request.limit === undefined
            ? DEFAULT_HISTORY_PAGE_LIMIT
            : request.limit;
        if (
          !Number.isInteger(limit) ||
          limit < 1 ||
          (request.prefix !== undefined && typeof request.prefix !== 'string')
        ) {
          throw new CatalogHistoryApiError(400);
        }
        // Pick fields explicitly: discovery ignores exact provider and owner filters.
        const context: HistoryChangeFeedRequest = {
          source: request.source,
          entityRef: request.entityRef,
          kind: request.kind,
          op: request.op,
          changedAfter: request.changedAfter,
          changedBefore: request.changedBefore,
        };
        const prefix = request.prefix ?? '';
        const scope = JSON.stringify({ prefix, ...context });
        const after = providerCursorAfter(request.cursor, scope);
        // Binary ordering matches C ordering for these static ASCII fixture names.
        const names = Array.from(
          new Set(
            crossEntityRecords
              .filter(row => matches(row, context))
              .map(row => row.provider),
          ),
        )
          .filter(
            name =>
              name.toLowerCase().startsWith(prefix.toLowerCase()) &&
              (after === undefined || name > after),
          )
          .sort();
        const items = names.slice(0, Math.min(limit, MAX_HISTORY_PAGE_LIMIT));
        const nextCursor =
          names.length > items.length
            ? providerCursorPrefix +
              encodeURIComponent(
                JSON.stringify({
                  version: 1,
                  lastName: items[items.length - 1],
                  scope,
                }),
              )
            : undefined;
        return { items, nextCursor };
      } catch {
        throw new CatalogHistoryApiError(400);
      }
    },
    getChangeFeed(request) {
      const limit = request.limit ?? 25;
      if (!Number.isInteger(limit) || limit < 1)
        return Promise.reject(new CatalogHistoryApiError(400));
      const rows = crossEntityRecords.filter(row => matches(row, request));
      const offset = request.cursor
        ? rows.findIndex(row => `preview-after:${row.id}` === request.cursor) +
          1
        : 0;
      if (request.cursor && offset === 0)
        return Promise.reject(new CatalogHistoryApiError(400));
      const page = rows.slice(offset, offset + Math.min(limit, 5));
      const items = page.map(({ snapshot: _snapshot, ...item }) => {
        const { kind, namespace, name } = parseEntityRef(item.entityRef);
        return { ...item, kind, namespace, name };
      });
      const nextCursor =
        offset + page.length < rows.length
          ? `preview-after:${page[page.length - 1].id}`
          : undefined;
      return Promise.resolve({ items, nextCursor });
    },
    getEntityTimeline(request) {
      const limit = request.limit ?? 5;
      if (!Number.isInteger(limit) || limit < 1) {
        return Promise.reject(new CatalogHistoryApiError(400));
      }
      const rows = previewRecords.filter(row => matches(row, request));
      const offset = request.cursor
        ? rows.findIndex(row => `preview-after:${row.id}` === request.cursor) +
          1
        : 0;
      if (request.cursor && offset === 0) {
        return Promise.reject(new CatalogHistoryApiError(400));
      }
      // Keep pages small so the real UI's Load older action is visible.
      const page = rows.slice(offset, offset + Math.min(limit, 5));
      const items = page.map(({ snapshot: _snapshot, ...item }) => item);
      const nextCursor =
        offset + page.length < rows.length
          ? `preview-after:${page[page.length - 1].id}`
          : undefined;
      return Promise.resolve({ items, nextCursor });
    },
    getEntityVersion(request) {
      const row = crossEntityRecords.find(
        item => item.entityRef === request.entityRef && item.id === request.id,
      );
      if (!row) return Promise.reject(new CatalogHistoryApiError(404));
      const history = crossEntityRecords.filter(
        item =>
          item.entityRef === row.entityRef &&
          item.source === row.source &&
          item.provider === row.provider,
      );
      const previousVersion = history[history.indexOf(row) + 1];
      return Promise.resolve(
        JSON.parse(
          JSON.stringify({
            ...row,
            previousVersion,
            changes: previousVersion?.snapshot
              ? crossEntityChanges[row.id]
              : undefined,
          }),
        ) as HistoryEntityVersionResponse,
      );
    },
  };
}
