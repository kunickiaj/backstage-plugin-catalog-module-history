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
import { InMemoryHistoryStore } from '@kunickiaj/backstage-plugin-catalog-history-node/testUtils';
import { historyStoreServiceFactory } from '@kunickiaj/backstage-plugin-catalog-history-storage-node';
import request from '../__testUtils__/testBackendRequest';
import { catalogModuleHistory } from '../catalogModuleHistory';

jest.setTimeout(30000);

const path = '/api/catalog/history/providers';
let backend: TestBackend | undefined;

async function startApi(
  options: {
    legacy?: boolean;
    enabled?: boolean;
    historyEnabled?: boolean;
  } = {},
) {
  const query = {
    getProviders: jest
      .fn<
        ReturnType<NonNullable<HistoryQueryService['getProviders']>>,
        Parameters<NonNullable<HistoryQueryService['getProviders']>>
      >()
      .mockResolvedValue({ items: [] }),
    getChangeFeed: jest.fn().mockResolvedValue({ items: [] }),
    getEntityTimeline: jest.fn().mockResolvedValue({ items: [] }),
    getEntityVersions: jest.fn().mockResolvedValue({ items: [] }),
    getEntityVersion: jest.fn(),
  };
  const { getProviders: _unused, ...legacyQuery } = query;
  const store = Object.assign(new InMemoryHistoryStore(), {
    query: options.legacy ? legacyQuery : query,
  });
  const catalog = { queryEntities: jest.fn() };
  const permissions = mockServices.permissions.mock();
  permissions.authorize.mockResolvedValue([{ result: AuthorizeResult.ALLOW }]);
  const logger = mockServices.logger.mock();
  backend = await startTestBackend({
    extensionPoints: [
      [catalogProcessingExtensionPoint, { addProcessor: jest.fn() }],
    ],
    features: [
      catalogModuleHistory,
      createServiceFactory({
        service: historyStoreServiceRef,
        deps: {},
        factory: () => store,
      }),
      createServiceFactory({
        service: catalogServiceRef,
        deps: {},
        factory: () => catalog as unknown as CatalogService,
      }),
      permissions.factory,
      logger.factory,
      mockServices.httpAuth.factory({
        defaultCredentials: mockCredentials.none(),
      }),
      mockServices.rootConfig.factory({
        data: {
          permission: { enabled: true },
          catalog: {
            history: {
              enabled: options.historyEnabled ?? true,
              api: { enabled: options.enabled ?? true },
            },
          },
        },
      }),
    ],
  });
  return { server: backend.server, query, permissions, catalog, logger };
}

afterEach(async () => {
  await backend?.stop();
  backend = undefined;
});

describe('provider discovery default recording-store integration', () => {
  // TestDatabases registers afterAll cleanup for its owned PG16 database.
  const databases = TestDatabases.create({ ids: ['POSTGRES_16'] });

  it('pages retained provider names through the real default store and HTTP route', async () => {
    // Arrange: capture the public store service without replacing its query implementation.
    const db = await databases.init('POSTGRES_16');
    let store: HistoryStore | undefined;
    const consumer = createBackendModule({
      pluginId: 'catalog',
      moduleId: 'history-providers-test-consumer',
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
    const entityRef = 'component:default/removed';
    const at = new Date('2026-07-07T00:00:00Z');
    for (const provider of [
      'Git%_A',
      'git%_b',
      'GitXX-nonliteral',
      'Git%_heartbeat',
    ]) {
      await store!.recordCycle({
        cycleId: randomUUID(),
        provider,
        source: 'provider',
        mutationType: 'delta',
        startedAt: at,
        finishedAt: at,
        inserts: [],
        updates: [],
        // Delete-only rows remain discoverable; a cycle alone does not qualify.
        deletes: provider === 'Git%_heartbeat' ? [] : [entityRef],
        unchangedCount: 0,
      });
    }
    const context = { source: 'provider', entityRef };

    // Act: the literal %_ prefix and original context survive both HTTP pages.
    const first = await request(backend.server)
      .get(`${path}?prefix=Git%25_`)
      .query({ ...context, limit: 1 })
      .set('Authorization', mockCredentials.user.header());
    const second = await request(backend.server)
      .get(`${path}?prefix=Git%25_`)
      .query({ ...context, limit: 2, cursor: first.body.nextCursor })
      .set('Authorization', mockCredentials.user.header());

    // Assert: C-order preserves case, excludes wildcard matches and heartbeat-only cycles.
    expect(first.status).toBe(200);
    expect(first.body).toEqual({
      items: ['Git%_A'],
      nextCursor: expect.any(String),
    });
    expect(second.status).toBe(200);
    expect(second.body).toEqual({ items: ['git%_b'] });
    expect(catalog.queryEntities).not.toHaveBeenCalled();
  });
});

describe('catalog history provider discovery route', () => {
  it('returns retained provider names under explicit read ALLOW without checking live catalog visibility', async () => {
    // Arrange: the query owns retention/deletion semantics, not the live catalog.
    const { server, query, permissions, catalog } = await startApi();
    const page = {
      items: ['MiXeD', 'deleted-provider'],
      nextCursor: 'opaque-page',
    };
    query.getProviders.mockImplementation(async function bound(
      this: typeof query,
    ) {
      expect(this).toBe(query);
      return page;
    });
    // Act
    const response = await request(server)
      .get(path)
      .set('Authorization', mockCredentials.user.header());
    // Assert
    expect(response.status).toBe(200);
    expect(response.body).toEqual(page);
    expect(query.getProviders).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 25 }),
    );
    expect(Object.hasOwn(query.getProviders.mock.calls[0][0], 'provider')).toBe(
      false,
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
  });

  it('forwards all declared filters without an exact provider property', async () => {
    // Arrange
    const { server, query } = await startApi();
    const filters = {
      prefix: "  MiXeD%_\\'雪  ",
      source: 'processing',
      entityRef: 'User:Teams/Deleted',
      kind: 'User',
      op: 'delete',
      changedAfter: '2026-07-07T01:00:00.123456+02:00',
      changedBefore: '2026-07-07T00:00:00.987654Z',
      limit: '7',
      cursor: 'opaque+/=&?%',
    };
    // Act
    const response = await request(server)
      .get(path)
      .query(filters)
      .set('Authorization', mockCredentials.user.header());
    // Assert
    expect(response.status).toBe(200);
    expect(query.getProviders).toHaveBeenCalledWith({
      ...filters,
      entityRef: 'user:teams/deleted',
      limit: 7,
    });
  });

  it('returns an empty supported page for an empty prefix', async () => {
    // Arrange
    const { server, query } = await startApi();
    // Act
    const response = await request(server)
      .get(`${path}?prefix=`)
      .set('Authorization', mockCredentials.user.header());
    // Assert
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ items: [] });
    expect(query.getProviders).toHaveBeenCalledWith(
      expect.objectContaining({ prefix: '', limit: 25 }),
    );
  });

  it.each([
    ['missing', undefined],
    ['service', mockCredentials.service.header()],
    ['invalid', mockCredentials.user.invalidHeader()],
  ])(
    'rejects %s credentials before parsing, authorizing, or querying',
    async (_label, header) => {
      // Arrange
      const { server, query, permissions } = await startApi();
      const pending = request(server).get(`${path}?unknown=private`);
      if (header) pending.set('Authorization', header);
      // Act
      const response = await pending;
      // Assert
      expect(response.status).toBe(401);
      expect(query.getProviders).not.toHaveBeenCalled();
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
    'rejects %s permission decisions before parsing or querying',
    async (_label, decisions) => {
      // Arrange
      const { server, query, permissions } = await startApi();
      permissions.authorize.mockResolvedValue(decisions as never);
      // Act
      const response = await request(server)
        .get(`${path}?unknown=private`)
        .set('Authorization', mockCredentials.user.header());
      // Assert
      expect(response.status).toBe(403);
      expect(query.getProviders).not.toHaveBeenCalled();
    },
  );

  it('fails closed and sanitizes authorization failures', async () => {
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
    expect(query.getProviders).not.toHaveBeenCalled();
  });

  it.each([
    'provider=exact',
    'owner=team',
    'prefix=a&prefix=b',
    'limit=0',
    'source=',
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
      expect(query.getProviders).not.toHaveBeenCalled();
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
    'sanitizes %s query failures and their causes',
    async (_label, error, status, message) => {
      // Arrange
      const { server, query, logger } = await startApi();
      query.getProviders.mockRejectedValue(error);
      // Act
      const response = await request(server)
        .get(`${path}?prefix=public-request&cursor=opaque-request`)
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

  it('starts legacy stores, authorizes before 501, and keeps original reads usable', async () => {
    // Arrange: optional provider discovery must not become a startup requirement.
    const { server, query, permissions } = await startApi({ legacy: true });
    // Act
    const anonymous = await request(server).get(`${path}?unknown=value`);
    permissions.authorize.mockResolvedValueOnce([
      { result: AuthorizeResult.DENY },
    ]);
    const denied = await request(server)
      .get(`${path}?unknown=value`)
      .set('Authorization', mockCredentials.user.header());
    const unsupported = await request(server)
      .get(path)
      .set('Authorization', mockCredentials.user.header());
    const timeline = await request(server)
      .get('/api/catalog/history/entities/component/default/example/history')
      .set('Authorization', mockCredentials.user.header());
    const feed = await request(server)
      .get('/api/catalog/history/changes')
      .set('Authorization', mockCredentials.user.header());
    // Assert
    expect(anonymous.status).toBe(401);
    expect(denied.status).toBe(403);
    expect(unsupported.status).toBe(501);
    expect(unsupported.body.error?.message).toBe(
      'This history store does not support provider discovery. Use an exact provider name or configure a store with provider-discovery support.',
    );
    expect(unsupported.body.error?.stack).toBeUndefined();
    expect(timeline.status).toBe(200);
    expect(feed.status).toBe(200);
    expect(query.getProviders).not.toHaveBeenCalled();
    expect(query.getEntityTimeline).toHaveBeenCalledTimes(1);
    expect(query.getChangeFeed).toHaveBeenCalledTimes(1);
  });

  it.each([{ enabled: false }, { historyEnabled: false }])(
    'does not expose discovery when disabled: %j',
    async options => {
      // Arrange
      const { server, query } = await startApi(options);
      // Act
      const response = await request(server)
        .get(path)
        .set('Authorization', mockCredentials.user.header());
      // Assert
      expect(response.status).toBe(404);
      expect(query.getProviders).not.toHaveBeenCalled();
    },
  );
});
