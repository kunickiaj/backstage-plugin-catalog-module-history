import type { DiscoveryApi, FetchApi } from '@backstage/core-plugin-api';
import { CatalogHistoryClient } from './CatalogHistoryClient';
import { CatalogHistoryApiError } from './CatalogHistoryApi';

function setup() {
  const getBaseUrl = jest
    .fn()
    .mockResolvedValue('https://catalog.example/api/catalog');
  const fetch = jest.fn().mockResolvedValue({
    ok: true,
    json: jest.fn().mockResolvedValue({ items: [] }),
  });
  const client = new CatalogHistoryClient({
    discoveryApi: { getBaseUrl } as unknown as DiscoveryApi,
    fetchApi: { fetch } as FetchApi,
  });
  return { client, fetch, getBaseUrl };
}

describe.each([
  ['entities', 'getEntities'],
  ['kinds', 'getKinds'],
] as const)('CatalogHistoryClient %s discovery', (endpoint, method) => {
  it('uses catalog discovery and authenticated fetch with default pagination', async () => {
    // Arrange
    const { client, fetch, getBaseUrl } = setup();
    const page =
      endpoint === 'entities'
        ? {
            items: [
              {
                entityRef: 'custom:other/deleted',
                kind: 'Custom',
                namespace: 'other',
                name: 'deleted',
              },
            ],
            nextCursor: 'opaque+/=',
          }
        : { items: ['Custom', 'deletedKind'], nextCursor: 'opaque+/=' };
    fetch.mockResolvedValue({
      ok: true,
      json: jest.fn().mockResolvedValue(page),
    });
    // Act
    const result = await client[method]({});
    // Assert
    expect(getBaseUrl).toHaveBeenCalledWith('catalog');
    expect(fetch).toHaveBeenCalledWith(
      `https://catalog.example/api/catalog/history/${endpoint}?limit=25`,
    );
    expect(result).toEqual(page);
  });

  it.each(["  MiXeD%_\\'雪 &?/  ", '   '])(
    'preserves literal prefix %j and opaque cursor',
    async prefix => {
      // Arrange
      const { client, fetch } = setup();
      const cursor = 'opaque+/=&?%';
      // Act
      await client[method]({ prefix, cursor, limit: 7 });
      // Assert
      expect(
        Object.fromEntries(new URL(fetch.mock.calls[0][0]).searchParams),
      ).toEqual({ prefix, cursor, limit: '7' });
    },
  );

  it('omits only empty prefix and clamps the page limit', async () => {
    // Arrange
    const { client, fetch } = setup();
    // Act
    await client[method]({ prefix: '', limit: 10000 });
    // Assert
    expect(
      Object.fromEntries(new URL(fetch.mock.calls[0][0]).searchParams),
    ).toEqual({ limit: '100' });
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    'rejects limit %s before discovery or fetch',
    async limit => {
      // Arrange
      const { client, fetch, getBaseUrl } = setup();
      // Act
      const result = client[method]({ limit });
      // Assert
      await expect(result).rejects.toThrow('positive integer');
      expect(getBaseUrl).not.toHaveBeenCalled();
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it.each([401, 403, 404, 500, 501])(
    'keeps HTTP %s typed without reading private or malformed error bodies',
    async status => {
      // Arrange
      const { client, fetch } = setup();
      const json = jest
        .fn()
        .mockRejectedValue(new Error('private malformed body'));
      fetch.mockResolvedValue({ ok: false, status, json });
      // Act
      const result = client[method]({});
      // Assert
      await expect(result).rejects.toEqual(new CatalogHistoryApiError(status));
      expect(json).not.toHaveBeenCalled();
      expect(fetch).toHaveBeenCalledTimes(1);
    },
  );

  it.each([401, 403, 404, 500, 501])(
    'does not cache or fall back after HTTP %s',
    async status => {
      // Arrange
      const { client, fetch } = setup();
      fetch.mockResolvedValueOnce({ ok: false, status });
      // Act
      const first = await client[method]({}).catch(error => error);
      const second = await client[method]({ prefix: 'retry' });
      // Assert
      expect(first).toEqual(new CatalogHistoryApiError(status));
      expect(second).toEqual({ items: [] });
      expect(fetch).toHaveBeenCalledTimes(2);
      expect(
        fetch.mock.calls.every(
          ([url]) =>
            new URL(url).pathname === `/api/catalog/history/${endpoint}`,
        ),
      ).toBe(true);
    },
  );

  it('treats an empty result as supported discovery', async () => {
    // Arrange
    const { client, fetch } = setup();
    // Act
    const result = await client[method]({ prefix: 'absent' });
    // Assert
    expect(result).toEqual({ items: [] });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

describe('CatalogHistoryClient discovery scope', () => {
  it('sends declared entity filters, preserving exact provider and microsecond date strings', async () => {
    // Arrange
    const { client, fetch } = setup();
    const filters = {
      prefix: '  User:Teams/Deleted  ',
      provider: '  MiXeD%_Provider  ',
      source: 'provider' as const,
      op: 'delete' as const,
      changedAfter: '2026-07-07T00:00:00.123456Z',
      changedBefore: '2026-07-07T01:00:00.987654+02:00',
      cursor: 'opaque+/=&?%',
    };
    // Act
    await client.getEntities({ ...filters, kind: ' uSeR ', limit: 7 });
    // Assert
    expect(
      Object.fromEntries(new URL(fetch.mock.calls[0][0]).searchParams),
    ).toEqual({ ...filters, kind: 'uSeR', limit: '7' });
  });

  it('does not serialize runtime context fields onto kind requests or entityRef onto discovery', async () => {
    // Arrange
    const { client, fetch } = setup();
    const runtime = {
      prefix: 'literal',
      source: 'provider' as const,
      provider: 'exact',
      kind: 'User',
      entityRef: 'User:Teams/Deleted',
      owner: 'team',
      op: 'delete' as const,
      changedAfter: '2026-07-07T00:00:00Z',
    };
    // Act
    await client.getKinds(runtime);
    await client.getEntities({
      ...runtime,
      entityRef: undefined,
      owner: undefined,
    });
    // Assert
    expect(
      Object.fromEntries(new URL(fetch.mock.calls[0][0]).searchParams),
    ).toEqual({ prefix: 'literal', limit: '25' });
    expect(new URL(fetch.mock.calls[1][0]).searchParams.has('entityRef')).toBe(
      false,
    );
    expect(new URL(fetch.mock.calls[1][0]).searchParams.has('owner')).toBe(
      false,
    );
  });

  it('keeps exact provider encoding on existing feed and timeline routes', async () => {
    // Arrange
    const { client, fetch } = setup();
    const provider = "  MiXeD%_\\'雪  ";
    // Act
    await client.getChangeFeed({ provider });
    await client.getEntityTimeline({ entityRef: 'Example', provider });
    // Assert
    expect(fetch).toHaveBeenCalledTimes(2);
    for (const [url] of fetch.mock.calls) {
      expect(Object.fromEntries(new URL(url).searchParams)).toEqual({
        limit: '25',
        provider,
      });
    }
  });
});
