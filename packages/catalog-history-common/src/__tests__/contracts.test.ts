import {
  DEFAULT_HISTORY_PAGE_LIMIT,
  HISTORY_MUTATION_TYPES,
  HISTORY_OPERATIONS,
  HISTORY_SOURCES,
  MAX_HISTORY_PAGE_LIMIT,
  isHistoryMutationType,
  isHistoryOperation,
  isHistorySource,
} from '../index';
import type {
  HistoryChangeFilter,
  HistoryCycleFilter,
  HistoryCycleDetailRequest,
  HistoryCycleDetailResponse,
  HistoryEntityAsOfResponse,
  HistoryEntityDiffResponse,
  HistoryEntitySnapshot,
  HistoryEntityVersion,
  HistoryFacetsResponse,
  HistoryCycle,
  HistoryPage,
  HistoryStatsResponse,
  HistoryTimelineItem,
} from '../index';

describe('history source and operation guards', () => {
  it('accepts every declared source', () => {
    for (const source of HISTORY_SOURCES) {
      expect(isHistorySource(source)).toBe(true);
    }
  });

  it('accepts every declared operation', () => {
    for (const op of HISTORY_OPERATIONS) {
      expect(isHistoryOperation(op)).toBe(true);
    }
  });

  it('accepts every declared mutation type', () => {
    for (const mutationType of HISTORY_MUTATION_TYPES) {
      expect(isHistoryMutationType(mutationType)).toBe(true);
    }
  });

  it.each([
    ['unknown string', 'stitcher'],
    ['empty string', ''],
    ['number', 42],
    ['null', null],
    ['undefined', undefined],
    ['object', { source: 'provider' }],
  ])('rejects %s as a source', (_label, value) => {
    expect(isHistorySource(value)).toBe(false);
  });

  it.each([
    ['unknown string', 'upsert'],
    ['number', 1],
    ['null', null],
  ])('rejects %s as an operation', (_label, value) => {
    expect(isHistoryOperation(value)).toBe(false);
  });

  it.each([
    ['unknown string', 'partial'],
    ['boolean', true],
    ['null', null],
  ])('rejects %s as a mutation type', (_label, value) => {
    expect(isHistoryMutationType(value)).toBe(false);
  });
});

describe('pagination constants', () => {
  it('keeps the default page limit within the maximum', () => {
    expect(DEFAULT_HISTORY_PAGE_LIMIT).toBeGreaterThan(0);
    expect(DEFAULT_HISTORY_PAGE_LIMIT).toBeLessThanOrEqual(
      MAX_HISTORY_PAGE_LIMIT,
    );
  });
});

describe('DTO shapes compile with representative payloads', () => {
  it('accepts a timeline page', () => {
    const page: HistoryPage<HistoryTimelineItem> = {
      items: [
        {
          id: '12345',
          cycleId: 'e2c0f6f0-0000-4000-8000-000000000000',
          entityRef: 'user:default/alice',
          source: 'provider',
          provider: 'okta',
          op: 'update',
          changedAt: '2026-07-06T08:00:00Z',
          etag: 'abc123',
          summary: { ownerChanged: true },
        },
      ],
      nextCursor: 'opaque-cursor',
    };
    expect(page.items).toHaveLength(1);
  });

  it('accepts a change filter scoped to an entity', () => {
    const filter: HistoryChangeFilter = {
      entityRef: 'user:default/alice',
      kind: 'User',
      owner: 'group:default/platform',
      source: 'reconciler',
      op: 'update',
      changedAfter: '2026-07-01T00:00:00Z',
    };
    expect(filter.entityRef).toBe('user:default/alice');
    expect(filter.owner).toBe('group:default/platform');
  });

  it('accepts a cycle with op-aligned counts', () => {
    const filter: HistoryCycleFilter = {
      provider: 'reconciler',
      source: 'reconciler',
      op: 'delete',
      mutationType: 'full',
      startedAfter: '2026-07-01T00:00:00Z',
    };
    const cycle: HistoryCycle = {
      cycleId: 'e2c0f6f0-0000-4000-8000-000000000000',
      provider: 'reconciler',
      source: 'reconciler',
      mutationType: 'full',
      startedAt: '2026-07-06T08:00:00Z',
      finishedAt: '2026-07-06T08:00:05Z',
      counts: { inserted: 1, updated: 2, deleted: 0, unchanged: 40 },
    };
    expect(filter.op).toBe('delete');
    expect(cycle.counts.unchanged).toBe(40);
  });

  it('accepts entity versions, snapshots, and as-of responses', () => {
    const snapshot: HistoryEntitySnapshot = {
      entityRef: 'component:default/service-a',
      kind: 'Component',
      namespace: 'default',
      name: 'service-a',
      etag: 'etag-1',
      owner: 'group:default/platform',
      metadata: { name: 'service-a' },
      spec: { type: 'service', lifecycle: 'production' },
      relations: [{ type: 'ownedBy', targetRef: 'group:default/platform' }],
      statusItems: [{ type: 'backstage.io/catalog-processing', level: 'info' }],
      orphan: false,
    };
    const version: HistoryEntityVersion = {
      id: '10',
      cycleId: 'cycle-1',
      entityRef: snapshot.entityRef,
      source: 'reconciler',
      provider: 'reconciler',
      op: 'update',
      changedAt: '2026-07-06T08:00:00Z',
      etag: 'etag-1',
      summary: {},
      snapshot,
    };
    const asOf: HistoryEntityAsOfResponse = {
      entityRef: snapshot.entityRef,
      asOf: '2026-07-06T09:00:00Z',
      version,
      snapshot,
    };

    expect(asOf.snapshot?.owner).toBe('group:default/platform');
  });

  it('accepts cycle detail, diff, facets, and stats responses', () => {
    const cycle: HistoryCycle = {
      cycleId: 'cycle-1',
      provider: 'reconciler',
      source: 'reconciler',
      mutationType: 'full',
      startedAt: '2026-07-06T08:00:00Z',
      finishedAt: '2026-07-06T08:00:05Z',
      counts: { inserted: 1, updated: 0, deleted: 0, unchanged: 10 },
    };
    const detail: HistoryCycleDetailResponse = {
      cycle,
      changes: {
        items: [
          {
            id: '11',
            cycleId: 'cycle-1',
            entityRef: 'user:default/alice',
            kind: 'User',
            namespace: 'default',
            name: 'alice',
            source: 'reconciler',
            provider: 'reconciler',
            op: 'insert',
            changedAt: '2026-07-06T08:00:05Z',
            summary: {},
          },
        ],
      },
    };
    const diff: HistoryEntityDiffResponse = {
      entityRef: 'user:default/alice',
      changes: [
        {
          path: ['spec', 'profile', 'displayName'],
          op: 'replace',
          before: 'Alice A.',
          after: 'Alice Example',
        },
      ],
    };
    const facets: HistoryFacetsResponse = {
      sources: [{ value: 'reconciler', count: 1 }],
      providers: [{ value: 'reconciler', count: 1 }],
      operations: [{ value: 'insert', count: 1 }],
      mutationTypes: [{ value: 'full', count: 1 }],
      kinds: [{ value: 'User', count: 1 }],
    };
    const stats: HistoryStatsResponse = {
      totals: cycle.counts,
      buckets: [{ key: 'reconciler', counts: cycle.counts }],
    };
    const detailRequest: HistoryCycleDetailRequest = {
      cycleId: 'cycle-1',
      limit: 50,
      cursor: 'next-change-page',
    };

    expect(detail.changes.items[0].kind).toBe('User');
    expect(detailRequest.cursor).toBe('next-change-page');
    expect(diff.changes[0].path).toEqual(['spec', 'profile', 'displayName']);
    expect(facets.sources[0].value).toBe('reconciler');
    expect(stats.totals.inserted).toBe(1);
  });
});
