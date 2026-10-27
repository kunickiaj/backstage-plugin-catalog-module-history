import { randomUUID } from 'node:crypto';
import {
  createBackendModule,
  createServiceFactory,
  type BackendFeature,
} from '@backstage/backend-plugin-api';
import {
  mockCredentials,
  mockServices,
  startTestBackend,
  TestDatabases,
  type TestBackend,
} from '@backstage/backend-test-utils';
import { InputError, NotFoundError } from '@backstage/errors';
import {
  catalogProcessingExtensionPoint,
  catalogServiceRef,
  type CatalogService,
} from '@backstage/plugin-catalog-node';
import { AuthorizeResult } from '@backstage/plugin-permission-common';
import { catalogHistoryReadPermission } from '@kunickiaj/backstage-plugin-catalog-history-common';
import {
  historyStoreServiceRef,
  type HistoryQueryService,
  type HistoryStore,
} from '@kunickiaj/backstage-plugin-catalog-history-node';
import { InMemoryHistoryStore } from '@kunickiaj/backstage-plugin-catalog-history-node/testUtils';
import { historyStoreServiceFactory } from '@kunickiaj/backstage-plugin-catalog-history-storage-node';
import request from '../__testUtils__/testBackendRequest';
import { catalogModuleHistory } from '../catalogModuleHistory';

jest.setTimeout(30000);

const entityPath = '/api/catalog/history/entities/Component/Default/Example';
const canonicalRef = 'component:default/example';
const endpoints = ['history', 'versions'] as const;
type Endpoint = (typeof endpoints)[number];
type Query = Pick<
  HistoryQueryService,
  'getEntityTimeline' | 'getEntityVersions' | 'getEntityVersion'
>;

function createQuery(): jest.Mocked<Query> {
  return {
    getEntityTimeline: jest.fn().mockResolvedValue({ items: [] }),
    getEntityVersions: jest.fn().mockResolvedValue({ items: [] }),
    getEntityVersion: jest.fn(),
  };
}

function queryMethod(query: jest.Mocked<Query>, endpoint: Endpoint) {
  return endpoint === 'history'
    ? query.getEntityTimeline
    : query.getEntityVersions;
}

function storeFactory(store: HistoryStore) {
  return createServiceFactory({
    service: historyStoreServiceRef,
    deps: {},
    factory: () => store,
  });
}

const catalogServiceFactory = createServiceFactory({
  service: catalogServiceRef,
  deps: {},
  factory: () => ({ queryEntities: jest.fn() }) as unknown as CatalogService,
});

let backend: TestBackend | undefined;

async function startApi(
  options: {
    query?: jest.Mocked<Query>;
    enabled?: boolean;
    historyEnabled?: boolean;
    features?: BackendFeature[];
    permissionFramework?: 'disabled' | 'omitted';
  } = {},
) {
  const query = options.query ?? createQuery();
  const store = Object.assign(new InMemoryHistoryStore(), { query });
  const permissions = mockServices.permissions.mock();
  permissions.authorize.mockResolvedValue([{ result: AuthorizeResult.ALLOW }]);
  const registry = mockServices.permissionsRegistry.mock();
  const logger = mockServices.logger.mock();
  backend = await startTestBackend({
    extensionPoints: [
      [catalogProcessingExtensionPoint, { addProcessor: jest.fn() }],
    ],
    features: [
      catalogModuleHistory,
      catalogServiceFactory,
      ...(options.features ?? [storeFactory(store)]),
      options.permissionFramework
        ? mockServices.permissions.factory()
        : permissions.factory,
      registry.factory,
      logger.factory,
      mockServices.httpAuth.factory({
        defaultCredentials: mockCredentials.none(),
      }),
      mockServices.rootConfig.factory({
        data: {
          ...(options.permissionFramework === 'omitted'
            ? {}
            : {
                permission: {
                  enabled: options.permissionFramework !== 'disabled',
                },
              }),
          catalog: {
            history: {
              enabled: options.historyEnabled ?? true,
              ...(options.enabled === undefined
                ? {}
                : { api: { enabled: options.enabled } }),
            },
          },
        },
      }),
    ],
  });
  return { server: backend.server, query, permissions, registry, logger };
}

afterEach(async () => {
  await backend?.stop();
  backend = undefined;
});

describe('catalog history API module wiring', () => {
  it.each([undefined, false])(
    'does not expose routes when API enabled=%s',
    async enabled => {
      // Arrange: API reads are opt-in, independently of capture.
      const { server, query, registry } = await startApi({ enabled });

      // Act
      const response = await request(server)
        .get(`${entityPath}/history`)
        .set('Authorization', mockCredentials.user.header());

      // Assert
      expect(response.status).toBe(404);
      expect(query.getEntityTimeline).not.toHaveBeenCalled();
      expect(registry.addPermissions).not.toHaveBeenCalled();
    },
  );

  it('does not expose routes when all history is disabled', async () => {
    // Arrange
    const { server, query } = await startApi({
      enabled: true,
      historyEnabled: false,
    });

    // Act
    const response = await request(server)
      .get(`${entityPath}/history`)
      .set('Authorization', mockCredentials.user.header());

    // Assert
    expect(response.status).toBe(404);
    expect(query.getEntityTimeline).not.toHaveBeenCalled();
  });

  it('registers the dedicated read permission when the API is enabled', async () => {
    // Arrange
    const { registry } = await startApi({ enabled: true });

    // Act
    const registrations = registry.addPermissions.mock.calls.flatMap(
      ([permissions]) => permissions,
    );

    // Assert
    expect(registrations).toContainEqual(catalogHistoryReadPermission);
    expect(catalogHistoryReadPermission.name).toBe('catalog-history.read');
  });

  it.each([undefined, false])(
    'keeps write-only custom stores compatible when API enabled=%s',
    async enabled => {
      // Arrange
      const store = new InMemoryHistoryStore();

      // Act
      const { server } = await startApi({
        enabled,
        features: [storeFactory(store)],
      });
      const response = await request(server)
        .get(`${entityPath}/history`)
        .set('Authorization', mockCredentials.user.header());

      // Assert
      expect(response.status).toBe(404);
    },
  );

  it('fails startup if enabled with a write-only custom store', async () => {
    // Arrange
    const store = new InMemoryHistoryStore();

    // Act
    const startup = startApi({
      enabled: true,
      features: [storeFactory(store)],
    });

    // Assert
    await expect(startup).rejects.toThrow(/query/i);
  });
});

describe.each(endpoints)('catalog entity %s endpoint', endpoint => {
  it.each(['disabled', 'omitted'] as const)(
    'allows authenticated users with the default permissions service when permission config is %s',
    async permissionFramework => {
      // Arrange: use Backstage's actual permissions service, not a mock ALLOW.
      const { server, query, permissions } = await startApi({
        enabled: true,
        permissionFramework,
      });

      // Act
      const response = await request(server)
        .get(`${entityPath}/${endpoint}`)
        .set('Authorization', mockCredentials.user.header());

      // Assert
      expect(response.status).toBe(200);
      expect(response.body).toEqual({ items: [] });
      expect(queryMethod(query, endpoint)).toHaveBeenCalledWith({
        entityRef: canonicalRef,
        limit: 25,
      });
      expect(permissions.authorize).not.toHaveBeenCalled();
    },
  );

  it.each(['disabled', 'omitted'] as const)(
    'requires user authentication when permission config is %s',
    async permissionFramework => {
      // Arrange
      const { server, query } = await startApi({
        enabled: true,
        permissionFramework,
      });

      // Act
      const response = await request(server).get(`${entityPath}/${endpoint}`);

      // Assert
      expect(response.status).toBe(401);
      expect(queryMethod(query, endpoint)).not.toHaveBeenCalled();
    },
  );

  it('returns empty history for an allowed user without consulting current catalog visibility', async () => {
    // Arrange
    const { server, query, permissions, logger } = await startApi({
      enabled: true,
    });

    // Act
    const response = await request(server)
      .get(`${entityPath}/${endpoint}`)
      .set('Authorization', mockCredentials.user.header());

    // Assert
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ items: [] });
    expect(logger.error).not.toHaveBeenCalled();
    expect(queryMethod(query, endpoint)).toHaveBeenCalledWith({
      entityRef: canonicalRef,
      limit: 25,
    });
    expect(permissions.authorize).toHaveBeenCalledWith(
      [{ permission: catalogHistoryReadPermission }],
      expect.objectContaining({
        credentials: expect.objectContaining({
          principal: expect.objectContaining({ type: 'user' }),
        }),
      }),
    );
  });

  it.each([
    ['missing', undefined],
    ['service', mockCredentials.service.header()],
    ['invalid user', mockCredentials.user.invalidHeader()],
  ])(
    'rejects %s credentials before querying',
    async (_label, authorization) => {
      // Arrange
      const { server, query, permissions } = await startApi({ enabled: true });
      const pending = request(server).get(`${entityPath}/${endpoint}`);
      if (authorization) pending.set('Authorization', authorization);

      // Act
      const response = await pending;

      // Assert
      expect(response.status).toBe(401);
      expect(queryMethod(query, endpoint)).not.toHaveBeenCalled();
      expect(permissions.authorize).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['denied', [{ result: AuthorizeResult.DENY }]],
    [
      'conditional',
      [
        {
          result: AuthorizeResult.CONDITIONAL,
          pluginId: 'catalog',
          resourceType: 'catalog-entity',
          conditions: {
            rule: 'test',
            resourceType: 'catalog-entity',
            params: {},
          },
        },
      ],
    ],
    ['missing', []],
  ])(
    'rejects a %s permission decision without querying',
    async (_label, decisions) => {
      // Arrange
      const { server, query, permissions } = await startApi({ enabled: true });
      permissions.authorize.mockResolvedValue(decisions as never);

      // Act
      const response = await request(server)
        .get(`${entityPath}/${endpoint}`)
        .set('Authorization', mockCredentials.user.header());

      // Assert
      expect(response.status).toBe(403);
      expect(queryMethod(query, endpoint)).not.toHaveBeenCalled();
    },
  );

  it('forwards supported filters and an opaque pagination cursor', async () => {
    // Arrange
    const { server, query } = await startApi({ enabled: true });
    const filters = {
      source: 'provider',
      provider: 'example-provider',
      changedAfter: '2026-07-07T00:00:00Z',
      changedBefore: '2026-07-08T00:00:00Z',
      limit: '2',
      cursor: 'opaque+/cursor=',
      ...(endpoint === 'history' ? { op: 'update' } : {}),
    };

    // Act
    const response = await request(server)
      .get(`${entityPath}/${endpoint}`)
      .query(filters)
      .set('Authorization', mockCredentials.user.header());

    // Assert
    expect(response.status).toBe(200);
    expect(queryMethod(query, endpoint)).toHaveBeenCalledWith({
      ...filters,
      entityRef: canonicalRef,
      limit: 2,
    });
  });

  it('clamps oversized limits to 100', async () => {
    // Arrange
    const { server, query } = await startApi({ enabled: true });

    // Act
    const response = await request(server)
      .get(`${entityPath}/${endpoint}?limit=101`)
      .set('Authorization', mockCredentials.user.header());

    // Assert
    expect(response.status).toBe(200);
    expect(queryMethod(query, endpoint)).toHaveBeenCalledWith({
      entityRef: canonicalRef,
      limit: 100,
    });
  });

  it('preserves a literal question mark in a raw provider query value', async () => {
    // Arrange: raw URLs exercise parsing after the first question mark.
    const { server, query } = await startApi({ enabled: true });

    // Act
    const response = await request(server)
      .get(`${entityPath}/${endpoint}?provider=one?`)
      .set('Authorization', mockCredentials.user.header());

    // Assert
    expect(response.status).toBe(200);
    expect(queryMethod(query, endpoint)).toHaveBeenCalledWith({
      entityRef: canonicalRef,
      provider: 'one?',
      limit: 25,
    });
  });

  it.each([
    'owner=group:default/team',
    'limit=0',
    'source=provider&source=processing',
  ])(
    'rejects invalid raw query arguments after a literal question mark: %s',
    async suffix => {
      // Arrange: do not encode the second question mark with .query().
      const { server, query } = await startApi({ enabled: true });

      // Act
      const response = await request(server)
        .get(`${entityPath}/${endpoint}?provider=one?&${suffix}`)
        .set('Authorization', mockCredentials.user.header());

      // Assert
      expect(response.status).toBe(400);
      expect(queryMethod(query, endpoint)).not.toHaveBeenCalled();
    },
  );

  it('accepts timezone offsets and compares date bounds by instant', async () => {
    // Arrange: the after text sorts later but denotes an earlier instant.
    const { server, query } = await startApi({ enabled: true });
    const filters = {
      changedAfter: '2026-07-07T01:00:00+02:00',
      changedBefore: '2026-07-07T00:00:00Z',
    };

    // Act
    const response = await request(server)
      .get(`${entityPath}/${endpoint}`)
      .query(filters)
      .set('Authorization', mockCredentials.user.header());

    // Assert
    expect(response.status).toBe(200);
    expect(queryMethod(query, endpoint)).toHaveBeenCalledWith({
      entityRef: canonicalRef,
      ...filters,
      limit: 25,
    });
  });

  it.each([
    'unknown=value',
    'unknown=one&unknown=two',
    'unknown%5Bfield%5D=value',
    'source%5B%5D=provider',
    'owner=group:default/team',
    'entityRef=user:default/other',
    'source=unknown',
    'source=provider&source=processing',
    'provider=one&provider=two',
    'limit=0',
    'limit=-1',
    'limit=1.5',
    'limit=abc',
    'limit=',
    'limit=1&limit=2',
    'changedAfter=not-a-date',
    'changedBefore=not-a-date',
    'changedAfter=2026-02-30T00:00:00Z',
    'changedBefore=2026-02-30T00:00:00Z',
    'changedAfter=2026-07-07T00:00:00',
    'changedBefore=2026-07-07T00:00:00',
    'changedAfter=2026-07-08T00:00:00Z&changedBefore=2026-07-07T00:00:00Z',
    'cursor=one&cursor=two',
  ])('rejects invalid query %s before querying', async queryString => {
    // Arrange
    const { server, query } = await startApi({ enabled: true });

    // Act
    const response = await request(server)
      .get(`${entityPath}/${endpoint}?${queryString}`)
      .set('Authorization', mockCredentials.user.header());

    // Assert
    expect(response.status).toBe(400);
    expect(queryMethod(query, endpoint)).not.toHaveBeenCalled();
  });

  it.each([
    'Bad%3AKind/default/example',
    'component/bad%20namespace/example',
    'component/default/bad%3Aname',
  ])('rejects invalid entity identity %s', async identity => {
    // Arrange
    const { server, query } = await startApi({ enabled: true });

    // Act
    const response = await request(server)
      .get(`/api/catalog/history/entities/${identity}/${endpoint}`)
      .set('Authorization', mockCredentials.user.header());

    // Assert
    expect(response.status).toBe(400);
    expect(queryMethod(query, endpoint)).not.toHaveBeenCalled();
  });

  it('maps invalid query-service cursors to a client error', async () => {
    // Arrange
    const { server, query, logger } = await startApi({ enabled: true });
    queryMethod(query, endpoint).mockRejectedValue(
      new InputError('Invalid history cursor'),
    );

    // Act
    const response = await request(server)
      .get(`${entityPath}/${endpoint}?cursor=invalid`)
      .set('Authorization', mockCredentials.user.header());

    // Assert
    expect(response.status).toBe(400);
    expect(logger.error).not.toHaveBeenCalled();
  });

  it.each(['42P01', 'ECONNREFUSED'])(
    'logs original failure metadata for %s without exposing backend details',
    async code => {
      // Arrange
      const { server, query, logger } = await startApi({ enabled: true });
      const sensitive =
        'postgres://private-user:secret-password@db/private SELECT * FROM private_table';
      const error = Object.assign(new Error(sensitive), { code });
      const stack = '    at originalQuery (/synthetic/query.ts:12:3)';
      error.stack = `${Error.prototype.toString.call(error)}\n${stack}`;
      queryMethod(query, endpoint).mockRejectedValue(error);

      // Act
      const response = await request(server)
        .get(`${entityPath}/${endpoint}`)
        .set('Authorization', mockCredentials.user.header());

      // Assert
      expect(response.status).toBe(500);
      expect(response.body.error?.message).toBe(
        'Unable to retrieve catalog history',
      );
      expect(response.text).not.toContain('originalQuery');
      expect(response.text).not.toContain(sensitive);
      expect(response.text).not.toContain('secret-password');
      expect(response.text).not.toContain('private_table');
      expect(response.body.error?.stack).toBeUndefined();
      expect(logger.error).toHaveBeenCalledTimes(1);
      expect(logger.error).toHaveBeenCalledWith(
        'Catalog history query failed',
        {
          errorType: 'Error',
          errorCode: code,
          stack,
        },
      );
      expect(JSON.stringify(logger.error.mock.calls)).not.toMatch(
        /secret-password|private_table|SELECT/,
      );
    },
  );

  it('fails closed and hides permission-service failure details', async () => {
    // Arrange
    const { server, query, permissions } = await startApi({ enabled: true });
    permissions.authorize.mockRejectedValue(
      new Error('private-policy-service secret-token'),
    );

    // Act
    const response = await request(server)
      .get(`${entityPath}/${endpoint}`)
      .set('Authorization', mockCredentials.user.header());

    // Assert
    expect(response.status).toBe(500);
    expect(response.text).not.toContain('secret-token');
    expect(response.text).not.toContain('private-policy-service');
    expect(queryMethod(query, endpoint)).not.toHaveBeenCalled();
  });
});

describe('exact entity version endpoint', () => {
  it('returns the exact event DTO and canonical entity identity for an allowed user', async () => {
    // Arrange
    const { server, query, permissions, logger } = await startApi({
      enabled: true,
    });
    const version = {
      id: '42',
      cycleId: 'cycle-42',
      entityRef: canonicalRef,
      source: 'provider' as const,
      provider: 'example-provider',
      op: 'insert' as const,
      changedAt: '2026-07-07T00:00:00.000Z',
      etag: 'etag-a',
      summary: {},
      snapshot: {
        entityRef: canonicalRef,
        kind: 'Component',
        namespace: 'default',
        name: 'example',
        metadata: { name: 'example' },
        spec: { type: 'service' },
      },
    };
    query.getEntityVersion.mockResolvedValue(version);

    // Act
    const response = await request(server)
      .get(`${entityPath}/versions/42`)
      .set('Authorization', mockCredentials.user.header());

    // Assert
    expect(response.status).toBe(200);
    expect(response.body).toEqual(version);
    expect(logger.error).not.toHaveBeenCalled();
    expect(query.getEntityVersion).toHaveBeenCalledWith({
      entityRef: canonicalRef,
      id: '42',
    });
    expect(permissions.authorize).toHaveBeenCalledWith(
      [{ permission: catalogHistoryReadPermission }],
      expect.objectContaining({
        credentials: expect.objectContaining({
          principal: expect.objectContaining({ type: 'user' }),
        }),
      }),
    );
  });

  it.each([
    undefined,
    mockCredentials.service.header(),
    mockCredentials.user.invalidHeader(),
  ])(
    'rejects missing, service, or invalid credentials (%s)',
    async authorization => {
      // Arrange
      const { server, query, permissions } = await startApi({ enabled: true });
      const pending = request(server).get(`${entityPath}/versions/42`);
      if (authorization) pending.set('Authorization', authorization);

      // Act
      const response = await pending;

      // Assert
      expect(response.status).toBe(401);
      expect(query.getEntityVersion).not.toHaveBeenCalled();
      expect(permissions.authorize).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['denied', [{ result: AuthorizeResult.DENY }]],
    [
      'conditional',
      [
        {
          result: AuthorizeResult.CONDITIONAL,
          pluginId: 'catalog',
          resourceType: 'catalog-entity',
          conditions: {
            rule: 'test',
            resourceType: 'catalog-entity',
            params: {},
          },
        },
      ],
    ],
    ['missing', []],
  ])(
    'rejects a %s exact-read permission decision',
    async (_label, decision) => {
      // Arrange
      const { server, query, permissions } = await startApi({ enabled: true });
      permissions.authorize.mockResolvedValue(decision as never);

      // Act
      const response = await request(server)
        .get(`${entityPath}/versions/42`)
        .set('Authorization', mockCredentials.user.header());

      // Assert
      expect(response.status).toBe(403);
      expect(query.getEntityVersion).not.toHaveBeenCalled();
    },
  );

  it.each(['0', '-1', '1.5', 'abc', '9223372036854775808'])(
    'rejects invalid PostgreSQL row ID %s',
    async id => {
      // Arrange
      const { server, query } = await startApi({ enabled: true });

      // Act
      const response = await request(server)
        .get(`${entityPath}/versions/${id}`)
        .set('Authorization', mockCredentials.user.header());

      // Assert
      expect(response.status).toBe(400);
      expect(query.getEntityVersion).not.toHaveBeenCalled();
    },
  );

  it.each([
    'owner=group:default/team',
    'source=provider',
    'unknown=one&unknown=two',
    'source=provider&source=processing',
    'unknown%5Bfield%5D=value',
  ])('rejects query parameters on exact reads: %s', async queryString => {
    // Arrange
    const { server, query } = await startApi({ enabled: true });

    // Act
    const response = await request(server)
      .get(`${entityPath}/versions/42?${queryString}`)
      .set('Authorization', mockCredentials.user.header());

    // Assert
    expect(response.status).toBe(400);
    expect(query.getEntityVersion).not.toHaveBeenCalled();
  });

  it.each(['missing row', 'row belongs to another entity'])(
    'returns a sanitized 404 for %s',
    async reason => {
      // Arrange
      const { server, query, logger } = await startApi({ enabled: true });
      query.getEntityVersion.mockRejectedValue(
        new NotFoundError(`${reason}: private-table secret-token`),
      );

      // Act
      const response = await request(server)
        .get(`${entityPath}/versions/42`)
        .set('Authorization', mockCredentials.user.header());

      // Assert
      expect(response.status).toBe(404);
      expect(response.text).not.toContain('private-table');
      expect(response.text).not.toContain('secret-token');
      expect(response.body.error?.stack).toBeUndefined();
      expect(logger.error).not.toHaveBeenCalled();
    },
  );

  it.each(['42P01', 'ECONNREFUSED'])(
    'logs original exact-read failure metadata for %s without exposing it',
    async code => {
      // Arrange
      const { server, query, logger } = await startApi({ enabled: true });
      const error = Object.assign(
        new Error('SELECT * FROM private_table secret-token'),
        { code },
      );
      const stack = '    at originalExactQuery (/synthetic/query.ts:24:5)';
      error.stack = `${Error.prototype.toString.call(error)}\n${stack}`;
      query.getEntityVersion.mockRejectedValue(error);

      // Act
      const response = await request(server)
        .get(`${entityPath}/versions/42`)
        .set('Authorization', mockCredentials.user.header());

      // Assert
      expect(response.status).toBe(500);
      expect(response.body.error?.message).toBe(
        'Unable to retrieve catalog history',
      );
      expect(response.text).not.toContain('originalExactQuery');
      expect(response.text).not.toContain('private_table');
      expect(response.text).not.toContain('secret-token');
      expect(response.body.error?.stack).toBeUndefined();
      expect(logger.error).toHaveBeenCalledTimes(1);
      expect(logger.error).toHaveBeenCalledWith(
        'Catalog history query failed',
        {
          errorType: 'Error',
          errorCode: code,
          stack,
        },
      );
      expect(JSON.stringify(logger.error.mock.calls)).not.toMatch(
        /private_table|secret-token|SELECT/,
      );
    },
  );
});

describe('endpoint-specific DTOs and filters', () => {
  it.each(['invalid', 'insert&op=update'])(
    'rejects invalid history op=%s',
    async op => {
      // Arrange
      const { server, query } = await startApi({ enabled: true });

      // Act
      const response = await request(server)
        .get(`${entityPath}/history?op=${op}`)
        .set('Authorization', mockCredentials.user.header());

      // Assert
      expect(response.status).toBe(400);
      expect(query.getEntityTimeline).not.toHaveBeenCalled();
    },
  );

  it('rejects op on versions rather than silently ignoring it', async () => {
    // Arrange
    const { server, query } = await startApi({ enabled: true });

    // Act
    const response = await request(server)
      .get(`${entityPath}/versions?op=insert`)
      .set('Authorization', mockCredentials.user.header());

    // Assert
    expect(response.status).toBe(400);
    expect(query.getEntityVersions).not.toHaveBeenCalled();
  });

  it('preserves timeline pagination and version snapshot DTOs', async () => {
    // Arrange
    const { server, query } = await startApi({ enabled: true });
    const item = {
      id: '7',
      cycleId: 'cycle-7',
      entityRef: canonicalRef,
      source: 'provider' as const,
      provider: 'example-provider',
      op: 'insert' as const,
      changedAt: '2026-07-07T00:00:00.000Z',
      etag: 'etag-1',
      summary: {},
    };
    const snapshot = {
      entityRef: canonicalRef,
      kind: 'Component',
      namespace: 'default',
      name: 'example',
      metadata: { name: 'example' },
      spec: { type: 'service', owner: 'group:default/team' },
    };
    query.getEntityTimeline.mockResolvedValue({
      items: [item],
      nextCursor: 'next-page',
    });
    query.getEntityVersions.mockResolvedValue({
      items: [{ ...item, snapshot }],
    });

    // Act
    const history = await request(server)
      .get(`${entityPath}/history`)
      .set('Authorization', mockCredentials.user.header());
    const versions = await request(server)
      .get(`${entityPath}/versions`)
      .set('Authorization', mockCredentials.user.header());

    // Assert
    expect(history.status).toBe(200);
    expect(history.body).toEqual({ items: [item], nextCursor: 'next-page' });
    expect(versions.status).toBe(200);
    expect(versions.body).toEqual({ items: [{ ...item, snapshot }] });
  });
});

describe('default history store API database integration', () => {
  const databases = TestDatabases.create({ ids: ['POSTGRES_16'] });

  it('reads exact original payloads, provenance-distinct versions, and tombstones from the recording store', async () => {
    // Arrange: record A to B to A, plus the same etag under other provenance.
    const db = await databases.init('POSTGRES_16');
    let store: HistoryStore | undefined;
    const consumer = createBackendModule({
      pluginId: 'catalog',
      moduleId: 'history-exact-test-consumer',
      register(reg) {
        reg.registerInit({
          deps: { store: historyStoreServiceRef },
          async init(deps) {
            store = deps.store;
          },
        });
      },
    });
    const { server } = await startApi({
      enabled: true,
      features: [
        historyStoreServiceFactory,
        consumer,
        mockServices.database.factory({ knex: db }),
      ],
    });
    const events = [
      { etag: 'a', source: 'provider' as const, provider: 'one' },
      { etag: 'b', source: 'provider' as const, provider: 'one' },
      { etag: 'a', source: 'provider' as const, provider: 'one' },
      { etag: 'a', source: 'provider' as const, provider: 'two' },
      { etag: 'a', source: 'processing' as const, provider: 'one' },
    ];
    for (const [index, event] of events.entries()) {
      const at = new Date(`2026-07-07T0${index}:00:00Z`);
      const row = {
        entityRef: canonicalRef,
        kind: 'Component',
        namespace: 'default',
        name: 'example',
        etag: event.etag,
        metadata: { name: 'example', description: `recorded-${index}` },
        spec: { type: 'service', owner: 'group:default/team' },
      };
      await store!.recordCycle({
        cycleId: randomUUID(),
        source: event.source,
        provider: event.provider,
        mutationType: 'delta',
        startedAt: at,
        finishedAt: at,
        inserts: index === 0 ? [row] : [],
        updates: index === 0 ? [] : [row],
        deletes: [],
        unchangedCount: 0,
      });
    }
    const deletedAt = new Date('2026-07-07T05:00:00Z');
    const deleteCycleId = randomUUID();
    await store!.recordCycle({
      cycleId: deleteCycleId,
      source: 'provider',
      provider: 'one',
      mutationType: 'delta',
      startedAt: deletedAt,
      finishedAt: deletedAt,
      inserts: [],
      updates: [],
      deletes: [canonicalRef],
      unchangedCount: 0,
    });

    // Act: discover event IDs through the public timeline, not direct SQL.
    const timeline = await request(server)
      .get(`${entityPath}/history`)
      .set('Authorization', mockCredentials.user.header());
    const originalId = timeline.body.items.find(
      (item: { op: string }) => item.op === 'insert',
    ).id;
    const tombstoneId = timeline.body.items[0].id;
    const original = await request(server)
      .get(`${entityPath}/versions/${originalId}`)
      .set('Authorization', mockCredentials.user.header());
    const versions = await request(server)
      .get(`${entityPath}/versions`)
      .set('Authorization', mockCredentials.user.header());
    const tombstone = await request(server)
      .get(`${entityPath}/versions/${tombstoneId}`)
      .set('Authorization', mockCredentials.user.header());
    const repeatedId = timeline.body.items.find(
      (item: { source: string; provider: string; etag: string }) =>
        item.source === 'provider' &&
        item.provider === 'one' &&
        item.etag === 'a',
    ).id;
    const repeated = await request(server)
      .get(`${entityPath}/versions/${repeatedId}`)
      .set('Authorization', mockCredentials.user.header());
    const mismatch = await request(server)
      .get(
        `/api/catalog/history/entities/component/default/another/versions/${originalId}`,
      )
      .set('Authorization', mockCredentials.user.header());
    const missing = await request(server)
      .get(`${entityPath}/versions/9223372036854775807`)
      .set('Authorization', mockCredentials.user.header());

    // Assert: exact event reads must not substitute the latest matching etag.
    expect(timeline.status).toBe(200);
    expect(original.status).toBe(200);
    expect(original.body).toMatchObject({
      id: originalId,
      op: 'insert',
      etag: 'a',
      changedAt: '2026-07-07T00:00:00.000Z',
      snapshot: { metadata: { description: 'recorded-0' } },
    });
    expect(original.body).not.toHaveProperty('previousVersion');
    expect(original.body).not.toHaveProperty('changes');
    expect(repeated.status).toBe(200);
    expect(repeated.body.previousVersion).toMatchObject({
      etag: 'b',
      snapshot: { metadata: { description: 'recorded-1' } },
    });
    expect(repeated.body.changes).toEqual([
      {
        path: ['metadata', 'description'],
        op: 'replace',
        before: 'recorded-1',
        after: 'recorded-2',
      },
    ]);
    expect(versions.status).toBe(200);
    expect(versions.body.items).toHaveLength(4);
    expect(
      versions.body.items.map(
        (item: {
          source: string;
          provider: string;
          etag: string;
          snapshot: { metadata: { description: string } };
        }) => [
          item.source,
          item.provider,
          item.etag,
          item.snapshot.metadata.description,
        ],
      ),
    ).toEqual([
      ['processing', 'one', 'a', 'recorded-4'],
      ['provider', 'two', 'a', 'recorded-3'],
      ['provider', 'one', 'a', 'recorded-2'],
      ['provider', 'one', 'b', 'recorded-1'],
    ]);
    expect(tombstone.status).toBe(200);
    expect(tombstone.body).toMatchObject({
      id: tombstoneId,
      cycleId: deleteCycleId,
      entityRef: canonicalRef,
      source: 'provider',
      provider: 'one',
      op: 'delete',
      changedAt: '2026-07-07T05:00:00.000Z',
    });
    expect(tombstone.body.snapshot).toBeUndefined();
    expect(tombstone.body.previousVersion).toMatchObject({
      id: repeatedId,
      source: 'provider',
      provider: 'one',
      snapshot: { metadata: { description: 'recorded-2' } },
    });
    expect(tombstone.body.previousVersion).not.toHaveProperty(
      'previousVersion',
    );
    expect(tombstone.body.changes).toEqual([
      {
        path: ['metadata'],
        op: 'remove',
        before: { name: 'example', description: 'recorded-2' },
      },
      {
        path: ['spec'],
        op: 'remove',
        before: { type: 'service', owner: 'group:default/team' },
      },
    ]);
    expect(mismatch.status).toBe(404);
    expect(missing.status).toBe(404);
    expect(mismatch.body.error?.stack).toBeUndefined();
  });

  it('retains deleted component history and snapshots across paginated reads from the store database', async () => {
    // Arrange: resolve the actual default store used by the catalog module.
    const db = await databases.init('POSTGRES_16');
    let store: HistoryStore | undefined;
    const consumer = createBackendModule({
      pluginId: 'catalog',
      moduleId: 'history-api-test-consumer',
      register(reg) {
        reg.registerInit({
          deps: { store: historyStoreServiceRef },
          async init(deps) {
            store = deps.store;
          },
        });
      },
    });
    const { server } = await startApi({
      enabled: true,
      features: [
        historyStoreServiceFactory,
        consumer,
        mockServices.database.factory({ knex: db }),
      ],
    });
    for (const index of [1, 2]) {
      const at = new Date(`2026-07-07T0${index}:00:00Z`);
      const row = {
        entityRef: canonicalRef,
        kind: 'Component',
        namespace: 'default',
        name: 'example',
        etag: `etag-${index}`,
        metadata: { name: 'example' },
        spec: {
          type: 'service',
          owner: 'group:default/team',
          lifecycle: 'production',
        },
      };
      await store!.recordCycle({
        cycleId: randomUUID(),
        provider: 'example-provider',
        source: 'provider',
        mutationType: 'delta',
        startedAt: at,
        finishedAt: at,
        inserts: index === 1 ? [row] : [],
        updates: index === 2 ? [row] : [],
        deletes: [],
        unchangedCount: 0,
      });
    }
    const deletedAt = new Date('2026-07-07T03:00:00Z');
    await store!.recordCycle({
      cycleId: randomUUID(),
      provider: 'example-provider',
      source: 'provider',
      mutationType: 'delta',
      startedAt: deletedAt,
      finishedAt: deletedAt,
      inserts: [],
      updates: [],
      deletes: [canonicalRef],
      unchangedCount: 0,
    });

    // Act
    const first = await request(server)
      .get(`${entityPath}/history?limit=1`)
      .set('Authorization', mockCredentials.user.header());
    const second = await request(server)
      .get(`${entityPath}/history`)
      .query({ limit: 1, cursor: first.body.nextCursor })
      .set('Authorization', mockCredentials.user.header());
    const third = await request(server)
      .get(`${entityPath}/history`)
      .query({ limit: 1, cursor: second.body.nextCursor })
      .set('Authorization', mockCredentials.user.header());
    const versions = await request(server)
      .get(`${entityPath}/versions`)
      .set('Authorization', mockCredentials.user.header());
    const absent = await request(server)
      .get('/api/catalog/history/entities/component/default/missing/history')
      .set('Authorization', mockCredentials.user.header());

    // Assert: no separately configured reader database or direct SQL fixtures.
    expect(first.status).toBe(200);
    expect(first.body.items).toEqual([
      expect.objectContaining({ entityRef: canonicalRef, op: 'delete' }),
    ]);
    expect(first.body.nextCursor).toEqual(expect.any(String));
    expect(second.status).toBe(200);
    expect(
      second.body.items.map((item: { etag: string }) => item.etag),
    ).toEqual(['etag-2']);
    expect(second.body.nextCursor).toEqual(expect.any(String));
    expect(third.status).toBe(200);
    expect(third.body.items.map((item: { etag: string }) => item.etag)).toEqual(
      ['etag-1'],
    );
    expect(third.body.nextCursor).toBeUndefined();
    expect(versions.status).toBe(200);
    expect(versions.body.items).toHaveLength(2);
    expect(versions.body.items[0].snapshot).toMatchObject({
      entityRef: canonicalRef,
      spec: { type: 'service', owner: 'group:default/team' },
    });
    expect(absent.status).toBe(200);
    expect(absent.body).toEqual({ items: [] });
  });
});
