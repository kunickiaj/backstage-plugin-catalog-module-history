import { randomUUID } from 'node:crypto';
import {
  createBackendModule,
  type BackendFeature,
} from '@backstage/backend-plugin-api';
import {
  mockCredentials,
  mockServices,
  TestDatabases,
  type TestBackend,
} from '@backstage/backend-test-utils';
import { InputError } from '@backstage/errors';
import { AuthorizeResult } from '@backstage/plugin-permission-common';
import { catalogHistoryReadPermission } from '@kunickiaj/backstage-plugin-catalog-history-common';
import {
  historyStoreServiceRef,
  type HistoryQueryService,
  type HistoryStore,
} from '@kunickiaj/backstage-plugin-catalog-history-node';
import { historyStoreServiceFactory } from '@kunickiaj/backstage-plugin-catalog-history-storage-node';
import request from '../__testUtils__/testBackendRequest';
import { startHistoryApi } from '../__testUtils__/startHistoryApi';

jest.setTimeout(30000);

const path = '/api/catalog/history/changes';
const entityPath = '/api/catalog/history/entities/component/default/example';
type Query = Pick<
  HistoryQueryService,
  | 'getChangeFeed'
  | 'getEntityTimeline'
  | 'getEntityVersions'
  | 'getEntityVersion'
>;

function createQuery(): jest.Mocked<Query> {
  return {
    getChangeFeed: jest.fn().mockResolvedValue({ items: [] }),
    getEntityTimeline: jest.fn().mockResolvedValue({ items: [] }),
    getEntityVersions: jest.fn().mockResolvedValue({ items: [] }),
    getEntityVersion: jest.fn(),
  };
}

let backend: TestBackend | undefined;

async function startApi(
  options: {
    enabled?: boolean;
    historyEnabled?: boolean;
    legacy?: boolean;
    features?: BackendFeature[];
  } = {},
) {
  const query = createQuery();
  const { getChangeFeed: _unused, ...legacyQuery } = query;
  const api = await startHistoryApi({
    query: options.legacy ? legacyQuery : query,
    apiEnabled: options.enabled ?? true,
    historyEnabled: options.historyEnabled,
    storeFeatures: options.features,
  });
  backend = api.backend;
  const { permissions, catalog, logger } = api;
  return { server: api.server, query, permissions, catalog, logger };
}

afterEach(async () => {
  await backend?.stop();
  backend = undefined;
});

describe('global catalog history change feed', () => {
  it('requires explicit ALLOW and returns the global page without checking live catalog visibility', async () => {
    // Arrange
    const { server, query, permissions, catalog } = await startApi();
    const item = {
      id: '42',
      cycleId: 'cycle-42',
      entityRef: 'user:other/deleted',
      kind: 'User',
      namespace: 'other',
      name: 'deleted',
      source: 'provider' as const,
      provider: 'one',
      op: 'delete' as const,
      changedAt: '2026-07-07T00:00:00.000Z',
      summary: {},
    };
    query.getChangeFeed.mockResolvedValue({
      items: [item],
      nextCursor: 'opaque-page',
    });

    // Act
    const response = await request(server)
      .get(path)
      .set('Authorization', mockCredentials.user.header());

    // Assert
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ items: [item], nextCursor: 'opaque-page' });
    expect(query.getChangeFeed).toHaveBeenCalledWith({ limit: 25 });
    expect(permissions.authorize).toHaveBeenCalledWith(
      [{ permission: catalogHistoryReadPermission }],
      expect.objectContaining({
        credentials: expect.objectContaining({
          principal: expect.objectContaining({ type: 'user' }),
        }),
      }),
    );
    expect(catalog.queryEntities).not.toHaveBeenCalled();
    expect(query.getEntityTimeline).not.toHaveBeenCalled();
  });

  it.each([
    ['missing', undefined],
    ['service', mockCredentials.service.header()],
    ['invalid', mockCredentials.user.invalidHeader()],
  ])(
    'rejects %s credentials before querying or authorizing',
    async (_label, header) => {
      // Arrange
      const { server, query, permissions } = await startApi();
      const pending = request(server).get(path);
      if (header) pending.set('Authorization', header);

      // Act
      const response = await pending;

      // Assert
      expect(response.status).toBe(401);
      expect(query.getChangeFeed).not.toHaveBeenCalled();
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
  ])('rejects %s decisions before querying', async (_label, decisions) => {
    // Arrange
    const { server, query, permissions } = await startApi();
    permissions.authorize.mockResolvedValue(decisions as never);

    // Act
    const response = await request(server)
      .get(path)
      .set('Authorization', mockCredentials.user.header());

    // Assert
    expect(response.status).toBe(403);
    expect(query.getChangeFeed).not.toHaveBeenCalled();
  });

  it('forwards supported filters and an opaque cursor', async () => {
    // Arrange
    const { server, query } = await startApi();
    const filters = {
      entityRef: 'Component:Default/Example',
      kind: 'Component',
      source: 'processing',
      provider: 'one?',
      op: 'update',
      changedAfter: '2026-07-07T01:00:00+02:00',
      changedBefore: '2026-07-07T00:00:00Z',
      limit: '2',
      cursor: 'opaque+/cursor=',
    };

    // Act
    const response = await request(server)
      .get(path)
      .query(filters)
      .set('Authorization', mockCredentials.user.header());

    // Assert
    expect(response.status).toBe(200);
    expect(query.getChangeFeed).toHaveBeenCalledWith({
      ...filters,
      entityRef: 'component:default/example',
      limit: 2,
    });
  });

  it.each([
    ['Example', 'component:default/example'],
    ['Other/Example', 'component:other/example'],
    ['User:Example', 'user:default/example'],
  ])(
    'normalizes short entity reference %s and caps limits',
    async (entityRef, canonical) => {
      // Arrange
      const { server, query } = await startApi();

      // Act
      const response = await request(server)
        .get(path)
        .query({ entityRef, limit: 101 })
        .set('Authorization', mockCredentials.user.header());

      // Assert
      expect(response.status).toBe(200);
      expect(query.getChangeFeed).toHaveBeenCalledWith({
        entityRef: canonical,
        limit: 100,
      });
    },
  );

  it.each([
    'owner=group:default/team',
    'unknown=value',
    'kind=',
    'kind=User&kind=Component',
    'kind=Comp%25',
    'kind=Comp_',
    'kind=bad:kind',
    'kind=1Component',
    'entityRef=',
    'entityRef=component:default/',
    'entityRef=bad:kind:default/a',
    'entityRef=component:bad%20namespace/a',
    'entityRef=a&entityRef=b',
    'source=unknown',
    'source=provider&source=processing',
    'provider=',
    'provider=one&provider=two',
    'op=invalid',
    'cursor=',
    'cursor=a&cursor=b',
    'limit=0',
    'limit=1.5',
    'limit=-1',
    'limit=9007199254740992',
    'changedAfter=2026-02-30T00:00:00Z',
    'changedBefore=2026-07-07',
    'changedAfter=2026-07-07T00:00:00',
    'changedAfter=2026-07-08T00:00:00Z&changedBefore=2026-07-07T00:00:00Z',
  ])(
    'rejects invalid global query %s without falling back to all history',
    async raw => {
      // Arrange
      const { server, query } = await startApi();

      // Act
      const response = await request(server)
        .get(`${path}?${raw}`)
        .set('Authorization', mockCredentials.user.header());

      // Assert
      expect(response.status).toBe(400);
      expect(query.getChangeFeed).not.toHaveBeenCalled();
    },
  );

  it('maps invalid cursors to 400 and hides unexpected query errors', async () => {
    // Arrange
    const { server, query } = await startApi();
    query.getChangeFeed
      .mockRejectedValueOnce(new InputError('Invalid history page cursor'))
      .mockRejectedValueOnce(new Error('SELECT private_table secret-password'));

    // Act
    const invalid = await request(server)
      .get(`${path}?cursor=invalid`)
      .set('Authorization', mockCredentials.user.header());
    const failed = await request(server)
      .get(path)
      .set('Authorization', mockCredentials.user.header());

    // Assert
    expect(invalid.status).toBe(400);
    expect(failed.status).toBe(500);
    expect(failed.body.error?.message).toBe(
      'Unable to retrieve catalog history',
    );
    expect(failed.text).not.toMatch(/private_table|secret-password|SELECT/);
    expect(failed.body.error?.stack).toBeUndefined();
  });

  it('fails closed when permission authorization fails', async () => {
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
    expect(response.text).not.toMatch(/private-policy|secret-token/);
    expect(query.getChangeFeed).not.toHaveBeenCalled();
  });

  it('keeps legacy entity routes and authenticates/authorizes before reporting unsupported global reads', async () => {
    // Arrange: this custom store implements only the original three query methods.
    const { server, query, permissions } = await startApi({ legacy: true });

    // Act
    const anonymous = await request(server).get(path);
    permissions.authorize.mockResolvedValueOnce([
      { result: AuthorizeResult.DENY },
    ]);
    const denied = await request(server)
      .get(path)
      .set('Authorization', mockCredentials.user.header());
    const unsupported = await request(server)
      .get(path)
      .set('Authorization', mockCredentials.user.header());
    const entity = await request(server)
      .get(`${entityPath}/history`)
      .set('Authorization', mockCredentials.user.header());

    // Assert
    expect(anonymous.status).toBe(401);
    expect(denied.status).toBe(403);
    expect(unsupported.status).toBe(501);
    expect(unsupported.body.error?.stack).toBeUndefined();
    expect(unsupported.text).not.toMatch(
      /TypeError|getChangeFeed is not a function/,
    );
    expect(entity.status).toBe(200);
    expect(entity.body).toEqual({ items: [] });
    expect(query.getEntityTimeline).toHaveBeenCalledTimes(1);
    expect(query.getChangeFeed).not.toHaveBeenCalled();
  });

  it.each([{ enabled: false }, { historyEnabled: false }])(
    'does not expose global reads when disabled: %j',
    async options => {
      // Arrange
      const { server, query } = await startApi(options);

      // Act
      const response = await request(server)
        .get(path)
        .set('Authorization', mockCredentials.user.header());

      // Assert
      expect(response.status).toBe(404);
      expect(query.getChangeFeed).not.toHaveBeenCalled();
    },
  );
});

describe('change feed recording-store database integration', () => {
  const databases = TestDatabases.create({ ids: ['POSTGRES_16'] });

  it('reads cross-entity changes and deleted-row detail from the same database used by recordCycle', async () => {
    // Arrange: resolve the default writer, with no separate reader or live entities.
    const db = await databases.init('POSTGRES_16');
    let store: HistoryStore | undefined;
    const consumer = createBackendModule({
      pluginId: 'catalog',
      moduleId: 'history-change-feed-test-consumer',
      register(reg) {
        reg.registerInit({
          deps: { store: historyStoreServiceRef },
          async init(deps) {
            store = deps.store;
          },
        });
      },
    });
    const { server, catalog } = await startApi({
      features: [
        historyStoreServiceFactory,
        consumer,
        mockServices.database.factory({ knex: db }),
      ],
    });
    const component = {
      entityRef: 'component:default/example',
      kind: 'Component',
      namespace: 'default',
      name: 'example',
      etag: 'same',
      metadata: { name: 'example', description: 'recorded component' },
      spec: { type: 'service' },
    };
    const user = {
      entityRef: 'user:other/alice',
      kind: 'User',
      namespace: 'other',
      name: 'alice',
      etag: 'same',
      metadata: { name: 'alice', description: 'recorded user' },
      spec: {},
    };
    const at = new Date('2026-07-07T00:00:00Z');
    const cycle = {
      source: 'provider' as const,
      provider: 'one',
      mutationType: 'delta' as const,
      startedAt: at,
      finishedAt: at,
      unchangedCount: 0,
    };
    await store!.recordCycle({
      ...cycle,
      cycleId: randomUUID(),
      inserts: [component, user],
      updates: [],
      deletes: [],
    });
    await store!.recordCycle({
      ...cycle,
      cycleId: randomUUID(),
      source: 'reconciler',
      inserts: [],
      updates: [],
      deletes: [user.entityRef],
    });

    // Act: discover IDs globally, then use each row's own entity reference for detail.
    const first = await request(server)
      .get(path)
      .query({ limit: 2 })
      .set('Authorization', mockCredentials.user.header());
    const second = await request(server)
      .get(path)
      .query({ limit: 2, cursor: first.body.nextCursor })
      .set('Authorization', mockCredentials.user.header());
    const deleted = first.body.items[0];
    const [kind, rest] = deleted.entityRef.split(':');
    const [namespace, name] = rest.split('/');
    const detail = await request(server)
      .get(
        `/api/catalog/history/entities/${kind}/${namespace}/${name}/versions/${deleted.id}`,
      )
      .set('Authorization', mockCredentials.user.header());
    const wrongEntity = await request(server)
      .get(`${entityPath}/versions/${deleted.id}`)
      .set('Authorization', mockCredentials.user.header());
    const filtered = await request(server)
      .get(path)
      .query({ entityRef: 'Example', kind: 'cOmPoNeNt' })
      .set('Authorization', mockCredentials.user.header());
    const conflict = await request(server)
      .get(path)
      .query({ entityRef: 'Example', kind: 'User' })
      .set('Authorization', mockCredentials.user.header());
    const invalidCursor = await request(server)
      .get(`${path}?cursor=not-a-cursor`)
      .set('Authorization', mockCredentials.user.header());

    // Assert
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(first.body.items).toHaveLength(2);
    expect(first.body.nextCursor).toEqual(expect.any(String));
    expect(second.body.items).toHaveLength(1);
    expect(second.body.nextCursor).toBeUndefined();
    const items = [...first.body.items, ...second.body.items];
    expect(new Set(items.map(item => item.id)).size).toBe(3);
    expect(items.map(item => item.entityRef)).toEqual([
      user.entityRef,
      user.entityRef,
      component.entityRef,
    ]);
    expect(deleted).toMatchObject({
      op: 'delete',
      source: 'reconciler',
      kind: 'user',
      namespace: 'other',
      name: 'alice',
    });
    expect(JSON.stringify(items)).not.toMatch(
      /snapshot|recorded component|recorded user/,
    );
    expect(detail.status).toBe(200);
    expect(detail.body).toMatchObject({
      id: deleted.id,
      entityRef: user.entityRef,
      op: 'delete',
    });
    expect(detail.body.snapshot).toBeUndefined();
    expect(wrongEntity.status).toBe(404);
    expect(filtered.status).toBe(200);
    expect(filtered.body.items).toEqual([
      expect.objectContaining({ entityRef: component.entityRef }),
    ]);
    expect(conflict.status).toBe(200);
    expect(conflict.body.items).toEqual([]);
    expect(invalidCursor.status).toBe(400);
    expect(catalog.queryEntities).not.toHaveBeenCalled();
  });
});
