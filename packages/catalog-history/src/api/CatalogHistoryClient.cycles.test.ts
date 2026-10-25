import type { DiscoveryApi, FetchApi } from '@backstage/core-plugin-api';
import type {
  HistoryCycle,
  HistoryCycleDetailResponse,
} from '@kunickiaj/backstage-plugin-catalog-history-common';
import { CatalogHistoryClient } from './CatalogHistoryClient';
import { CatalogHistoryApiError } from './CatalogHistoryApi';

const cycle: HistoryCycle = {
  cycleId: 'a1234567-89ab-cdef-0123-456789abcdef',
  provider: '  MiXeD provider  ',
  source: 'provider',
  mutationType: 'delta',
  startedAt: '2026-07-07T00:00:00.123456Z',
  finishedAt: '2026-07-07T02:00:01.987654+02:00',
  counts: { inserted: 12, updated: 5, deleted: 3, unchanged: 10 },
};

function setup() {
  const getBaseUrl = jest
    .fn()
    .mockResolvedValue('https://catalog.example/api/catalog');
  const fetch = jest.fn().mockResolvedValue({
    ok: true,
    json: jest.fn().mockResolvedValue({ items: [cycle] }),
  });
  const client = new CatalogHistoryClient({
    discoveryApi: { getBaseUrl } as unknown as DiscoveryApi,
    fetchApi: { fetch } as FetchApi,
  });
  return { client, fetch, getBaseUrl };
}

describe('CatalogHistoryClient cycle reads', () => {
  it('lists recorded headers with default pagination through catalog discovery', async () => {
    // Arrange
    const { client, fetch, getBaseUrl } = setup();
    // Act
    const result = await client.listCycles({});
    // Assert
    expect(getBaseUrl).toHaveBeenCalledWith('catalog');
    expect(fetch).toHaveBeenCalledWith(
      'https://catalog.example/api/catalog/history/cycles?limit=25',
    );
    expect(result).toEqual({ items: [cycle] });
  });

  it('serializes only cycle filters and preserves raw provider, dates, and cursor', async () => {
    // Arrange
    const { client, fetch } = setup();
    const filters = {
      source: 'processing' as const,
      provider: "  MiXeD%_\\'雪 &?/  ",
      op: 'delete' as const,
      mutationType: 'full' as const,
      startedAfter: '2026-07-07T01:00:00.123456+02:00',
      startedBefore: '2026-07-07T00:00:00.987654Z',
      finishedAfter: '2026-07-07T02:00:00.123456+02:00',
      finishedBefore: '2026-07-07T01:00:00.987654Z',
      cursor: 'opaque+/=&?%',
    };
    const request = {
      ...filters,
      limit: 7,
      prefix: 'leak',
      kind: 'User',
      entityRef: 'secret',
      owner: 'team',
      changedAfter: 'old',
      unknown: 'leak',
    };
    // Act
    await client.listCycles(request);
    // Assert
    const url = new URL(fetch.mock.calls[0][0]);
    expect(url.pathname).toBe('/api/catalog/history/cycles');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      ...filters,
      limit: '7',
    });
  });

  it.each([
    cycle.cycleId,
    cycle.cycleId.toUpperCase(),
    '00000000-0000-0000-0000-000000000000',
    'ffffffff-ffff-ffff-ffff-ffffffffffff',
  ])('encodes detail path %s and emits pagination only', async cycleId => {
    // Arrange
    const { client, fetch } = setup();
    const input = {
      cycleId,
      limit: 1000,
      cursor: 'opaque+/=&?%',
      provider: 'leak',
      source: 'provider',
      prefix: 'leak',
      kind: 'User',
      entityRef: 'leak',
    };
    // Act
    await client.getCycle(input);
    // Assert
    const url = new URL(fetch.mock.calls[0][0]);
    expect(url.pathname).toBe(
      `/api/catalog/history/cycles/${encodeURIComponent(cycleId)}`,
    );
    expect(Object.fromEntries(url.searchParams)).toEqual({
      limit: '100',
      cursor: input.cursor,
    });
  });

  it('returns recorded detail metadata unchanged rather than computing page counts', async () => {
    // Arrange
    const { client, fetch } = setup();
    const detail: HistoryCycleDetailResponse = {
      cycle,
      changes: {
        items: [
          {
            id: '9223372036854775806',
            cycleId: cycle.cycleId,
            entityRef: 'user:teams/retired',
            kind: 'User',
            namespace: 'teams',
            name: 'retired',
            source: 'provider',
            provider: cycle.provider,
            op: 'delete',
            changedAt: cycle.finishedAt,
            summary: {},
          },
        ],
        nextCursor: 'next-opaque',
      },
    };
    fetch.mockResolvedValue({
      ok: true,
      json: jest.fn().mockResolvedValue(detail),
    });
    // Act
    const result = await client.getCycle({ cycleId: cycle.cycleId });
    // Assert
    expect(result).toEqual(detail);
    expect(fetch).toHaveBeenCalledWith(
      `https://catalog.example/api/catalog/history/cycles/${cycle.cycleId}?limit=25`,
    );
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('returns empty list and heartbeat changes as supported responses', async () => {
    // Arrange
    const { client, fetch } = setup();
    const heartbeat = {
      cycle: {
        ...cycle,
        counts: { inserted: 0, updated: 0, deleted: 0, unchanged: 10 },
      },
      changes: { items: [] },
    };
    fetch
      .mockResolvedValueOnce({
        ok: true,
        json: jest.fn().mockResolvedValue({ items: [] }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: jest.fn().mockResolvedValue(heartbeat),
      });
    // Act
    const list = await client.listCycles({ limit: 1000 });
    const detail = await client.getCycle({ cycleId: cycle.cycleId });
    // Assert
    expect(list).toEqual({ items: [] });
    expect(detail).toEqual(heartbeat);
    expect(new URL(fetch.mock.calls[0][0]).searchParams.get('limit')).toBe(
      '100',
    );
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});

describe.each(['listCycles', 'getCycle'] as const)(
  '%s client failures',
  method => {
    it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
      'rejects invalid limit %s before discovery/fetch',
      async limit => {
        // Arrange
        const { client, fetch, getBaseUrl } = setup();
        // Act
        const result = client[method]({ cycleId: cycle.cycleId, limit });
        // Assert
        await expect(result).rejects.toThrow('positive integer');
        expect(fetch).not.toHaveBeenCalled();
        expect(getBaseUrl).not.toHaveBeenCalled();
      },
    );

    it.each([401, 403, 404, 500, 501])(
      'preserves HTTP %s without parsing error bodies or caching failures',
      async status => {
        // Arrange
        const { client, fetch } = setup();
        const json = jest.fn().mockResolvedValue({
          error: 'SELECT private-provider secret-bindings',
        });
        fetch.mockResolvedValue({ ok: false, status, json });
        // Act
        const results = await Promise.allSettled([
          client[method]({ cycleId: cycle.cycleId }),
          client[method]({ cycleId: cycle.cycleId }),
        ]);
        // Assert
        expect(results).toEqual([
          { status: 'rejected', reason: new CatalogHistoryApiError(status) },
          { status: 'rejected', reason: new CatalogHistoryApiError(status) },
        ]);
        expect(json).not.toHaveBeenCalled();
        expect(fetch).toHaveBeenCalledTimes(2);
        expect(
          fetch.mock.calls.every(([url]) =>
            new URL(url).pathname.startsWith('/api/catalog/history/cycles'),
          ),
        ).toBe(true);
      },
    );
  },
);
