import type {
  HistoryChangeFeedRequest,
  HistoryCycle,
  HistoryCycleChange,
  HistoryCycleFilter,
  HistoryCycleListRequest,
  HistoryDiffEntry,
  HistoryDiffTarget,
  HistoryEntityDiffResponse,
  HistoryEntitySnapshot,
  HistoryPage,
  HistoryPageOptions,
  HistoryEntityIdentity,
  HistoryEntitySearchRequest,
  HistoryEntitySearchResponse,
  HistoryEntityVersion,
  HistoryEntityVersionResponse,
  HistoryKindSearchRequest,
  HistoryKindSearchResponse,
  HistoryProviderSearchRequest,
  HistoryProviderSearchResponse,
} from '@kunickiaj/backstage-plugin-catalog-history-common';
import {
  DEFAULT_HISTORY_PAGE_LIMIT,
  isHistoryMutationType,
  isHistoryOperation,
  isHistorySource,
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

type DiscoveryEndpoint = 'entities' | 'kinds';

function compareBinary(left: string, right: string) {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function discoveryOptions(request: HistoryKindSearchRequest) {
  const limit =
    request.limit === undefined ? DEFAULT_HISTORY_PAGE_LIMIT : request.limit;
  if (
    !Number.isInteger(limit) ||
    limit < 1 ||
    (request.prefix !== undefined && typeof request.prefix !== 'string')
  ) {
    throw new CatalogHistoryApiError(400);
  }
  return {
    limit: Math.min(limit, MAX_HISTORY_PAGE_LIMIT),
    prefix: request.prefix ?? '',
  };
}

function discoveryCursorAfter(
  cursor: string | undefined,
  endpoint: DiscoveryEndpoint,
  scope: string,
): string[] | undefined {
  if (cursor === undefined) return undefined;
  const prefix = `preview-${endpoint}:`;
  try {
    if (typeof cursor !== 'string' || !cursor.startsWith(prefix)) {
      throw new CatalogHistoryApiError(400);
    }
    const decoded: unknown = JSON.parse(
      decodeURIComponent(cursor.slice(prefix.length)),
    );
    if (typeof decoded !== 'object' || decoded === null) {
      throw new CatalogHistoryApiError(400);
    }
    const value = decoded as Record<string, unknown>;
    const anchorSize = endpoint === 'entities' ? 2 : 1;
    if (
      value.version !== 1 ||
      value.type !== endpoint ||
      value.scope !== scope ||
      !Array.isArray(value.anchor) ||
      value.anchor.length !== anchorSize ||
      !value.anchor.every((part: unknown) => typeof part === 'string')
    ) {
      throw new CatalogHistoryApiError(400);
    }
    return value.anchor;
  } catch {
    throw new CatalogHistoryApiError(400);
  }
}

function discoveryCursor(
  endpoint: DiscoveryEndpoint,
  scope: string,
  anchor: string[],
) {
  const payload = encodeURIComponent(
    JSON.stringify({ version: 1, type: endpoint, scope, anchor }),
  );
  return `preview-${endpoint}:${payload}`;
}

function identity(row: HistoryEntityVersion): HistoryEntityIdentity {
  const parsed = parseEntityRef(row.entityRef);
  // Missing snapshots simulate stored tombstone identity, never a live catalog lookup.
  const { kind, namespace, name } = row.snapshot ?? parsed;
  return { entityRef: stringifyEntityRef(parsed), kind, namespace, name };
}

function entityContext(request: HistoryEntitySearchRequest) {
  // Do not pass selected entityRef or unsupported owner to the history matcher.
  const context: HistoryChangeFeedRequest = {
    kind: request.kind,
    source: request.source,
    provider: request.provider,
    op: request.op,
    changedAfter: request.changedAfter,
    changedBefore: request.changedBefore,
  };
  if (
    Object.values(context).some(
      value => value !== undefined && typeof value !== 'string',
    )
  ) {
    throw new CatalogHistoryApiError(400);
  }
  return context;
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

function cycleLimit(request: HistoryPageOptions): number {
  const limit =
    request.limit === undefined ? DEFAULT_HISTORY_PAGE_LIMIT : request.limit;
  if (!Number.isInteger(limit) || limit < 1) {
    throw new CatalogHistoryApiError(400);
  }
  return Math.min(limit, MAX_HISTORY_PAGE_LIMIT);
}

function cycleContext(request: HistoryCycleListRequest): HistoryCycleFilter {
  const context = {
    source: request.source,
    provider: request.provider,
    op: request.op,
    mutationType: request.mutationType,
    startedAfter: request.startedAfter,
    startedBefore: request.startedBefore,
    finishedAfter: request.finishedAfter,
    finishedBefore: request.finishedBefore,
  };
  const dates = [
    context.startedAfter,
    context.startedBefore,
    context.finishedAfter,
    context.finishedBefore,
  ];
  if (
    Object.values(context).some(
      value => value !== undefined && typeof value !== 'string',
    ) ||
    (context.source !== undefined && !isHistorySource(context.source)) ||
    (context.op !== undefined && !isHistoryOperation(context.op)) ||
    (context.mutationType !== undefined &&
      !isHistoryMutationType(context.mutationType)) ||
    dates.some(
      value => value !== undefined && !Number.isFinite(Date.parse(value)),
    )
  ) {
    throw new CatalogHistoryApiError(400);
  }
  return context;
}

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

type CycleEndpoint = 'cycles' | 'cycle-changes';

function cycleCursorAfter(
  cursor: string | undefined,
  endpoint: CycleEndpoint,
  scope: string,
): string[] | undefined {
  if (cursor === undefined) return undefined;
  const prefix = `preview-${endpoint}:`;
  try {
    if (typeof cursor !== 'string' || !cursor.startsWith(prefix)) {
      throw new CatalogHistoryApiError(400);
    }
    const decoded: unknown = JSON.parse(
      decodeURIComponent(cursor.slice(prefix.length)),
    );
    if (typeof decoded !== 'object' || decoded === null) {
      throw new CatalogHistoryApiError(400);
    }
    const value = decoded as Record<string, unknown>;
    if (
      value.version !== 1 ||
      value.type !== endpoint ||
      value.scope !== scope ||
      !Array.isArray(value.anchor) ||
      value.anchor.length !== 2 ||
      !value.anchor.every(
        (part: unknown) => typeof part === 'string' && part.length > 0,
      )
    ) {
      throw new CatalogHistoryApiError(400);
    }
    return value.anchor;
  } catch {
    throw new CatalogHistoryApiError(400);
  }
}

function cyclePage<T>(
  rows: T[],
  request: HistoryPageOptions,
  endpoint: CycleEndpoint,
  scope: string,
  anchor: (item: T) => string[],
): HistoryPage<T> {
  const limit = cycleLimit(request);
  const after = cycleCursorAfter(request.cursor, endpoint, scope);
  const index =
    after === undefined
      ? -1
      : rows.findIndex(item =>
          anchor(item).every((part, i) => part === after[i]),
        );
  if (after !== undefined && index === -1) {
    throw new CatalogHistoryApiError(400);
  }
  const lookahead = rows.slice(index + 1, index + 1 + limit + 1);
  const items = lookahead.slice(0, limit);
  const nextCursor =
    lookahead.length > limit
      ? `preview-${endpoint}:${encodeURIComponent(
          JSON.stringify({
            version: 1,
            type: endpoint,
            scope,
            anchor: anchor(items[items.length - 1]),
          }),
        )}`
      : undefined;
  return { items, nextCursor };
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
      const context = cycleContext(request);
      const scope = JSON.stringify({
        ...context,
        sort: 'startedAt-desc,id-desc',
      });
      // Binary opaque-ID ties apply only to these static fixtures, not PG UUIDs.
      const rows = cycleLedger
        .filter(cycle => cycleMatches(cycle, context))
        .map(cycle => ({ ...cycle, counts: { ...cycle.counts } }))
        .sort(
          (a, b) =>
            Date.parse(b.startedAt) - Date.parse(a.startedAt) ||
            compareBinary(b.cycleId, a.cycleId),
        );
      return cyclePage(rows, request, 'cycles', scope, cycle => [
        cycle.startedAt,
        cycle.cycleId,
      ]);
    },
    async getCycle(request) {
      if (typeof request.cycleId !== 'string' || request.cycleId.length === 0) {
        throw new CatalogHistoryApiError(400);
      }
      cycleLimit(request);
      const scope = JSON.stringify({
        cycleId: request.cycleId,
        sort: 'changedAt-desc,id-desc',
      });
      cycleCursorAfter(request.cursor, 'cycle-changes', scope);
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
      return {
        cycle: { ...cycle, counts: { ...cycle.counts } },
        changes: cyclePage(rows, request, 'cycle-changes', scope, row => [
          row.changedAt,
          row.id,
        ]),
      };
    },
    async getEntities(
      request: HistoryEntitySearchRequest,
    ): Promise<HistoryEntitySearchResponse> {
      try {
        const { limit, prefix } = discoveryOptions(request);
        const context = entityContext(request);
        const scope = JSON.stringify({ prefix, ...context });
        const after = discoveryCursorAfter(request.cursor, 'entities', scope);
        const names = entityIdentities(context, prefix).filter(item => {
          if (after === undefined) return true;
          const nameOrder = compareBinary(item.name.toLowerCase(), after[0]);
          return (
            nameOrder > 0 || (nameOrder === 0 && item.entityRef > after[1])
          );
        });
        const items = names.slice(0, limit);
        const last = items[items.length - 1];
        const nextCursor =
          names.length > items.length
            ? discoveryCursor('entities', scope, [
                last.name.toLowerCase(),
                last.entityRef,
              ])
            : undefined;
        return { items, nextCursor };
      } catch {
        throw new CatalogHistoryApiError(400);
      }
    },
    async getKinds(
      request: HistoryKindSearchRequest,
    ): Promise<HistoryKindSearchResponse> {
      try {
        const { limit, prefix } = discoveryOptions(request);
        // Kind discovery is global; no runtime history context is spread here.
        const scope = JSON.stringify({ prefix });
        const after = discoveryCursorAfter(request.cursor, 'kinds', scope);
        const names = retainedKinds(prefix).filter(
          kind => after === undefined || kind.toLowerCase() > after[0],
        );
        const items = names.slice(0, limit);
        const nextCursor =
          names.length > items.length
            ? discoveryCursor('kinds', scope, [
                items[items.length - 1].toLowerCase(),
              ])
            : undefined;
        return { items, nextCursor };
      } catch {
        throw new CatalogHistoryApiError(400);
      }
    },
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
    getEntityDiff(request) {
      const find = (target: HistoryDiffTarget) =>
        target.kind === 'history-row'
          ? crossEntityRecords.find(
              item =>
                item.entityRef === request.entityRef && item.id === target.id,
            )
          : undefined;
      const from = find(request.from);
      const to = find(request.to);
      if (!from || !to) return Promise.reject(new CatalogHistoryApiError(404));
      return Promise.resolve(
        JSON.parse(
          JSON.stringify({
            entityRef: request.entityRef,
            from,
            to,
            changes: previewChanges(from.snapshot, to.snapshot),
          }),
        ) as HistoryEntityDiffResponse,
      );
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
