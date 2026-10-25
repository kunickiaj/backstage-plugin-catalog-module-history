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
import { InputError, NotFoundError } from '@backstage/errors';
import {
  catalogProcessingExtensionPoint,
  catalogServiceRef,
  type CatalogService,
} from '@backstage/plugin-catalog-node';
import { AuthorizeResult } from '@backstage/plugin-permission-common';
import {
  catalogHistoryReadPermission,
  type HistoryCycle,
} from '@kunickiaj/backstage-plugin-catalog-history-common';
import {
  historyStoreServiceRef,
  type HistoryQueryService,
  type HistoryStore,
} from '@kunickiaj/backstage-plugin-catalog-history-node';
import { InMemoryHistoryStore } from '@kunickiaj/backstage-plugin-catalog-history-node/testUtils';
import { historyStoreServiceFactory } from '@kunickiaj/backstage-plugin-catalog-history-storage-node';
import request from 'supertest';
import { catalogModuleHistory } from '../catalogModuleHistory';

jest.setTimeout(30000);
const path = '/api/catalog/history/cycles';
const cycle: HistoryCycle = {
  cycleId: 'a1234567-89ab-cdef-0123-456789abcdef',
  provider: '  MiXeD provider  ',
  source: 'provider',
  mutationType: 'delta',
  startedAt: '2026-07-07T00:00:00.123456Z',
  finishedAt: '2026-07-07T00:00:01.987654Z',
  counts: { inserted: 2, updated: 3, deleted: 4, unchanged: 10 },
};
let backend: TestBackend | undefined;

async function startApi(
  options: {
    list?: boolean;
    detail?: boolean;
    enabled?: boolean;
    historyEnabled?: boolean;
  } = {},
) {
  const query = {
    listCycles: jest
      .fn<
        ReturnType<HistoryQueryService['listCycles']>,
        Parameters<HistoryQueryService['listCycles']>
      >()
      .mockResolvedValue({ items: [cycle], nextCursor: 'next-list' }),
    getCycle: jest
      .fn<
        ReturnType<HistoryQueryService['getCycle']>,
        Parameters<HistoryQueryService['getCycle']>
      >()
      .mockResolvedValue({
        cycle,
        changes: { items: [], nextCursor: 'next-changes' },
      }),
    getProviders: jest.fn().mockResolvedValue({ items: [] }),
    getEntities: jest.fn().mockResolvedValue({ items: [] }),
    getKinds: jest.fn().mockResolvedValue({ items: [] }),
    getChangeFeed: jest.fn().mockResolvedValue({ items: [] }),
    getEntityTimeline: jest.fn().mockResolvedValue({ items: [] }),
    getEntityVersions: jest.fn().mockResolvedValue({ items: [] }),
    getEntityVersion: jest.fn().mockResolvedValue({ id: '1' }),
  };
  const { listCycles, getCycle, ...oldQuery } = query;
  const installedQuery = {
    ...oldQuery,
    ...(options.list === false ? {} : { listCycles }),
    ...(options.detail === false ? {} : { getCycle }),
  };
  const store = Object.assign(new InMemoryHistoryStore(), {
    query: installedQuery,
  });
  const permissions = mockServices.permissions.mock();
  permissions.authorize.mockResolvedValue([{ result: AuthorizeResult.ALLOW }]);
  const catalog = { queryEntities: jest.fn() };
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
  return {
    server: backend.server,
    query,
    installedQuery,
    permissions,
    catalog,
    logger,
  };
}

afterEach(async () => {
  await backend?.stop();
  backend = undefined;
});

describe.each([
  ['listCycles', path],
  ['getCycle', `${path}/${cycle.cycleId}`],
] as const)('cycle route %s', (method, url) => {
  it('requires explicit read ALLOW, binds the query receiver, and returns recorded DTOs', async () => {
    // Arrange: the store, not the current catalog, determines retained history.
    const { server, query, installedQuery, permissions, catalog } =
      await startApi();
    const expected =
      method === 'listCycles'
        ? { items: [cycle], nextCursor: 'next-list' }
        : { cycle, changes: { items: [], nextCursor: 'next-changes' } };
    // Act
    const response = await request(server)
      .get(url)
      .set('Authorization', mockCredentials.user.header());
    // Assert
    expect(response.status).toBe(200);
    expect(response.body).toEqual(expected);
    expect(query[method].mock.contexts).toEqual([installedQuery]);
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
  });

  it.each([
    ['missing', undefined],
    ['service', mockCredentials.service.header()],
    ['invalid', mockCredentials.user.invalidHeader()],
  ])(
    'rejects %s credentials before parsing or capability checks',
    async (_label, header) => {
      // Arrange
      const { server, query, permissions } = await startApi({
        list: false,
        detail: false,
      });
      const pending = request(server).get(`${url}?unknown=private`);
      if (header) pending.set('Authorization', header);
      // Act
      const response = await pending;
      // Assert
      expect(response.status).toBe(401);
      expect(permissions.authorize).not.toHaveBeenCalled();
      expect(query[method]).not.toHaveBeenCalled();
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
    'rejects %s decisions before parsing or capability checks',
    async (_label, decisions) => {
      // Arrange
      const { server, query, permissions } = await startApi({
        list: false,
        detail: false,
      });
      permissions.authorize.mockResolvedValue(decisions as never);
      // Act
      const response = await request(server)
        .get(`${url}?unknown=private`)
        .set('Authorization', mockCredentials.user.header());
      // Assert
      expect(response.status).toBe(403);
      expect(query[method]).not.toHaveBeenCalled();
    },
  );

  it('sanitizes authorization exceptions without querying', async () => {
    // Arrange
    const { server, query, permissions } = await startApi();
    permissions.authorize.mockRejectedValue(
      new Error('private-policy secret-token'),
    );
    // Act
    const response = await request(server)
      .get(url)
      .set('Authorization', mockCredentials.user.header());
    // Assert
    expect(response.status).toBe(500);
    expect(response.body.error?.message).toBe('History authorization failed');
    expect(response.text).not.toMatch(/private-policy|secret-token/);
    expect(query[method]).not.toHaveBeenCalled();
  });

  it.each([
    'entityRef=a',
    'kind=User',
    'owner=team',
    'prefix=a',
    'changedAfter=2026-07-07T00:00:00Z',
    'unknown=value',
    'limit=0',
    'cursor=',
    'limit=1&limit=2',
  ])('rejects invalid query %s before querying', async queryString => {
    // Arrange
    const { server, query } = await startApi();
    // Act
    const response = await request(server)
      .get(`${url}?${queryString}`)
      .set('Authorization', mockCredentials.user.header());
    // Assert
    expect(response.status).toBe(400);
    expect(query[method]).not.toHaveBeenCalled();
  });

  it.each([
    [
      'input',
      new InputError(
        'private-provider cursor-secret',
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
    'sanitizes %s store failures and causes',
    async (_label, error, status, message) => {
      // Arrange
      const { server, query, logger } = await startApi();
      query[method].mockRejectedValue(error);
      // Act
      const response = await request(server)
        .get(`${url}?cursor=public-request`)
        .set('Authorization', mockCredentials.user.header());
      // Assert: Backstage may echo the request URL, but never private error data.
      expect(response.status).toBe(status);
      expect(response.body.error?.message).toBe(message);
      expect(response.body.error?.stack).toBeUndefined();
      expect(response.text).not.toMatch(
        /SELECT|private_table|secret-bindings|private-provider|cursor-secret|payload/,
      );
      expect(JSON.stringify(logger.error.mock.calls)).not.toMatch(
        /SELECT|private_table|secret-bindings|private-provider|cursor-secret|payload/,
      );
    },
  );

  it('returns 501 before parsing for an authorized unsupported method', async () => {
    // Arrange
    const { server, query } = await startApi({ list: false, detail: false });
    // Act
    const response = await request(server)
      .get(`${url}?unknown=value`)
      .set('Authorization', mockCredentials.user.header());
    // Assert
    expect(response.status).toBe(501);
    expect(response.body.error?.stack).toBeUndefined();
    expect(query[method]).not.toHaveBeenCalled();
  });

  it.each([{ enabled: false }, { historyEnabled: false }])(
    'does not expose cycles when disabled: %j',
    async options => {
      // Arrange
      const { server, query } = await startApi(options);
      // Act
      const response = await request(server)
        .get(url)
        .set('Authorization', mockCredentials.user.header());
      // Assert
      expect(response.status).toBe(404);
      expect(query[method]).not.toHaveBeenCalled();
    },
  );
});

describe('cycle route-specific contracts', () => {
  it('forwards only declared list filters without normalizing provider or timestamp strings', async () => {
    // Arrange
    const { server, query } = await startApi();
    const filters = {
      source: 'processing',
      provider: "  MiXeD%_\\'雪  ",
      op: 'delete',
      mutationType: 'full',
      startedAfter: '2026-07-07T01:00:00.123456+02:00',
      startedBefore: '2026-07-07T00:00:00.987654Z',
      finishedAfter: '2026-07-07T02:00:00.123456+02:00',
      finishedBefore: '2026-07-07T01:00:00.987654Z',
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
    expect(query.listCycles).toHaveBeenCalledWith({ ...filters, limit: 7 });
  });

  it.each([
    cycle.cycleId.toUpperCase(),
    '00000000-0000-0000-0000-000000000000',
    'ffffffff-ffff-ffff-ffff-ffffffffffff',
  ])(
    'normalizes UUID %s without imposing a version restriction',
    async cycleId => {
      // Arrange
      const { server, query } = await startApi();
      // Act
      const response = await request(server)
        .get(`${path}/${cycleId}`)
        .query({ limit: 1, cursor: 'opaque+/=&?%' })
        .set('Authorization', mockCredentials.user.header());
      // Assert
      expect(response.status).toBe(200);
      expect(query.getCycle).toHaveBeenCalledWith({
        cycleId: cycleId.toLowerCase(),
        limit: 1,
        cursor: 'opaque+/=&?%',
      });
    },
  );

  it.each([
    'not-a-uuid',
    `${cycle.cycleId}%2F`,
    `${cycle.cycleId}%5C`,
    `${cycle.cycleId}%3F`,
    `${cycle.cycleId}%23`,
  ])('validates malformed path %s only after authorization', async id => {
    // Arrange
    const { server, query, permissions } = await startApi();
    // Act
    const anonymous = await request(server).get(`${path}/${id}`);
    const authorized = await request(server)
      .get(`${path}/${id}`)
      .set('Authorization', mockCredentials.user.header());
    // Assert
    expect(anonymous.status).toBe(401);
    expect(authorized.status).toBe(400);
    expect(permissions.authorize).toHaveBeenCalledTimes(1);
    expect(query.getCycle).not.toHaveBeenCalled();
  });

  it('returns 404 for a missing cycle and 200 for a recorded heartbeat', async () => {
    // Arrange
    const { server, query } = await startApi();
    const heartbeat = {
      cycle: {
        ...cycle,
        counts: { inserted: 0, updated: 0, deleted: 0, unchanged: 10 },
      },
      changes: { items: [] },
    };
    query.getCycle
      .mockRejectedValueOnce(
        new NotFoundError('private-provider SELECT secret'),
      )
      .mockResolvedValueOnce(heartbeat);
    // Act
    const missing = await request(server)
      .get(`${path}/${cycle.cycleId}`)
      .set('Authorization', mockCredentials.user.header());
    const recorded = await request(server)
      .get(`${path}/${cycle.cycleId}`)
      .set('Authorization', mockCredentials.user.header());
    // Assert
    expect(missing.status).toBe(404);
    expect(missing.text).not.toMatch(/private-provider|SELECT|secret/);
    expect(recorded.status).toBe(200);
    expect(recorded.body).toEqual(heartbeat);
  });

  it.each([
    { list: false, detail: true },
    { list: true, detail: false },
  ])('supports cycle methods independently: %j', async options => {
    // Arrange
    const { server } = await startApi(options);
    // Act
    const list = await request(server)
      .get(path)
      .set('Authorization', mockCredentials.user.header());
    const detail = await request(server)
      .get(`${path}/${cycle.cycleId}`)
      .set('Authorization', mockCredentials.user.header());
    // Assert
    expect(list.status).toBe(options.list ? 200 : 501);
    expect(detail.status).toBe(options.detail ? 200 : 501);
  });

  it('keeps old custom-store provider, identity, feed, timeline, and exact-detail reads usable', async () => {
    // Arrange
    const { server, query } = await startApi({ list: false, detail: false });
    const routes = [
      'providers',
      'entities',
      'kinds',
      'changes',
      'entities/component/default/example/history',
      'entities/component/default/example/versions',
      'entities/component/default/example/versions/1',
    ];
    // Act
    const responses = await Promise.all(
      routes.map(route =>
        request(server)
          .get(`/api/catalog/history/${route}`)
          .set('Authorization', mockCredentials.user.header()),
      ),
    );
    // Assert
    expect(responses.map(response => response.status)).toEqual(
      routes.map(() => 200),
    );
    expect(query.listCycles).not.toHaveBeenCalled();
    expect(query.getCycle).not.toHaveBeenCalled();
    expect(query.getEntityVersion).toHaveBeenCalledWith({
      entityRef: 'component:default/example',
      id: '1',
    });
  });
});

describe('cycle default recording-store HTTP integration', () => {
  const databases = TestDatabases.create({ ids: ['POSTGRES_16'] });

  it('pages recorded cycles and changes, preserves ledger counts, and distinguishes heartbeat from missing', async () => {
    // Arrange: public default factory, real PostgreSQL reads, functional module/auth.
    const db = await databases.init('POSTGRES_16');
    let store: HistoryStore | undefined;
    const consumer = createBackendModule({
      pluginId: 'catalog',
      moduleId: 'history-cycles-test-consumer',
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
    try {
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
      const ids = {
        eventful: randomUUID(),
        deletion: randomUUID(),
        heartbeat: randomUUID(),
      };
      const startedAt = new Date('2026-07-07T00:00:00Z');
      const finishedAt = new Date('2026-07-07T00:00:01Z');
      const common = {
        provider: '  MiXeD provider  ',
        source: 'provider' as const,
        mutationType: 'delta' as const,
        startedAt,
        finishedAt,
        inserts: [],
        updates: [],
        deletes: [],
        unchangedCount: 0,
      };
      const entities = ['first', 'second'].map(name => ({
        entityRef: `component:default/${name}`,
        kind: 'Component',
        namespace: 'default',
        name,
        etag: `etag-${name}`,
        metadata: { name },
        spec: {},
      }));
      await store!.recordCycle({
        ...common,
        cycleId: ids.eventful,
        inserts: entities,
        unchangedCount: 7,
      });
      await store!.recordCycle({
        ...common,
        cycleId: ids.deletion,
        startedAt: new Date('2026-07-08T00:00:00Z'),
        finishedAt: new Date('2026-07-08T00:00:01Z'),
        deletes: entities.map(entity => entity.entityRef),
      });
      await store!.recordCycle({
        ...common,
        cycleId: ids.heartbeat,
        startedAt: new Date('2026-07-09T00:00:00Z'),
        finishedAt: new Date('2026-07-09T00:00:01Z'),
        unchangedCount: 10,
      });
      const get = (url: string) =>
        request(backend!.server)
          .get(url)
          .set('Authorization', mockCredentials.user.header());
      const context = { source: 'provider', provider: common.provider };

      // Act: follow native query cursors with the original filter context.
      const first = await get(path).query({ ...context, limit: 1 });
      const rest = await get(path).query({
        ...context,
        limit: 2,
        cursor: first.body.nextCursor,
      });
      const detail = await get(`${path}/${ids.eventful}`).query({ limit: 1 });
      const detailNext = await get(`${path}/${ids.eventful}`).query({
        limit: 1,
        cursor: detail.body.changes?.nextCursor,
      });
      const deleted = await get(`${path}/${ids.deletion}`);
      const heartbeat = await get(`${path}/${ids.heartbeat}`);
      const missing = await get(`${path}/${randomUUID()}`);

      // Assert: count headers describe the ledger, not the current catalog/page.
      expect(first.status).toBe(200);
      expect(first.body).toMatchObject({
        items: [{ cycleId: ids.heartbeat }],
        nextCursor: expect.any(String),
      });
      expect(rest.status).toBe(200);
      expect(rest.body.items.map((item: HistoryCycle) => item.cycleId)).toEqual(
        [ids.deletion, ids.eventful],
      );
      expect(rest.body.nextCursor).toBeUndefined();
      const expectedCycle = {
        cycleId: ids.eventful,
        provider: common.provider,
        source: 'provider',
        mutationType: 'delta',
        startedAt: startedAt.toISOString(),
        finishedAt: finishedAt.toISOString(),
        counts: { inserted: 2, updated: 0, deleted: 0, unchanged: 7 },
      };
      expect(detail.status).toBe(200);
      expect(detailNext.status).toBe(200);
      expect(detail.body.cycle).toEqual(expectedCycle);
      expect(detailNext.body.cycle).toEqual(expectedCycle);
      expect(detail.body.changes.items).toHaveLength(1);
      expect(detail.body.changes.nextCursor).toEqual(expect.any(String));
      expect(detailNext.body.changes.items).toHaveLength(1);
      expect(detailNext.body.changes.nextCursor).toBeUndefined();
      const changes = [
        ...detail.body.changes.items,
        ...detailNext.body.changes.items,
      ];
      expect(changes.map(item => item.entityRef).sort()).toEqual(
        entities.map(entity => entity.entityRef).sort(),
      );
      changes.forEach(item =>
        expect(item).toEqual({
          id: expect.stringMatching(/^[1-9]\d*$/),
          cycleId: ids.eventful,
          entityRef: `component:default/${item.name}`,
          kind: 'Component',
          namespace: 'default',
          name: item.name,
          provider: common.provider,
          source: 'provider',
          op: 'insert',
          etag: `etag-${item.name}`,
          changedAt: finishedAt.toISOString(),
          summary: {},
        }),
      );
      expect(deleted.status).toBe(200);
      expect(deleted.body.cycle.counts).toEqual({
        inserted: 0,
        updated: 0,
        deleted: 2,
        unchanged: 0,
      });
      expect(deleted.body.changes.items).toHaveLength(2);
      expect(
        deleted.body.changes.items.every(
          (item: { op: string }) => item.op === 'delete',
        ),
      ).toBe(true);
      expect(heartbeat.status).toBe(200);
      expect(heartbeat.body).toMatchObject({
        cycle: {
          cycleId: ids.heartbeat,
          counts: { inserted: 0, updated: 0, deleted: 0, unchanged: 10 },
        },
        changes: { items: [] },
      });
      expect(missing.status).toBe(404);
      expect(catalog.queryEntities).not.toHaveBeenCalled();
    } finally {
      await backend?.stop();
      backend = undefined;
      await db.destroy();
    }
  });
});
