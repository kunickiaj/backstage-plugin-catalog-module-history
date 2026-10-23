import type {
  HistoryEntityTimelineRequest,
  HistoryEntityVersion,
  HistoryEntityVersionResponse,
} from '@kunickiaj/backstage-plugin-catalog-history-common';
import { CatalogHistoryApiError } from '../src';
import type { CatalogHistoryApi } from '../src';
import { previewChanges, previewRecords } from './fixtures';

function matches(
  row: HistoryEntityVersion,
  request: HistoryEntityTimelineRequest,
) {
  return (
    row.entityRef === request.entityRef &&
    (!request.source || row.source === request.source) &&
    (!request.provider || row.provider === request.provider) &&
    (!request.op || row.op === request.op) &&
    (!request.changedAfter ||
      Date.parse(row.changedAt) >= Date.parse(request.changedAfter)) &&
    (!request.changedBefore ||
      Date.parse(row.changedAt) <= Date.parse(request.changedBefore))
  );
}

/** In-memory preview only: no network, credentials, or production client changes. */
export function createFixtureApi(): CatalogHistoryApi {
  return {
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
      const row = previewRecords.find(
        item => item.entityRef === request.entityRef && item.id === request.id,
      );
      if (!row) return Promise.reject(new CatalogHistoryApiError(404));
      const history = previewRecords.filter(
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
              ? previewChanges[row.id]
              : undefined,
          }),
        ) as HistoryEntityVersionResponse,
      );
    },
  };
}
