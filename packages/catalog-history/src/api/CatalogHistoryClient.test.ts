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
  it('requests a diff of two rows under the canonical entity path', async () => {
    // Arrange
    const { client, fetch } = setup();
    // Act
    await client.getEntityDiff({
      entityRef: 'Component:Default/Example',
      from: { kind: 'history-row', id: '12' },
      to: { kind: 'history-row', id: '9' },
    });
    // Assert
    expect(fetch).toHaveBeenCalledWith(
      'https://catalog.example/api/catalog/history/entities/component/default/example/diff?from=row%3A12&to=row%3A9',
    );
  });

  it('rejects non-row diff targets without fetching', async () => {
    // Arrange
    const { client, fetch } = setup();
    // Act
    const result = client.getEntityDiff({
      entityRef: 'component:default/example',
      from: { kind: 'timestamp', timestamp: '2026-01-01T00:00:00Z' },
      to: { kind: 'history-row', id: '9' },
    });
    // Assert
    await expect(result).rejects.toThrow('recorded events only');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('discovers the global feed without constructing an entity path and omits absent filters', async () => {
    // Arrange
    const { client, fetch, getBaseUrl } = setup();
    // Act
    const result = await client.getChangeFeed({});
    // Assert
    expect(getBaseUrl).toHaveBeenCalledWith('catalog');
    expect(fetch).toHaveBeenCalledWith(
      'https://catalog.example/api/catalog/history/changes?limit=25',
    );
    expect(result).toEqual({ items: [], nextCursor: 'opaque+/=' });
  });

  it('rejects an explicitly empty entity filter rather than broadening to all entities', async () => {
    // Arrange
    const { client, fetch, getBaseUrl } = setup();
    // Act
    const result = client.getChangeFeed({ entityRef: '' });
    // Assert
    await expect(result).rejects.toThrow('Entity reference must not be empty');
    expect(fetch).not.toHaveBeenCalled();
    expect(getBaseUrl).not.toHaveBeenCalled();
  });

  it.each(['group:default/team', ''])(
    'rejects unsupported owner %j without discovery or fetch',
    async owner => {
      // Arrange: rejecting an unsupported filter prevents a broader global request.
      const { client, fetch, getBaseUrl } = setup();

      // Act
      const result = client.getChangeFeed({ owner });

      // Assert
      await expect(result).rejects.toThrow('Owner filtering is not supported');
      expect(fetch).not.toHaveBeenCalled();
      expect(getBaseUrl).not.toHaveBeenCalled();
    },
  );

  it.each(['', '   '])(
    'preserves an explicitly empty kind %j for backend rejection',
    async kind => {
      // Arrange
      const { client, fetch } = setup();
      fetch.mockResolvedValue({ ok: false, status: 400 });

      // Act
      const result = client.getChangeFeed({ kind });

      // Assert
      await expect(result).rejects.toEqual(new CatalogHistoryApiError(400));
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(
        Object.fromEntries(new URL(fetch.mock.calls[0][0]).searchParams),
      ).toEqual({ limit: '25', kind: '' });
    },
  );

  it('encodes all feed filters and cursor as query values, with an exact normalized entity and kind', async () => {
    // Arrange
    const { client, fetch } = setup();
    const filters = {
      source: 'provider' as const,
      provider: 'team & service/one',
      op: 'delete' as const,
      changedAfter: '2026-10-23T12:00:00.000Z',
      changedBefore: '2026-10-23T12:00:00.000Z',
      cursor: 'opaque+/=&?%',
    };
    // Act
    await client.getChangeFeed({
      ...filters,
      entityRef: 'Group:Teams/Retired-Team',
      kind: ' gRoUp ',
      limit: 7,
    });
    // Assert
    const url = new URL(fetch.mock.calls[0][0]);
    expect(url.pathname).toBe('/api/catalog/history/changes');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      ...filters,
      entityRef: 'group:teams/retired-team',
      kind: 'gRoUp',
      limit: '7',
    });
  });

  it('normalizes short feed references and caps oversized limits', async () => {
    // Arrange
    const { client, fetch } = setup();
    // Act
    await client.getChangeFeed({ entityRef: 'Example', limit: 10000 });
    // Assert
    expect(
      Object.fromEntries(new URL(fetch.mock.calls[0][0]).searchParams),
    ).toEqual({ entityRef: 'component:default/example', limit: '100' });
  });

  it.each([0, -1, 1.5, Number.NaN])(
    'rejects feed limit %s without discovery or fetch',
    async limit => {
      // Arrange
      const { client, fetch, getBaseUrl } = setup();
      // Act
      const result = client.getChangeFeed({ limit });
      // Assert
      await expect(result).rejects.toThrow('positive integer');
      expect(fetch).not.toHaveBeenCalled();
      expect(getBaseUrl).not.toHaveBeenCalled();
    },
  );

  it.each([401, 403, 404, 500])(
    'preserves feed HTTP %s without exposing backend bodies',
    async status => {
      // Arrange
      const { client, fetch } = setup();
      const json = jest.fn();
      fetch.mockResolvedValue({ ok: false, status, json });
      // Act
      const result = client.getChangeFeed({});
      // Assert
      await expect(result).rejects.toEqual(new CatalogHistoryApiError(status));
      expect(json).not.toHaveBeenCalled();
    },
  );
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
