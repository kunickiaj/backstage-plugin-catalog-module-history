import type { DiscoveryApi, FetchApi } from '@backstage/core-plugin-api';
import { CatalogHistoryClient } from './CatalogHistoryClient';
import { CatalogHistoryApiError } from './CatalogHistoryApi';

function setup() {
  const getBaseUrl = jest
    .fn()
    .mockResolvedValue('https://catalog.example/api/catalog');
  const fetch = jest.fn().mockResolvedValue({
    ok: true,
    json: jest.fn().mockResolvedValue({ items: [], nextCursor: 'opaque+/=' }),
  });
  const client = new CatalogHistoryClient({
    discoveryApi: { getBaseUrl } as unknown as DiscoveryApi,
    fetchApi: { fetch } as FetchApi,
  });
  return { client, fetch, getBaseUrl };
}

describe('CatalogHistoryClient', () => {
  it('discovers catalog and reads a normalized entity ref through authenticated fetch', async () => {
    // Arrange: Backstage supplies discovery and authentication, not a manual token.
    const { client, fetch, getBaseUrl } = setup();

    // Act
    const result = await client.getEntityTimeline({
      entityRef: 'Component:Default/Example',
    });

    // Assert
    expect(getBaseUrl).toHaveBeenCalledWith('catalog');
    expect(fetch).toHaveBeenCalledWith(
      'https://catalog.example/api/catalog/history/entities/component/default/example/history?limit=25',
    );
    expect(result).toEqual({ items: [], nextCursor: 'opaque+/=' });
  });

  it('defaults omitted namespace and encodes path and query values separately', async () => {
    // Arrange
    const { client, fetch } = setup();
    const cursor = 'opaque+/=&?%';
    const changedAt = '2026-10-23T12:00:00.000Z';

    // Act: equal inclusive boundaries must survive unchanged.
    await client.getEntityTimeline({
      entityRef: 'component:a name?#%',
      source: 'provider',
      provider: 'team & service/one',
      op: 'delete',
      changedAfter: changedAt,
      changedBefore: changedAt,
      limit: 7,
      cursor,
    });

    // Assert
    const url = new URL(fetch.mock.calls[0][0]);
    expect(url.pathname).toBe(
      '/api/catalog/history/entities/component/default/a%20name%3F%23%25/history',
    );
    expect(Object.fromEntries(url.searchParams)).toEqual({
      limit: '7',
      source: 'provider',
      provider: 'team & service/one',
      op: 'delete',
      changedAfter: changedAt,
      changedBefore: changedAt,
      cursor,
    });
  });

  it('encodes every entity path component and the exact version ID without timeline queries', async () => {
    // Arrange
    const { client, fetch } = setup();

    // Act
    await client.getEntityVersion({
      entityRef: 'custom kind:team space/a name',
      id: 'row/+/=&?#%',
    });

    // Assert
    expect(fetch).toHaveBeenCalledWith(
      'https://catalog.example/api/catalog/history/entities/custom%20kind/team%20space/a%20name/versions/row%2F%2B%2F%3D%26%3F%23%25',
    );
  });

  it.each([0, -1, 1.5, Number.NaN])(
    'rejects invalid page limit %s before making requests',
    async limit => {
      // Arrange
      const { client, fetch, getBaseUrl } = setup();

      // Act
      const result = client.getEntityTimeline({
        entityRef: 'component:default/example',
        limit,
      });

      // Assert
      await expect(result).rejects.toThrow('positive integer');
      expect(fetch).not.toHaveBeenCalled();
      expect(getBaseUrl).not.toHaveBeenCalled();
    },
  );

  it('caps an oversized page request', async () => {
    // Arrange
    const { client, fetch } = setup();

    // Act
    await client.getEntityTimeline({
      entityRef: 'component:default/example',
      limit: 10000,
    });

    // Assert
    expect(new URL(fetch.mock.calls[0][0]).searchParams.get('limit')).toBe(
      '100',
    );
  });

  it.each([401, 403, 404, 500])(
    'maps HTTP %s without reading or exposing the backend body',
    async status => {
      // Arrange
      const { client, fetch } = setup();
      const json = jest
        .fn()
        .mockResolvedValue({ error: 'private database credentials' });
      fetch.mockResolvedValue({ ok: false, status, json });

      // Act
      const result = client.getEntityTimeline({
        entityRef: 'component:default/example',
      });

      // Assert
      await expect(result).rejects.toEqual(new CatalogHistoryApiError(status));
      expect(json).not.toHaveBeenCalled();
    },
  );

  it('uses the same safe HTTP error contract for version reads', async () => {
    // Arrange
    const { client, fetch } = setup();
    fetch.mockResolvedValue({ ok: false, status: 404 });

    // Act
    const result = client.getEntityVersion({
      entityRef: 'component:default/example',
      id: 'missing',
    });

    // Assert
    await expect(result).rejects.toMatchObject({
      name: 'CatalogHistoryApiError',
      status: 404,
    });
  });
});
