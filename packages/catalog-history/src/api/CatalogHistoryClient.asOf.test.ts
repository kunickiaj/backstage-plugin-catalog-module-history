import type { DiscoveryApi, FetchApi } from '@backstage/core-plugin-api';
import { CatalogHistoryClient } from './CatalogHistoryClient';
import {
  CatalogHistoryApiError,
  type CatalogHistoryApi,
} from './CatalogHistoryApi';

const timestamp = '2026-07-07T01:00:00.123456+02:00';
const unknown = { entityRef: 'component:default/example', asOf: timestamp };
function setup() {
  const getBaseUrl = jest
    .fn()
    .mockResolvedValue('https://catalog.example/api/catalog');
  const fetch = jest.fn().mockResolvedValue({
    ok: true,
    json: jest.fn().mockResolvedValue(unknown),
  });
  const client = new CatalogHistoryClient({
    discoveryApi: { getBaseUrl } as unknown as DiscoveryApi,
    fetchApi: { fetch } as FetchApi,
  });
  return { client, fetch, getBaseUrl };
}

describe('CatalogHistoryClient as-of', () => {
  it.each([
    ['Example', 'component/default/example'],
    ['Widget:Teams/Example', 'widget/teams/example'],
    ['Component:default/A B?雪', 'component/default/a%20b%3F%E9%9B%AA'],
  ])(
    'canonicalizes and URI-encodes %s without pagination',
    async (entityRef, path) => {
      // Arrange
      const { client, fetch, getBaseUrl } = setup();
      // Act
      const result = await client.getEntityAsOf({ entityRef, timestamp });
      // Assert
      expect(getBaseUrl).toHaveBeenCalledWith('catalog');
      expect(fetch).toHaveBeenCalledWith(
        `https://catalog.example/api/catalog/history/entities/${path}/as-of?${new URLSearchParams({ timestamp })}`,
      );
      expect(result).toEqual(unknown);
    },
  );

  it('serializes only declared selectors with raw precision and exact provider', async () => {
    // Arrange
    const { client, fetch } = setup();
    const runtime = {
      entityRef: 'Example',
      timestamp,
      source: 'processing' as const,
      provider: '  MiXeD%_雪 &?/  ',
      op: 'delete',
      cycleId: 'private',
      owner: 'team',
      limit: 7,
      cursor: 'opaque',
      changedBefore: timestamp,
    };
    // Act
    await client.getEntityAsOf(runtime);
    // Assert
    expect(
      Object.fromEntries(new URL(fetch.mock.calls[0][0]).searchParams),
    ).toEqual({ timestamp, source: 'processing', provider: runtime.provider });
  });

  it.each([401, 403, 404, 500, 501])(
    'returns status-only errors for %s without reading bodies or falling back',
    async status => {
      // Arrange
      const { client, fetch } = setup();
      const json = jest
        .fn()
        .mockRejectedValue(new Error('private malformed body'));
      fetch.mockResolvedValueOnce({ ok: false, status, json });
      // Act
      const first = await client
        .getEntityAsOf({ entityRef: 'Example', timestamp })
        .catch(error => error);
      const second = await client.getEntityAsOf({
        entityRef: 'Example',
        timestamp,
      });
      // Assert
      expect(first).toEqual(new CatalogHistoryApiError(status));
      expect(json).not.toHaveBeenCalled();
      expect(second).toEqual(unknown);
      expect(fetch).toHaveBeenCalledTimes(2);
      expect(fetch.mock.calls[0][0]).toBe(fetch.mock.calls[1][0]);
    },
  );

  it.each([
    unknown,
    { ...unknown, version: { id: '1', op: 'delete', summary: {} } },
    {
      ...unknown,
      snapshot: { metadata: { name: 'saved' } },
      version: {
        id: '2',
        snapshot: { metadata: { name: 'saved' } },
        summary: {},
      },
    },
  ])(
    'returns supported JSON unchanged without filling data: %j',
    async body => {
      // Arrange
      const { client, fetch } = setup();
      fetch.mockResolvedValue({
        ok: true,
        json: jest.fn().mockResolvedValue(body),
      });
      // Act
      const result = await client.getEntityAsOf({
        entityRef: 'Example',
        timestamp,
      });
      // Assert
      expect(result).toBe(body);
      expect(fetch).toHaveBeenCalledTimes(1);
    },
  );

  it('keeps legacy base API mocks valid without the optional capability', async () => {
    // Arrange
    const api = {
      getChangeFeed: jest.fn().mockResolvedValue({ items: [] }),
    } satisfies Required<Pick<CatalogHistoryApi, 'getChangeFeed'>>;
    // Act
    const result = await api.getChangeFeed({});
    // Assert
    expect(result).toEqual({ items: [] });
    expect(api.getChangeFeed).toHaveBeenCalledWith({});
    expect('getEntityAsOf' in api).toBe(false);
  });
});
