import type { DiscoveryApi, FetchApi } from '@backstage/core-plugin-api';
import { CatalogHistoryClient } from './CatalogHistoryClient';
import { CatalogHistoryApiError } from './CatalogHistoryApi';

function setup() {
  const getBaseUrl = jest
    .fn()
    .mockResolvedValue('https://catalog.example/api/catalog');
  const fetch = jest.fn().mockResolvedValue({
    ok: true,
    json: jest.fn().mockResolvedValue({
      items: ['MiXeD', 'retired'],
      nextCursor: 'opaque+/=',
    }),
  });
  const client = new CatalogHistoryClient({
    discoveryApi: { getBaseUrl } as unknown as DiscoveryApi,
    fetchApi: { fetch } as FetchApi,
  });
  return { client, fetch, getBaseUrl };
}

describe('CatalogHistoryClient provider discovery', () => {
  it('discovers catalog and returns the provider page through authenticated fetch', async () => {
    // Arrange
    const { client, fetch, getBaseUrl } = setup();
    // Act
    const result = await client.getProviders({});
    // Assert
    expect(getBaseUrl).toHaveBeenCalledWith('catalog');
    expect(fetch).toHaveBeenCalledWith(
      'https://catalog.example/api/catalog/history/providers?limit=25',
    );
    expect(result).toEqual({
      items: ['MiXeD', 'retired'],
      nextCursor: 'opaque+/=',
    });
  });

  it('round-trips literal prefix and every declared scope field without an exact provider filter', async () => {
    // Arrange
    const { client, fetch } = setup();
    const filters = {
      prefix: "  MiXeD%_\\'雪 &?/  ",
      source: 'provider' as const,
      op: 'delete' as const,
      changedAfter: '2026-07-07T00:00:00.123456Z',
      changedBefore: '2026-07-07T01:00:00.987654+02:00',
      cursor: 'opaque+/=&?%',
    };
    // Act
    await client.getProviders({
      ...filters,
      entityRef: 'User:Teams/Retired',
      kind: ' uSeR ',
      limit: 7,
    });
    // Assert
    const url = new URL(fetch.mock.calls[0][0]);
    expect(url.pathname).toBe('/api/catalog/history/providers');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      ...filters,
      entityRef: 'user:teams/retired',
      kind: 'uSeR',
      limit: '7',
    });
    expect(url.searchParams.has('provider')).toBe(false);
  });

  it('omits an empty prefix, canonicalizes short references, and clamps limits', async () => {
    // Arrange
    const { client, fetch } = setup();
    // Act
    await client.getProviders({
      prefix: '',
      entityRef: 'Example',
      limit: 10000,
    });
    // Assert
    expect(
      Object.fromEntries(new URL(fetch.mock.calls[0][0]).searchParams),
    ).toEqual({ entityRef: 'component:default/example', limit: '100' });
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    'rejects invalid limit %s before discovery or fetch',
    async limit => {
      // Arrange
      const { client, fetch, getBaseUrl } = setup();
      // Act
      const result = client.getProviders({ limit });
      // Assert
      await expect(result).rejects.toThrow('positive integer');
      expect(getBaseUrl).not.toHaveBeenCalled();
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it.each([401, 403, 404, 500, 501])(
    'preserves HTTP %s with only the generic client error',
    async status => {
      // Arrange
      const { client, fetch } = setup();
      const json = jest.fn().mockResolvedValue({
        error: 'SELECT private-provider secret-bindings',
      });
      fetch.mockResolvedValue({ ok: false, status, json });
      // Act
      const result = client.getProviders({ prefix: 'private-provider' });
      // Assert
      await expect(result).rejects.toEqual(new CatalogHistoryApiError(status));
      expect(json).not.toHaveBeenCalled();
      expect(fetch).toHaveBeenCalledTimes(1);
    },
  );

  it.each([404, 501])(
    'does not cache unsupported status %s or fall back to another endpoint',
    async status => {
      // Arrange
      const { client, fetch } = setup();
      fetch.mockResolvedValue({ ok: false, status });
      // Act
      const first = await client.getProviders({}).catch(error => error);
      const second = await client
        .getProviders({ prefix: 'new' })
        .catch(error => error);
      // Assert
      expect(first).toEqual(new CatalogHistoryApiError(status));
      expect(second).toEqual(new CatalogHistoryApiError(status));
      expect(fetch).toHaveBeenCalledTimes(2);
      expect(
        fetch.mock.calls.every(
          ([url]) => new URL(url).pathname === '/api/catalog/history/providers',
        ),
      ).toBe(true);
    },
  );

  it('treats an empty page as supported discovery', async () => {
    // Arrange
    const { client, fetch } = setup();
    fetch.mockResolvedValue({
      ok: true,
      json: jest.fn().mockResolvedValue({ items: [] }),
    });
    // Act
    const result = await client.getProviders({ prefix: 'no-match' });
    // Assert
    expect(result).toEqual({ items: [] });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('preserves exact provider serialization on feed and timeline without adding prefix', async () => {
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
      expect(new URL(url).pathname).not.toContain('/providers');
    }
  });
});
