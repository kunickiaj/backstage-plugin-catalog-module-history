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
  HistoryCycle,
  HistoryPage,
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
      source: 'reconciler',
      op: 'update',
      changedAfter: '2026-07-01T00:00:00Z',
    };
    expect(filter.entityRef).toBe('user:default/alice');
  });

  it('accepts a cycle with op-aligned counts', () => {
    const cycle: HistoryCycle = {
      cycleId: 'e2c0f6f0-0000-4000-8000-000000000000',
      provider: 'reconciler',
      source: 'reconciler',
      mutationType: 'full',
      startedAt: '2026-07-06T08:00:00Z',
      finishedAt: '2026-07-06T08:00:05Z',
      counts: { inserted: 1, updated: 2, deleted: 0, unchanged: 40 },
    };
    expect(cycle.counts.unchanged).toBe(40);
  });
});
