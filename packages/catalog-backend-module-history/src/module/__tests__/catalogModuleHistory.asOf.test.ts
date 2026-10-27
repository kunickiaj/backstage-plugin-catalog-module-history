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
import {
  catalogHistoryReadPermission,
  type HistoryEntityAsOfResponse,
} from '@kunickiaj/backstage-plugin-catalog-history-common';
import {
  historyStoreServiceRef,
  type HistoryStore,
  type HistoryQueryService,
} from '@kunickiaj/backstage-plugin-catalog-history-node';
import { historyStoreServiceFactory } from '@kunickiaj/backstage-plugin-catalog-history-storage-node';
import request from '../__testUtils__/testBackendRequest';
import { catalogModuleHistory } from '../catalogModuleHistory';
import { startHistoryApi } from '../__testUtils__/startHistoryApi';

jest.setTimeout(30000);
let backend: TestBackend | undefined;
const base = '/api/catalog/history';
const path = `${base}/entities/component/default/example/as-of`;
const timestamp = '2026-07-07T01:00:00.123456+02:00';
const unknown = { entityRef: 'component:default/example', asOf: timestamp };

async function startApi(
  options: {
    missing?: boolean;
    enabled?: boolean;
    historyEnabled?: boolean;
  } = {},
) {
  const query = {
    getEntityAsOf: jest
      .fn<
        ReturnType<HistoryQueryService['getEntityAsOf']>,
        Parameters<HistoryQueryService['getEntityAsOf']>
      >()
      .mockResolvedValue(unknown),
    getEntityTimeline: jest.fn().mockResolvedValue({ items: [] }),
    getEntityVersions: jest.fn().mockResolvedValue({ items: [] }),
    getEntityVersion: jest.fn().mockResolvedValue({ id: '1' }),
    getChangeFeed: jest.fn().mockResolvedValue({ items: [] }),
    getEntities: jest.fn().mockResolvedValue({ items: [] }),
    getKinds: jest.fn().mockResolvedValue({ items: [] }),
    getProviders: jest.fn().mockResolvedValue({ items: [] }),
    listCycles: jest.fn().mockResolvedValue({ items: [] }),
    getCycle: jest.fn().mockResolvedValue({ cycleId: 'test', items: [] }),
  };
  const supportedQuery = options.missing
    ? {
        getEntityTimeline: query.getEntityTimeline,
        getEntityVersions: query.getEntityVersions,
        getEntityVersion: query.getEntityVersion,
      }
    : { ...query };
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
    logger,
    catalog,
  };
}

afterEach(async () => {
  await backend?.stop();
  backend = undefined;
});

describe('as-of HTTP contract', () => {
  it('does not inspect the optional capability until authorization allows the user', async () => {
    // Arrange
    const { server, query, supportedQuery, permissions } = await startApi();
    const capability = jest.fn(() => query.getEntityAsOf);
    Object.defineProperty(supportedQuery, 'getEntityAsOf', { get: capability });
    permissions.authorize.mockResolvedValueOnce([
      { result: AuthorizeResult.DENY },
    ]);
    // Act
    const denied = await request(server)
      .get(path)
      .query({ timestamp })
      .set('Authorization', mockCredentials.user.header());
    // Assert
    expect(denied.status).toBe(403);
    expect(capability).not.toHaveBeenCalled();
    expect(query.getEntityAsOf).not.toHaveBeenCalled();
  });

  it('authorizes read ALLOW, binds the query receiver and forwards only raw selectors', async () => {
    // Arrange
    const { server, query, supportedQuery, permissions, catalog } =
      await startApi();
    query.getEntityAsOf.mockImplementation(async function bound(
      this: typeof supportedQuery,
    ) {
      expect(this).toBe(supportedQuery);
      return unknown;
    });
    const provider = '  MiXeD%_雪 Provider  ';
    // Act
    const response = await request(server)
      .get(path)
      .query({ timestamp, source: 'processing', provider })
      .set('Authorization', mockCredentials.user.header());
    // Assert
    expect(response.status).toBe(200);
    expect(response.body).toEqual(unknown);
    expect(query.getEntityAsOf).toHaveBeenCalledWith({
      entityRef: 'component:default/example',
      timestamp,
      source: 'processing',
      provider,
    });
    expect(permissions.authorize).toHaveBeenCalledWith(
      [{ permission: catalogHistoryReadPermission }],
      expect.objectContaining({
        credentials: expect.objectContaining({
          principal: expect.objectContaining({ type: 'user' }),
        }),
      }),
    );
    expect(catalog.queryEntities).not.toHaveBeenCalled();
    expect(query.getEntityVersion).not.toHaveBeenCalled();
    expect(query.getEntityTimeline).not.toHaveBeenCalled();
  });

  it.each([
    ['missing', undefined],
    ['service', mockCredentials.service.header()],
    ['invalid', mockCredentials.user.invalidHeader()],
  ])(
    'rejects %s credentials before parsing, querying or exposing capability',
    async (_label, header) => {
      // Arrange
      const { server, query, permissions } = await startApi({ missing: true });
      const pending = request(server).get(`${path}?unknown=private`);
      if (header) pending.set('Authorization', header);
      // Act
      const response = await pending;
      // Assert
      expect(response.status).toBe(401);
      expect(permissions.authorize).not.toHaveBeenCalled();
      expect(query.getEntityAsOf).not.toHaveBeenCalled();
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
    'rejects %s permission before parse/query/501',
    async (_label, decisions) => {
      // Arrange
      const { server, query, permissions } = await startApi({ missing: true });
      permissions.authorize.mockResolvedValue(decisions as never);
      // Act
      const response = await request(server)
        .get(`${path}?unknown=private`)
        .set('Authorization', mockCredentials.user.header());
      // Assert
      expect(response.status).toBe(403);
      expect(query.getEntityAsOf).not.toHaveBeenCalled();
    },
  );

  it('sanitizes authorization failures without querying', async () => {
    // Arrange
    const { server, query, permissions } = await startApi();
    permissions.authorize.mockRejectedValue(
      new Error('private-policy secret-token'),
    );
    // Act
    const response = await request(server)
      .get(path)
      .query({ timestamp })
      .set('Authorization', mockCredentials.user.header());
    // Assert
    expect(response.status).toBe(500);
    expect(response.body.error.message).toBe('History authorization failed');
    expect(response.text).not.toMatch(/private-policy|secret-token/);
    expect(query.getEntityAsOf).not.toHaveBeenCalled();
  });

  it('keeps a three-method custom store working and reports authorized unsupported before invalid input', async () => {
    // Arrange
    const { server, query } = await startApi({ missing: true });
    // Act
    const unsupported = await request(server)
      .get(`${path}?unknown=private`)
      .set('Authorization', mockCredentials.user.header());
    const legacy = await request(server)
      .get(`${base}/entities/component/default/example/history`)
      .set('Authorization', mockCredentials.user.header());
    // Assert
    expect(unsupported.status).toBe(501);
    expect(unsupported.body.error.message).toBe(
      'This history store does not support reading entity history as of a timestamp.',
    );
    expect(legacy.status).toBe(200);
    expect(query.getEntityAsOf).not.toHaveBeenCalled();
    expect(query.getEntityTimeline).toHaveBeenCalledTimes(1);
  });

  it.each([{ enabled: false }, { historyEnabled: false }])(
    'keeps disabled API unavailable: %j',
    async options => {
      // Arrange
      const { server, query } = await startApi(options);
      // Act
      const response = await request(server)
        .get(path)
        .query({ timestamp })
        .set('Authorization', mockCredentials.user.header());
      // Assert
      expect(response.status).toBe(404);
      expect(query.getEntityAsOf).not.toHaveBeenCalled();
    },
  );

  it.each([
    '',
    'timestamp=',
    'timestamp=2026-02-30T00:00:00Z',
    `timestamp=${encodeURIComponent(timestamp)}&timestamp=${encodeURIComponent(timestamp)}`,
    `timestamp=${encodeURIComponent(timestamp)}&limit=1`,
    `timestamp=${encodeURIComponent(timestamp)}&provider=`,
    `timestamp=${encodeURIComponent(timestamp)}&source=unknown`,
  ])('rejects invalid query %s before the store', async queryString => {
    // Arrange
    const { server, query } = await startApi();
    // Act
    const response = await request(server)
      .get(`${path}?${queryString}`)
      .set('Authorization', mockCredentials.user.header());
    // Assert
    expect(response.status).toBe(400);
    expect(query.getEntityAsOf).not.toHaveBeenCalled();
  });

  it('rejects invalid path segments before the store', async () => {
    // Arrange
    const { server, query } = await startApi();
    // Act
    const response = await request(server)
      .get(`${base}/entities/1Invalid/default/example/as-of`)
      .query({ timestamp })
      .set('Authorization', mockCredentials.user.header());
    // Assert
    expect(response.status).toBe(400);
    expect(query.getEntityAsOf).not.toHaveBeenCalled();
  });

  it.each([
    [
      'input',
      new InputError('private-input', new Error('SELECT secret_table')),
      400,
      'Invalid history query',
    ],
    [
      'unexpected',
      new Error('SELECT secret_table secret-bindings'),
      500,
      'Unable to retrieve catalog history',
    ],
    [
      'timeout',
      Object.assign(new Error('SELECT secret_table'), {
        code: '57014',
        detail: 'private-provider',
      }),
      500,
      'Unable to retrieve catalog history',
    ],
  ])(
    'sanitizes %s store failures and private causes',
    async (_label, error, status, message) => {
      // Arrange
      const { server, query, logger } = await startApi();
      query.getEntityAsOf.mockRejectedValue(error);
      // Act
      const response = await request(server)
        .get(path)
        .query({ timestamp })
        .set('Authorization', mockCredentials.user.header());
      // Assert
      expect(response.status).toBe(status);
      expect(response.body.error.message).toBe(message);
      expect(response.body.error.stack).toBeUndefined();
      expect(response.text).not.toMatch(
        /private-input|SELECT|secret_table|secret-bindings|private-provider/,
      );
      expect(JSON.stringify(logger.error.mock.calls)).not.toMatch(
        /private-input|SELECT|secret_table|secret-bindings|private-provider/,
      );
    },
  );

  it('returns unknown retained data as 200 without a version or snapshot', async () => {
    // Arrange
    const { server, catalog } = await startApi();
    // Act
    const response = await request(server)
      .get(path)
      .query({ timestamp })
      .set('Authorization', mockCredentials.user.header());
    // Assert
    expect(response.status).toBe(200);
    expect(response.body).toEqual(unknown);
    expect(catalog.queryEntities).not.toHaveBeenCalled();
  });

  it('does not shadow existing entity, discovery, provider or cycle routes', async () => {
    // Arrange
    const { server, query } = await startApi();
    const entity = `${base}/entities/component/default/example`;
    // Act
    const responses = [];
    for (const route of [
      `${entity}/history`,
      `${entity}/versions`,
      `${entity}/versions/1`,
      `${base}/entities`,
      `${base}/providers`,
      `${base}/kinds`,
      `${base}/changes`,
      `${base}/cycles`,
      `${base}/cycles/00000000-0000-4000-8000-000000000001`,
    ]) {
      responses.push(
        await request(server)
          .get(route)
          .set('Authorization', mockCredentials.user.header()),
      );
    }
    const oldRoute = await request(server)
      .get(`${base}/as-of`)
      .query({ timestamp })
      .set('Authorization', mockCredentials.user.header());
    // Assert
    expect(responses.map(response => response.status)).toEqual(
      Array(9).fill(200),
    );
    expect(oldRoute.status).toBe(404);
    expect(query.getEntityAsOf).not.toHaveBeenCalled();
  });
});

describe('as-of default recording-store PostgreSQL HTTP bridge', () => {
  const databases = TestDatabases.create({ ids: ['POSTGRES_16'] });

  it('returns one physical saved observation, tombstones and unknown data through the real factory', async () => {
    // Arrange: the host supplies only the catalog extension point, never live entity data.
    const db = await databases.init('POSTGRES_16');
    let store: HistoryStore | undefined;
    const consumer = createBackendModule({
      pluginId: 'catalog',
      moduleId: 'history-as-of-test-consumer',
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
    const provider = '  Exact Provider  ';
    const entityRef = 'component:default/example';
    const observations = [
      {
        time: '2026-07-07T00:00:01Z',
        source: 'provider' as const,
        provider,
        cycleId: '00000000-0000-4000-8000-000000000001',
        name: 'first',
      },
      {
        time: '2026-07-07T00:00:02Z',
        source: 'processing' as const,
        provider: 'processor',
        cycleId: '00000000-0000-4000-8000-000000000002',
        name: 'processed',
      },
      {
        time: '2026-07-07T00:00:03Z',
        source: 'provider' as const,
        provider,
        cycleId: '00000000-0000-4000-8000-000000000003',
      },
      {
        time: '2026-07-07T00:00:04Z',
        source: 'provider' as const,
        provider,
        cycleId: '00000000-0000-4000-8000-000000000004',
        name: 'reinserted',
      },
      {
        time: '2026-07-07T00:00:05Z',
        source: 'provider' as const,
        provider: 'other',
        cycleId: '00000000-0000-4000-8000-000000000005',
        name: 'other-provider',
      },
    ];
    for (const observation of observations) {
      const at = new Date(observation.time);
      await store!.recordCycle({
        cycleId: observation.cycleId,
        source: observation.source,
        provider: observation.provider,
        mutationType: 'delta',
        startedAt: at,
        finishedAt: at,
        inserts: observation.name
          ? [
              {
                entityRef,
                kind: 'Component',
                namespace: 'default',
                name: 'example',
                etag: observation.name,
                metadata: { name: observation.name },
                spec: { saved: observation.name },
              },
            ]
          : [],
        updates: [],
        deletes: observation.name ? [] : [entityRef],
        unchangedCount: 0,
      });
    }
    const get = async (
      cutoff: string,
      filters: { source?: string; provider?: string } = {},
    ) =>
      request(backend!.server)
        .get(path)
        .query({ timestamp: cutoff, ...filters })
        .set('Authorization', mockCredentials.user.header());
    // Act: raw microseconds and offsets cross parser, store capability and actual PostgreSQL query.
    const live = await get('2026-07-07T02:00:02.999999+02:00', {
      source: 'provider',
      provider,
    });
    const anyLayer = await get('2026-07-07T00:00:02Z');
    const deleted = await get('2026-07-07T00:00:03Z', {
      source: 'provider',
      provider,
    });
    const reinserted = await get('2026-07-07T00:00:05Z', {
      source: 'provider',
      provider,
    });
    const anyProvider = await get('2026-07-07T00:00:05Z');
    const before = await get('2026-07-07T00:00:00Z');
    const wrongProvider = await get('2026-07-07T00:00:05Z', {
      provider: provider.trim(),
    });
    // Assert: metadata and the two snapshots belong to the same retained row, without predecessor comparison.
    for (const response of [
      live,
      anyLayer,
      deleted,
      reinserted,
      anyProvider,
      before,
      wrongProvider,
    ])
      expect(response.status).toBe(200);
    const body = live.body as HistoryEntityAsOfResponse;
    expect(body.entityRef).toBe(entityRef);
    expect(body.asOf).toBe('2026-07-07T02:00:02.999999+02:00');
    expect(body.version).toMatchObject({
      cycleId: observations[0].cycleId,
      source: 'provider',
      provider,
      op: 'insert',
      summary: {},
    });
    expect(body.snapshot).toEqual(body.version?.snapshot);
    expect(body.snapshot).toMatchObject({
      metadata: { name: 'first' },
      spec: { saved: 'first' },
    });
    expect(anyLayer.body.version).toMatchObject({
      cycleId: observations[1].cycleId,
      source: 'processing',
      provider: 'processor',
    });
    expect(anyLayer.body.snapshot.metadata.name).toBe('processed');
    expect(deleted.body.version).toMatchObject({
      cycleId: observations[2].cycleId,
      op: 'delete',
      source: 'provider',
      provider,
      summary: {},
    });
    expect(deleted.body.snapshot).toBeUndefined();
    expect(deleted.body.version.snapshot).toBeUndefined();
    expect(reinserted.body.version.cycleId).toBe(observations[3].cycleId);
    expect(reinserted.body.snapshot.metadata.name).toBe('reinserted');
    expect(anyProvider.body.version.provider).toBe('other');
    expect(before.body).toEqual({ entityRef, asOf: '2026-07-07T00:00:00Z' });
    expect(wrongProvider.body).toEqual({
      entityRef,
      asOf: '2026-07-07T00:00:05Z',
    });
    expect(permissions.authorize).toHaveBeenCalledTimes(7);
    expect(catalog.queryEntities).not.toHaveBeenCalled();
  });
});
