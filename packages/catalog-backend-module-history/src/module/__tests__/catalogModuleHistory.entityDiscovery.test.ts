import { randomUUID } from 'node:crypto';
import {
  createBackendModule,
  createServiceFactory,
} from '@backstage/backend-plugin-api';
import {
  mockCredentials,
  mockServices,
  startTestBackend,
  TestDatabases,
  type TestBackend,
} from '@backstage/backend-test-utils';
import { InputError } from '@backstage/errors';
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
import { historyStoreServiceFactory } from '@kunickiaj/backstage-plugin-catalog-history-storage-node';
import request from '../__testUtils__/testBackendRequest';
import { catalogModuleHistory } from '../catalogModuleHistory';
import { startHistoryApi } from '../__testUtils__/startHistoryApi';

jest.setTimeout(30000);
let backend: TestBackend | undefined;
const basePath = '/api/catalog/history';
const endpoints = [
  ['entities', 'getEntities'],
  ['kinds', 'getKinds'],
] as const;

async function startApi(
  options: {
    missing?: readonly ('getEntities' | 'getKinds')[];
    enabled?: boolean;
    historyEnabled?: boolean;
  } = {},
) {
  const query = {
    getEntities: jest
      .fn<
        ReturnType<NonNullable<HistoryQueryService['getEntities']>>,
        Parameters<NonNullable<HistoryQueryService['getEntities']>>
      >()
      .mockResolvedValue({ items: [] }),
    getKinds: jest
      .fn<
        ReturnType<NonNullable<HistoryQueryService['getKinds']>>,
        Parameters<NonNullable<HistoryQueryService['getKinds']>>
      >()
      .mockResolvedValue({ items: [] }),
    getChangeFeed: jest.fn().mockResolvedValue({ items: [] }),
    getEntityTimeline: jest.fn().mockResolvedValue({ items: [] }),
    getEntityVersions: jest.fn().mockResolvedValue({ items: [] }),
    getEntityVersion: jest.fn().mockResolvedValue({ id: '1' }),
  };
  const supportedQuery = { ...query };
  for (const method of options.missing ?? [])
    Reflect.deleteProperty(supportedQuery, method);
  const api = await startHistoryApi({
    query: supportedQuery,
    apiEnabled: options.enabled ?? true,
    historyEnabled: options.historyEnabled,
  });
  backend = api.backend;
  const { permissions, catalog, logger } = api;
  return {
    server: api.server,
    query,
    supportedQuery,
    permissions,
    catalog,
    logger,
  };
}

afterEach(async () => {
  await backend?.stop();
  backend = undefined;
});

describe.each(endpoints)('catalog history %s discovery', (endpoint, method) => {
  const path = `${basePath}/${endpoint}`;

  it('authorizes explicit read ALLOW and binds the optional method without consulting live catalog', async () => {
    // Arrange: keep retained/deleted identity semantics in the history query.
    const { server, query, supportedQuery, permissions, catalog } =
      await startApi();
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
            nextCursor: 'opaque',
          }
        : { items: ['Custom', 'deletedKind'], nextCursor: 'opaque' };
    query[method].mockImplementation(async function bound(
      this: typeof supportedQuery,
    ) {
      expect(this).toBe(supportedQuery);
      return page as never;
    });
    // Act
    const response = await request(server)
      .get(path)
      .set('Authorization', mockCredentials.user.header());
    // Assert
    expect(response.status).toBe(200);
    expect(response.body).toEqual(page);
    expect(query[method]).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 25 }),
    );
    expect(permissions.authorize).toHaveBeenCalledWith(
      [{ permission: catalogHistoryReadPermission }],
      expect.objectContaining({
        credentials: expect.objectContaining({
          principal: expect.objectContaining({ type: 'user' }),
        }),
      }),
    );
    expect(catalog.queryEntities).not.toHaveBeenCalled();
    expect(query.getChangeFeed).not.toHaveBeenCalled();
    expect(query.getEntityTimeline).not.toHaveBeenCalled();
  });

  it('returns an empty supported page and forwards an explicitly empty prefix', async () => {
    // Arrange
    const { server, query } = await startApi();
    // Act
    const response = await request(server)
      .get(`${path}?prefix=`)
      .set('Authorization', mockCredentials.user.header());
    // Assert
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ items: [] });
    expect(query[method]).toHaveBeenCalledWith(
      expect.objectContaining({ prefix: '', limit: 25 }),
    );
    expect(Object.hasOwn(query[method].mock.calls[0][0], 'entityRef')).toBe(
      false,
    );
  });

  it.each([
    ['missing', undefined],
    ['service', mockCredentials.service.header()],
    ['invalid', mockCredentials.user.invalidHeader()],
  ])(
    'rejects %s credentials before parsing or querying',
    async (_label, header) => {
      // Arrange
      const { server, query, permissions } = await startApi();
      const pending = request(server).get(`${path}?unknown=private`);
      if (header) pending.set('Authorization', header);
      // Act
      const response = await pending;
      // Assert
      expect(response.status).toBe(401);
      expect(query[method]).not.toHaveBeenCalled();
      expect(permissions.authorize).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['deny', [{ result: AuthorizeResult.DENY }]],
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
    'rejects %s permission decisions before parsing',
    async (_label, decisions) => {
      // Arrange
      const { server, query, permissions } = await startApi();
      permissions.authorize.mockResolvedValue(decisions as never);
      // Act
      const response = await request(server)
        .get(`${path}?unknown=value`)
        .set('Authorization', mockCredentials.user.header());
      // Assert
      expect(response.status).toBe(403);
      expect(query[method]).not.toHaveBeenCalled();
    },
  );

  it('fails closed with sanitized permission errors', async () => {
    // Arrange
    const { server, query, permissions } = await startApi();
    permissions.authorize.mockRejectedValue(
      new Error('private-policy secret-token'),
    );
    // Act
    const response = await request(server)
      .get(path)
      .set('Authorization', mockCredentials.user.header());
    // Assert
    expect(response.status).toBe(500);
    expect(response.body.error?.message).toBe('History authorization failed');
    expect(response.text).not.toMatch(/private-policy|secret-token/);
    expect(query[method]).not.toHaveBeenCalled();
  });

  it.each([
    'entityRef=exact',
    'owner=team',
    'prefix=a&prefix=b',
    'limit=0',
    'cursor=',
  ])(
    'rejects invalid query %s without calling the store',
    async queryString => {
      // Arrange
      const { server, query } = await startApi();
      // Act
      const response = await request(server)
        .get(`${path}?${queryString}`)
        .set('Authorization', mockCredentials.user.header());
      // Assert
      expect(response.status).toBe(400);
      expect(query[method]).not.toHaveBeenCalled();
    },
  );

  it.each([
    [
      'input',
      new InputError(
        'private-prefix cursor-secret',
        new Error('SELECT private_table'),
      ),
      400,
      'Invalid history query',
    ],
    [
      'unexpected',
      new Error('SELECT private_table secret-bindings'),
      500,
      'Unable to retrieve catalog history',
    ],
    [
      'timeout',
      Object.assign(new Error('SELECT private_table secret-bindings'), {
        code: '57014',
        detail: 'private-provider payload',
      }),
      500,
      'Unable to retrieve catalog history',
    ],
  ])(
    'sanitizes %s query errors and causes',
    async (_label, error, status, message) => {
      // Arrange
      const { server, query, logger } = await startApi();
      query[method].mockRejectedValue(error);
      // Act
      const response = await request(server)
        .get(`${path}?prefix=public&cursor=opaque`)
        .set('Authorization', mockCredentials.user.header());
      // Assert
      expect(response.status).toBe(status);
      expect(response.body.error?.message).toBe(message);
      expect(response.body.error?.stack).toBeUndefined();
      expect(response.text).not.toMatch(
        /private-prefix|cursor-secret|SELECT|private_table|secret-bindings|private-provider|payload/,
      );
      expect(JSON.stringify(logger.error.mock.calls)).not.toMatch(
        /private-prefix|cursor-secret|SELECT|private_table|secret-bindings|private-provider|payload/,
      );
    },
  );

  it('authorizes before reporting unsupported discovery even when input is invalid', async () => {
    // Arrange
    const { server, query, permissions } = await startApi({
      missing: ['getEntities', 'getKinds'],
    });
    // Act
    const anonymous = await request(server).get(`${path}?unknown=value`);
    permissions.authorize.mockResolvedValueOnce([
      { result: AuthorizeResult.DENY },
    ]);
    const denied = await request(server)
      .get(`${path}?unknown=value`)
      .set('Authorization', mockCredentials.user.header());
    const unsupported = await request(server)
      .get(`${path}?unknown=value`)
      .set('Authorization', mockCredentials.user.header());
    // Assert
    expect(anonymous.status).toBe(401);
    expect(denied.status).toBe(403);
    expect(unsupported.status).toBe(501);
    expect(unsupported.body.error?.message).toBe(
      `This history store does not support ${endpoint === 'entities' ? 'entity' : 'kind'} discovery.`,
    );
    expect(unsupported.body.error?.stack).toBeUndefined();
    expect(query[method]).not.toHaveBeenCalled();
  });

  it.each([{ enabled: false }, { historyEnabled: false }])(
    'keeps disabled discovery unavailable: %j',
    async options => {
      // Arrange
      const { server, query } = await startApi(options);
      // Act
      const response = await request(server)
        .get(path)
        .set('Authorization', mockCredentials.user.header());
      // Assert
      expect(response.status).toBe(404);
      expect(query[method]).not.toHaveBeenCalled();
    },
  );
});

describe('discovery compatibility and context', () => {
  it('forwards only declared entity and kind filters with literal prefixes and exact providers', async () => {
    // Arrange
    const { server, query } = await startApi();
    const filters = {
      prefix: "  MiXeD%_\\'雪  ",
      kind: 'Custom',
      source: 'provider',
      provider: '  MiXeD Provider  ',
      op: 'delete',
      changedAfter: '2026-07-07T01:00:00.123456+02:00',
      changedBefore: '2026-07-07T00:00:00.987654Z',
      limit: '7',
      cursor: 'opaque+/=&?%',
    };
    const kinds = {
      prefix: filters.prefix,
      limit: '7',
      cursor: filters.cursor,
    };
    // Act
    const entities = await request(server)
      .get(`${basePath}/entities`)
      .query(filters)
      .set('Authorization', mockCredentials.user.header());
    const response = await request(server)
      .get(`${basePath}/kinds`)
      .query(kinds)
      .set('Authorization', mockCredentials.user.header());
    // Assert
    expect(entities.status).toBe(200);
    expect(query.getEntities).toHaveBeenCalledWith({ ...filters, limit: 7 });
    expect(response.status).toBe(200);
    expect(query.getKinds).toHaveBeenCalledWith({ ...kinds, limit: 7 });
  });

  it.each(endpoints)(
    'keeps %s independently optional',
    async (endpoint, method) => {
      // Arrange
      const other = method === 'getEntities' ? 'getKinds' : 'getEntities';
      const otherPath = endpoint === 'entities' ? 'kinds' : 'entities';
      const { server, query } = await startApi({ missing: [other] });
      // Act
      const supported = await request(server)
        .get(`${basePath}/${endpoint}`)
        .set('Authorization', mockCredentials.user.header());
      const unsupported = await request(server)
        .get(`${basePath}/${otherPath}`)
        .set('Authorization', mockCredentials.user.header());
      // Assert
      expect(supported.status).toBe(200);
      expect(unsupported.status).toBe(501);
      expect(query[method]).toHaveBeenCalledTimes(1);
      expect(query[other]).not.toHaveBeenCalled();
    },
  );

  it.each([false, true])(
    'does not shadow original timeline/version/detail/feed routes with legacy store=%s',
    async legacy => {
      // Arrange
      const { server, query } = await startApi({
        missing: legacy ? ['getEntities', 'getKinds'] : [],
      });
      const entityPath = `${basePath}/entities/component/default/example`;
      const provider = '  MiXeD%_Provider  ';
      // Act
      const responses = [];
      for (const path of [
        `${entityPath}/history`,
        `${entityPath}/versions`,
        `${entityPath}/versions/1`,
        `${basePath}/changes`,
      ]) {
        responses.push(
          await request(server)
            .get(path)
            .query(path.endsWith('/1') ? {} : { provider })
            .set('Authorization', mockCredentials.user.header()),
        );
      }
      // Assert
      expect(responses.map(response => response.status)).toEqual([
        200, 200, 200, 200,
      ]);
      expect(query.getEntityTimeline).toHaveBeenCalledWith(
        expect.objectContaining({
          entityRef: 'component:default/example',
          provider,
        }),
      );
      expect(query.getEntityVersions).toHaveBeenCalledWith(
        expect.objectContaining({
          entityRef: 'component:default/example',
          provider,
        }),
      );
      expect(query.getEntityVersion).toHaveBeenCalledWith({
        entityRef: 'component:default/example',
        id: '1',
      });
      expect(query.getChangeFeed).toHaveBeenCalledWith(
        expect.objectContaining({ provider }),
      );
      expect(query.getEntities).not.toHaveBeenCalled();
      expect(query.getKinds).not.toHaveBeenCalled();
    },
  );
});

describe('entity and kind discovery default recording-store HTTP bridge', () => {
  const databases = TestDatabases.create({ ids: ['POSTGRES_16'] });

  it('discovers canonical deleted identities and pages original-case grouped kinds from the real default store', async () => {
    // Arrange: use the actual public factory; no current catalog backend is needed.
    const db = await databases.init('POSTGRES_16');
    let store: HistoryStore | undefined;
    const consumer = createBackendModule({
      pluginId: 'catalog',
      moduleId: 'history-entity-discovery-test-consumer',
      register(reg) {
        reg.registerInit({
          deps: { store: historyStoreServiceRef },
          async init(deps) {
            store = deps.store;
          },
        });
      },
    });
    const catalog = { queryEntities: jest.fn() };
    const permissions = mockServices.permissions.mock();
    permissions.authorize.mockResolvedValue([
      { result: AuthorizeResult.ALLOW },
    ]);
    backend = await startTestBackend({
      extensionPoints: [
        [catalogProcessingExtensionPoint, { addProcessor: jest.fn() }],
      ],
      features: [
        catalogModuleHistory,
        historyStoreServiceFactory,
        consumer,
        mockServices.database.factory({ knex: db }),
        createServiceFactory({
          service: catalogServiceRef,
          deps: {},
          factory: () => catalog as unknown as CatalogService,
        }),
        permissions.factory,
        mockServices.httpAuth.factory({
          defaultCredentials: mockCredentials.none(),
        }),
        mockServices.rootConfig.factory({
          data: {
            permission: { enabled: true },
            catalog: { history: { enabled: true, api: { enabled: true } } },
          },
        }),
      ],
    });
    const at = new Date('2026-07-07T00:00:00Z');
    for (const entityRef of [
      'widget:other/deleted',
      'widget:other/departed',
      'wild:default/removed',
      'other:default/excluded',
    ]) {
      await store!.recordCycle({
        cycleId: randomUUID(),
        provider: '  Exact Provider  ',
        source: 'provider',
        mutationType: 'delta',
        startedAt: at,
        finishedAt: at,
        inserts: [],
        updates: [],
        deletes: [entityRef],
        unchangedCount: 0,
      });
    }
    await store!.recordCycle({
      cycleId: randomUUID(),
      provider: '  Exact Provider  ',
      source: 'provider',
      mutationType: 'delta',
      startedAt: at,
      finishedAt: at,
      inserts: [
        {
          entityRef: 'widget:other/recorded',
          kind: 'Widget',
          namespace: 'other',
          name: 'recorded',
          etag: 'recorded',
          metadata: {},
          spec: {},
        },
      ],
      updates: [],
      deletes: [],
      unchangedCount: 0,
    });
    // Act: both optional methods must survive the factory/store/router boundary.
    const entities = await request(backend.server)
      .get(`${basePath}/entities`)
      .query({
        prefix: 'de',
        kind: 'Widget',
        provider: '  Exact Provider  ',
        source: 'provider',
        op: 'delete',
        changedAfter: at.toISOString(),
      })
      .set('Authorization', mockCredentials.user.header());
    const absent = await request(backend.server)
      .get(`${basePath}/entities`)
      .query({ prefix: 'missing' })
      .set('Authorization', mockCredentials.user.header());
    const kinds = await request(backend.server)
      .get(`${basePath}/kinds`)
      .query({ prefix: 'wi', limit: 1 })
      .set('Authorization', mockCredentials.user.header());
    const next = await request(backend.server)
      .get(`${basePath}/kinds`)
      .query({ prefix: 'wi', cursor: kinds.body.nextCursor, limit: 1 })
      .set('Authorization', mockCredentials.user.header());
    // Assert: delete-only identities qualify and case-insensitive kinds keep their MIN original spelling.
    expect(entities.status).toBe(200);
    expect(entities.body).toEqual({
      items: [
        {
          entityRef: 'widget:other/deleted',
          kind: 'widget',
          namespace: 'other',
          name: 'deleted',
        },
        {
          entityRef: 'widget:other/departed',
          kind: 'widget',
          namespace: 'other',
          name: 'departed',
        },
      ],
    });
    expect(absent.status).toBe(200);
    expect(absent.body).toEqual({ items: [] });
    expect(kinds.status).toBe(200);
    expect(kinds.body).toEqual({
      items: ['Widget'],
      nextCursor: expect.any(String),
    });
    expect(next.status).toBe(200);
    expect(next.body).toEqual({ items: ['wild'] });
    expect(catalog.queryEntities).not.toHaveBeenCalled();
  });
});
