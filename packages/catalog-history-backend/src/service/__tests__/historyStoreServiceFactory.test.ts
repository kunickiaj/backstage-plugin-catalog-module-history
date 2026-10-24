import { randomUUID } from 'node:crypto';
import {
  createBackendModule,
  createBackendPlugin,
} from '@backstage/backend-plugin-api';
import {
  TestDatabases,
  ServiceFactoryTester,
  mockServices,
  startTestBackend,
  type TestBackend,
} from '@backstage/backend-test-utils';
import {
  historyStoreServiceRef,
  type HistoryStore,
} from '@kunickiaj/backstage-plugin-catalog-history-node';
import type { Knex } from 'knex';
import * as knexModule from 'knex';
import * as storeModule from '../../postgres/PostgresHistoryStore';
import { historyStoreServiceFactory } from '../historyStoreServiceFactory';

jest.mock('../../postgres/PostgresHistoryStore', () => {
  const actual = jest.requireActual('../../postgres/PostgresHistoryStore');
  return {
    ...actual,
    PostgresHistoryStore: jest.fn(
      (db, options) => new actual.PostgresHistoryStore(db, options),
    ),
  };
});

jest.setTimeout(30000);

describe('historyStoreServiceFactory', () => {
  const databases = TestDatabases.create({ ids: ['POSTGRES_16'] });
  let db: Knex;
  let backend: TestBackend | undefined;

  beforeEach(async () => {
    db = await databases.init('POSTGRES_16');
  });

  afterEach(async () => {
    await backend?.stop();
    backend = undefined;
  });

  it('runs migrations and provides a working PostgresHistoryStore', async () => {
    let store: HistoryStore | undefined;

    const testPlugin = createBackendPlugin({
      pluginId: 'history-store-test',
      register(reg) {
        reg.registerInit({ deps: {}, async init() {} });
      },
    });
    const consumer = createBackendModule({
      pluginId: 'history-store-test',
      moduleId: 'consumer',
      register(reg) {
        reg.registerInit({
          deps: { historyStore: historyStoreServiceRef },
          async init({ historyStore }) {
            store = historyStore;
          },
        });
      },
    });

    backend = await startTestBackend({
      features: [
        testPlugin,
        consumer,
        historyStoreServiceFactory,
        mockServices.database.factory({ knex: db }),
      ],
    });

    // Service creation itself is intentionally cheap; schema bootstrap is
    // deferred until the store is prepared/used so disabled consumers can
    // depend on the service without mutating the database.
    let cycleTable = await db('information_schema.tables')
      .where({ table_name: 'catalog_history_cycles' })
      .first();
    expect(cycleTable).toBeUndefined();

    await store!.ensureReady?.();

    // Migrations ran during explicit store preparation.
    cycleTable = await db('information_schema.tables')
      .where({ table_name: 'catalog_history_cycles' })
      .first();
    expect(cycleTable).toBeDefined();

    // The provided store is functional end to end.
    expect(store).toBeDefined();
    const cycleId = randomUUID();
    await store!.recordCycle({
      cycleId,
      provider: 'factory-test',
      source: 'provider',
      mutationType: 'full',
      startedAt: new Date(),
      finishedAt: new Date(),
      inserts: [
        {
          entityRef: 'user:default/alice',
          kind: 'User',
          namespace: 'default',
          name: 'alice',
          etag: 'etag-1',
          metadata: {},
          spec: {},
        },
      ],
      updates: [],
      deletes: [],
      unchangedCount: 0,
    });

    const etags = await store!.loadCurrentEtags('factory-test');
    expect(etags.get('user:default/alice')).toBe('etag-1');
  });
});

describe('historyStoreServiceFactory query timeout configuration', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  function setup(history: {
    enabled?: boolean;
    api?: { queryTimeoutMs?: number | string | null };
    database?: { client: string; connection: string };
  }) {
    const db = { destroy: jest.fn() } as unknown as Knex;
    const database = mockServices.database.mock({
      getClient: jest.fn().mockResolvedValue(db),
    });
    const tester = ServiceFactoryTester.from(historyStoreServiceFactory, {
      dependencies: [
        database.factory,
        mockServices.rootConfig.factory({ data: { catalog: { history } } }),
      ],
    });
    return { db, database, tester };
  }

  it.each([
    [undefined, 10000],
    [null, 10000],
    [321, 321],
    ['321', 321],
    [0, 0],
  ])(
    'passes configured timeout %s to the store as %s',
    async (configured, expected) => {
      // Arrange: ConfigReader treats null as absent and parses numeric strings.
      // Mock resource acquisition, not SQL execution or cancellation.
      const constructor = jest.mocked(storeModule.PostgresHistoryStore);
      const { db, database, tester } = setup(
        configured === undefined ? {} : { api: { queryTimeoutMs: configured } },
      );
      // Act
      const store = await tester.getSubject();
      // Assert: construction stays lazy and uses the shared database service.
      expect(constructor).toHaveBeenCalledWith(db, {
        ownsDatabase: false,
        queryTimeoutMs: expected,
      });
      expect(database.getClient).toHaveBeenCalledTimes(1);
      expect(store.query).toBeDefined();
      await store.shutdown?.();
      expect(db.destroy).not.toHaveBeenCalled();
    },
  );

  it.each(['bad', NaN, Infinity, -1, 0.5, 2147483648])(
    'rejects invalid configuration %s before shared or owned database acquisition',
    async queryTimeoutMs => {
      // Arrange
      const ownedPool = jest.spyOn(knexModule, 'knex');
      const shared = setup({ api: { queryTimeoutMs } });
      const owned = setup({
        api: { queryTimeoutMs },
        database: {
          client: 'pg',
          connection: 'postgres://unused.invalid/history',
        },
      });
      // Act / Assert: neither path may acquire a resource before validation.
      await expect(shared.tester.getSubject()).rejects.toThrow();
      await expect(owned.tester.getSubject()).rejects.toThrow();
      expect(shared.database.getClient).not.toHaveBeenCalled();
      expect(owned.database.getClient).not.toHaveBeenCalled();
      expect(ownedPool).not.toHaveBeenCalled();
    },
  );

  it('ignores an invalid unused setting when history is disabled', async () => {
    // Arrange
    const { database, tester } = setup({
      enabled: false,
      api: { queryTimeoutMs: 'unused' },
    });
    // Act
    const store = await tester.getSubject();
    // Assert: disabled consumers can resolve the lazy service without a schema query.
    expect(store.query).toBeDefined();
    expect(database.getClient).toHaveBeenCalledTimes(1);
    await store.shutdown?.();
  });
});
