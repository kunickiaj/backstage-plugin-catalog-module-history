import { randomUUID } from 'node:crypto';
import {
  createBackendModule,
  createBackendPlugin,
} from '@backstage/backend-plugin-api';
import {
  TestDatabases,
  mockServices,
  startTestBackend,
  type TestBackend,
} from '@backstage/backend-test-utils';
import {
  historyStoreServiceRef,
  type HistoryStore,
} from '@kunickiaj/catalog-history-node';
import type { Knex } from 'knex';
import { historyStoreServiceFactory } from '../historyStoreServiceFactory';

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
