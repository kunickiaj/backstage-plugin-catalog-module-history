import type {
  HistoryChangeFeedRequest,
  HistoryCycle,
  HistoryCycleChange,
  HistoryCycleFilter,
  HistoryDiffEntry,
  HistoryDiffTarget,
  HistoryEntityDiffResponse,
  HistoryEntityIdentity,
  HistoryEntitySearchRequest,
  HistoryEntitySnapshot,
  HistoryEntityVersion,
  HistoryEntityVersionResponse,
  HistoryKindSearchRequest,
  HistoryPage,
  HistoryProviderSearchRequest,
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

function compareBinary(left: string, right: string) {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

const PREVIEW_CURSOR = 'preview:';

/**
 * Pages preview rows by offset. Real backends use opaque, filter-bound
 * cursors; the preview only needs Load more to work.
 */
function page<T>(
  rows: readonly T[],
  options: { limit?: number; cursor?: string },
  maxLimit = MAX_HISTORY_PAGE_LIMIT,
): HistoryPage<T> {
  const offset = options.cursor
    ? Number(options.cursor.slice(PREVIEW_CURSOR.length))
    : 0;
  if (
    options.cursor !== undefined &&
    (!options.cursor.startsWith(PREVIEW_CURSOR) ||
      !Number.isInteger(offset) ||
      offset <= 0)
  ) {
    throw new CatalogHistoryApiError(400);
  }
  const limit = Math.min(options.limit ?? DEFAULT_HISTORY_PAGE_LIMIT, maxLimit);
  const end = offset + limit;
  return {
    items: rows.slice(offset, end),
    nextCursor: end < rows.length ? `${PREVIEW_CURSOR}${end}` : undefined,
  };
}

/** Recorded rows without snapshots, as list endpoints return them. */
function withoutSnapshot({
  snapshot: _snapshot,
  ...item
}: HistoryEntityVersion) {
  return item;
}

function identity(row: HistoryEntityVersion): HistoryEntityIdentity {
  const parsed = parseEntityRef(row.entityRef);
  // Missing snapshots simulate stored tombstone identity, never a live catalog lookup.
  const { kind, namespace, name } = row.snapshot ?? parsed;
  return { entityRef: stringifyEntityRef(parsed), kind, namespace, name };
}

function entityIdentities(context: HistoryChangeFeedRequest, prefix: string) {
  const identities = new Map<string, HistoryEntityIdentity>();
  // Copy before sorting: preserve the existing history/detail fixture ordering.
  crossEntityRecords
    .filter(row => matches(row, context))
    .slice()
    .sort(
      (a, b) =>
        Date.parse(b.changedAt) - Date.parse(a.changedAt) ||
        compareBinary(b.id, a.id),
    )
    .map(identity)
    .filter(item => item.name.toLowerCase().startsWith(prefix.toLowerCase()))
    .forEach(item => {
      if (!identities.has(item.entityRef)) identities.set(item.entityRef, item);
    });
  // Binary comparisons and JS folding apply only to these finite ASCII fixtures.
  return Array.from(identities.values()).sort(
    (a, b) =>
      compareBinary(a.name.toLowerCase(), b.name.toLowerCase()) ||
      compareBinary(a.entityRef, b.entityRef),
  );
}

function retainedKinds(prefix: string) {
  const kinds = new Map<string, string>();
  crossEntityRecords.map(identity).forEach(({ kind }) => {
    const folded = kind.toLowerCase();
    if (!folded.startsWith(prefix.toLowerCase())) return;
    const previous = kinds.get(folded);
    if (previous === undefined || kind < previous) kinds.set(folded, kind);
  });
  return Array.from(kinds.values()).sort((a, b) =>
    compareBinary(a.toLowerCase(), b.toLowerCase()),
  );
}

function fixtureCycle(rows: readonly HistoryEntityVersion[]): HistoryCycle {
  const first = rows[0];
  if (
    rows.some(
      row => row.source !== first.source || row.provider !== first.provider,
    )
  ) {
    throw new Error(`Incoherent preview cycle: ${first.cycleId}`);
  }
  const times = rows.map(row => Date.parse(row.changedAt));
  // These are defined mock recorded totals for a COMPLETE synthetic ledger,
  // not a general algorithm for deriving cycle totals from retained history.
  const counts = {
    inserted: rows.filter(row => row.op === 'insert').length,
    updated: rows.filter(row => row.op === 'update').length,
    deleted: rows.filter(row => row.op === 'delete').length,
    unchanged: 0,
  };
  return {
    cycleId: first.cycleId,
    source: first.source,
    provider: first.provider,
    // Explicit preview policy; old entity fixtures did not store cycle metadata.
    mutationType: first.source === 'processing' ? 'delta' : 'full',
    startedAt: new Date(Math.min(...times) - 1000).toISOString(),
    finishedAt: new Date(Math.max(...times)).toISOString(),
    counts,
  };
}

function fixtureCycles(): HistoryCycle[] {
  const groups = new Map<string, HistoryEntityVersion[]>();
  crossEntityRecords.forEach(row => {
    const group = groups.get(row.cycleId) ?? [];
    group.push(row);
    groups.set(row.cycleId, group);
  });
  return [
    ...Array.from(groups.values(), fixtureCycle),
    {
      cycleId: 'preview-empty-cycle',
      source: 'reconciler',
      provider: 'reconciler',
      mutationType: 'full',
      startedAt: '2026-10-16T12:00:00.000Z',
      finishedAt: '2026-10-16T12:00:01.000Z',
      counts: { inserted: 0, updated: 0, deleted: 0, unchanged: 10 },
    },
  ];
}

// Construct before any request filters or paging; no new entity events are added.
const cycleLedger = fixtureCycles();

function cycleMatches(
  cycle: HistoryCycle,
  context: HistoryCycleFilter,
): boolean {
  return (
    (context.source === undefined || cycle.source === context.source) &&
    (context.provider === undefined || cycle.provider === context.provider) &&
    (context.mutationType === undefined ||
      cycle.mutationType === context.mutationType) &&
    (context.op === undefined ||
      crossEntityRecords.some(
        row => row.cycleId === cycle.cycleId && row.op === context.op,
      )) &&
    (context.startedAfter === undefined ||
      Date.parse(cycle.startedAt) >= Date.parse(context.startedAfter)) &&
    (context.startedBefore === undefined ||
      Date.parse(cycle.startedAt) <= Date.parse(context.startedBefore)) &&
    (context.finishedAfter === undefined ||
      Date.parse(cycle.finishedAt) >= Date.parse(context.finishedAfter)) &&
    (context.finishedBefore === undefined ||
      Date.parse(cycle.finishedAt) <= Date.parse(context.finishedBefore))
  );
}

function cycleChange(row: HistoryEntityVersion): HistoryCycleChange {
  const { snapshot: _snapshot, ...metadata } = row;
  return { ...metadata, ...identity(row), summary: {} };
}

// Preview only: compares top-level saved fields as whole values. The real
// backend descends into nested objects.
function previewChanges(
  before: HistoryEntitySnapshot | undefined,
  after: HistoryEntitySnapshot | undefined,
): HistoryDiffEntry[] {
  const fields = [
    'displayName',
    'email',
    'memberOf',
    'metadata',
    'orphan',
    'owner',
    'parent',
    'relations',
    'spec',
    'statusItems',
  ] as const;
  return fields.flatMap((field): HistoryDiffEntry[] => {
    const previous = before?.[field];
    const next = after?.[field];
    if (JSON.stringify(previous) === JSON.stringify(next)) return [];
    if (previous === undefined)
      return [{ path: [field], op: 'add', after: next }];
    if (next === undefined)
      return [{ path: [field], op: 'remove', before: previous }];
    return [{ path: [field], op: 'replace', before: previous, after: next }];
  });
}

/** In-memory preview only: no network, credentials, or production client changes. */
export function createFixtureApi(): CatalogHistoryApi {
  return {
    async listCycles(request) {
      const rows = cycleLedger
        .filter(cycle => cycleMatches(cycle, request))
        .sort(
          (a, b) =>
            Date.parse(b.startedAt) - Date.parse(a.startedAt) ||
            compareBinary(b.cycleId, a.cycleId),
        );
      return clone(page(rows, request));
    },
    async getCycle(request) {
      const cycle = cycleLedger.find(item => item.cycleId === request.cycleId);
      if (cycle === undefined) throw new CatalogHistoryApiError(404);
      const rows = crossEntityRecords
        .filter(row => row.cycleId === request.cycleId)
        .map(cycleChange)
        .sort(
          (a, b) =>
            Date.parse(b.changedAt) - Date.parse(a.changedAt) ||
            compareBinary(b.id, a.id),
        );
      return clone({ cycle, changes: page(rows, request) });
    },
    async getEntities(request: HistoryEntitySearchRequest) {
      const { entityRef: _selected, owner: _owner, ...context } = request;
      return page(entityIdentities(context, request.prefix ?? ''), request);
    },
    async getKinds(request: HistoryKindSearchRequest) {
      return page(retainedKinds(request.prefix ?? ''), request);
    },
    async getProviders(request: HistoryProviderSearchRequest) {
      // Discovery ignores the exact provider filter.
      const { provider: _provider, ...context } = request;
      const prefix = (request.prefix ?? '').toLowerCase();
      const names = Array.from(
        new Set(
          crossEntityRecords
            .filter(row => matches(row, context))
            .map(row => row.provider),
        ),
      )
        .filter(name => name.toLowerCase().startsWith(prefix))
        .sort();
      return page(names, request);
    },
    async getChangeFeed(request) {
      const rows = crossEntityRecords
        .filter(row => matches(row, request))
        .map(row => ({
          ...withoutSnapshot(row),
          ...parseEntityRef(row.entityRef),
        }));
      // Keep pages small so the real UI's Load older action is visible.
      return page(rows, request, 5);
    },
    async getEntityTimeline(request) {
      const rows = previewRecords
        .filter(row => matches(row, request))
        .map(withoutSnapshot);
      return page(rows, { ...request, limit: request.limit ?? 5 }, 5);
    },
    async getEntityDiff(request) {
      const find = (target: HistoryDiffTarget) =>
        crossEntityRecords.find(
          item => item.entityRef === request.entityRef && item.id === target.id,
        );
      const from = find(request.from);
      const to = find(request.to);
      if (!from || !to) throw new CatalogHistoryApiError(404);
      const diff: HistoryEntityDiffResponse = {
        entityRef: request.entityRef,
        from,
        to,
        changes: previewChanges(from.snapshot, to.snapshot),
      };
      return clone(diff);
    },
    async getEntityVersion(request) {
      const row = crossEntityRecords.find(
        item => item.entityRef === request.entityRef && item.id === request.id,
      );
      if (!row) throw new CatalogHistoryApiError(404);
      const history = crossEntityRecords.filter(
        item =>
          item.entityRef === row.entityRef &&
          item.source === row.source &&
          item.provider === row.provider,
      );
      const previousVersion = history[history.indexOf(row) + 1];
      const version: HistoryEntityVersionResponse = {
        ...row,
        previousVersion,
        changes: previousVersion?.snapshot
          ? crossEntityChanges[row.id]
          : undefined,
      };
      return clone(version);
    },
  };
}

// Callers must not be able to mutate the shared fixtures. A JSON copy also
// drops undefined fields, as an HTTP response would.
function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
