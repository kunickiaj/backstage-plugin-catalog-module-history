import { InMemoryHistoryQueryService } from '../InMemoryHistoryQueryService';

describe('InMemoryHistoryQueryService', () => {
  it('records each request and returns each configured response', async () => {
    const service = new InMemoryHistoryQueryService();
    service.entityTimeline = { items: [], nextCursor: 'timeline-next' };
    service.entityVersions = { items: [], nextCursor: 'versions-next' };
    service.entityAsOf = {
      entityRef: 'user:default/alice',
      asOf: '2026-07-07T00:00:00Z',
    };
    service.entityDiff = {
      entityRef: 'user:default/alice',
      changes: [{ path: ['spec'], op: 'replace', before: {}, after: {} }],
    };
    service.cycleList = { items: [], nextCursor: 'cycles-next' };
    service.cycleDetail = {
      cycle: {
        cycleId: 'cycle-1',
        provider: 'okta',
        source: 'provider',
        mutationType: 'full',
        startedAt: '2026-07-07T00:00:00Z',
        finishedAt: '2026-07-07T00:00:01Z',
        counts: { inserted: 1, updated: 0, deleted: 0, unchanged: 0 },
      },
      changes: { items: [], nextCursor: 'cycle-changes-next' },
    };
    service.changeFeed = { items: [], nextCursor: 'changes-next' };
    service.facets = {
      sources: [{ value: 'provider', count: 1 }],
      providers: [{ value: 'okta', count: 1 }],
      operations: [{ value: 'insert', count: 1 }],
      mutationTypes: [{ value: 'full', count: 1 }],
      kinds: [{ value: 'User', count: 1 }],
    };
    service.stats = {
      totals: { inserted: 1, updated: 0, deleted: 0, unchanged: 0 },
      buckets: [],
    };

    const cases = [
      {
        call: () =>
          service.getEntityTimeline({
            entityRef: 'user:default/alice',
            limit: 1,
          }),
        response: service.entityTimeline,
        requests: service.requests.entityTimeline,
        expected: [{ entityRef: 'user:default/alice', limit: 1 }],
      },
      {
        call: () =>
          service.getEntityVersions({ entityRef: 'user:default/alice' }),
        response: service.entityVersions,
        requests: service.requests.entityVersions,
        expected: [{ entityRef: 'user:default/alice' }],
      },
      {
        call: () =>
          service.getEntityAsOf({
            entityRef: 'user:default/alice',
            timestamp: '2026-07-07T00:00:00Z',
          }),
        response: service.entityAsOf,
        requests: service.requests.entityAsOf,
        expected: [
          {
            entityRef: 'user:default/alice',
            timestamp: '2026-07-07T00:00:00Z',
          },
        ],
      },
      {
        call: () =>
          service.getEntityDiff({
            entityRef: 'user:default/alice',
            from: { kind: 'history-row', id: '1' },
            to: { kind: 'history-row', id: '2' },
          }),
        response: service.entityDiff,
        requests: service.requests.entityDiff,
        expected: [
          {
            entityRef: 'user:default/alice',
            from: { kind: 'history-row', id: '1' },
            to: { kind: 'history-row', id: '2' },
          },
        ],
      },
      {
        call: () => service.listCycles({ source: 'provider' }),
        response: service.cycleList,
        requests: service.requests.cycleList,
        expected: [{ source: 'provider' }],
      },
      {
        call: () => service.getCycle({ cycleId: 'cycle-1', limit: 10 }),
        response: service.cycleDetail,
        requests: service.requests.cycleDetail,
        expected: [{ cycleId: 'cycle-1', limit: 10 }],
      },
      {
        call: () => service.getChangeFeed({ kind: 'User' }),
        response: service.changeFeed,
        requests: service.requests.changeFeed,
        expected: [{ kind: 'User' }],
      },
      {
        call: () => service.getFacets({ source: 'provider' }),
        response: service.facets,
        requests: service.requests.facets,
        expected: [{ source: 'provider' }],
      },
      {
        call: () => service.getStats({ groupBy: 'source' }),
        response: service.stats,
        requests: service.requests.stats,
        expected: [{ groupBy: 'source' }],
      },
    ];

    for (const testCase of cases) {
      await expect(testCase.call()).resolves.toBe(testCase.response);
      expect(testCase.requests).toEqual(testCase.expected);
    }
  });
});
