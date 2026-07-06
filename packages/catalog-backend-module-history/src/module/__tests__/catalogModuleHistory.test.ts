import { createServiceFactory } from '@backstage/backend-plugin-api';
import type { Entity } from '@backstage/catalog-model';
import {
  catalogProcessingExtensionPoint,
  catalogServiceRef,
  type CatalogService,
} from '@backstage/plugin-catalog-node';
import {
  TestDatabases,
  mockServices,
  startTestBackend,
  type TestBackend,
} from '@backstage/backend-test-utils';
import { historyStoreServiceFactory } from '@kunickiaj/catalog-history-backend';
import {
  historyStoreServiceRef,
  type HistoryStore,
} from '@kunickiaj/catalog-history-node';
import { InMemoryHistoryStore } from '@kunickiaj/catalog-history-node/testUtils';
import type { Knex } from 'knex';
import { HistoryRecordingCatalogProcessor } from '../../processor/HistoryRecordingCatalogProcessor';
import catalogHistoryFeatureLoader from '../..';
import { catalogModuleHistory } from '../catalogModuleHistory';

jest.setTimeout(30000);

describe('catalogModuleHistory', () => {
  const databases = TestDatabases.create({ ids: ['POSTGRES_16'] });
  const fakeCatalogService = {
    queryEntities: jest.fn(),
  };
  const catalogServiceFactory = createServiceFactory({
    service: catalogServiceRef,
    deps: {},
    factory: () => fakeCatalogService as unknown as CatalogService,
  });
  let db: Knex;
  let backend: TestBackend | undefined;

  function customStoreFactory(store: HistoryStore) {
    return createServiceFactory({
      service: historyStoreServiceRef,
      deps: {},
      factory: () => store,
    });
  }

  function user(name: string): Entity {
    return {
      apiVersion: 'backstage.io/v1alpha1',
      kind: 'User',
      metadata: { name, namespace: 'default', etag: `${name}-etag` },
      spec: {},
    };
  }

  function overrideConnection(): string {
    const connection = db.client.config.connection as
      | string
      | Knex.PgConnectionConfig;
    if (typeof connection === 'string') {
      return connection;
    }

    const testConnectionString =
      process.env.BACKSTAGE_TEST_DATABASE_POSTGRES16_CONNECTION_STRING;
    if (testConnectionString && typeof connection.database === 'string') {
      const url = new URL(testConnectionString);
      url.pathname = `/${connection.database}`;
      return url.toString();
    }

    const dbUser = connection.user ?? 'postgres';
    const password =
      typeof connection.password === 'string' ? connection.password : '';
    const host = connection.host ?? 'localhost';
    const port = connection.port ?? 5432;
    const database = connection.database ?? 'postgres';
    return `postgres://${encodeURIComponent(dbUser)}:${encodeURIComponent(
      password,
    )}@${host}:${port}/${database}`;
  }

  beforeEach(async () => {
    jest.clearAllMocks();
    fakeCatalogService.queryEntities.mockReset();
    db = await databases.init('POSTGRES_16');
  });

  afterEach(async () => {
    // Release scheduled work, DB handles, and service factories so the
    // suite doesn't leak handles or interfere with the next test.
    await backend?.stop();
    backend = undefined;
  });

  it('bootstraps the history schema on init by default', async () => {
    backend = await startTestBackend({
      extensionPoints: [
        [catalogProcessingExtensionPoint, { addProcessor: jest.fn() }],
      ],
      features: [
        historyStoreServiceFactory,
        catalogModuleHistory,
        catalogServiceFactory,
        mockServices.database.factory({ knex: db }),
        mockServices.rootConfig.factory({ data: {} }),
      ],
    });

    const cycleTable = await db('information_schema.tables')
      .where({ table_name: 'catalog_history_cycles' })
      .first();
    expect(cycleTable).toBeDefined();

    const entityTable = await db('information_schema.tables')
      .where({ table_name: 'catalog_history_entities' })
      .first();
    expect(entityTable).toBeDefined();
  });

  it('default package export wires both store factory and catalog module', async () => {
    const loaded = await (
      catalogHistoryFeatureLoader as unknown as {
        loader(deps: {}): Promise<unknown[]>;
      }
    ).loader({});

    expect(loaded).toEqual([historyStoreServiceFactory, catalogModuleHistory]);
  });

  it('honors deprecated catalog.history.database through the default store factory', async () => {
    const logger = mockServices.logger.mock();

    backend = await startTestBackend({
      extensionPoints: [
        [catalogProcessingExtensionPoint, { addProcessor: jest.fn() }],
      ],
      features: [
        historyStoreServiceFactory,
        catalogModuleHistory,
        catalogServiceFactory,
        logger.factory,
        mockServices.database.factory({ knex: db }),
        mockServices.rootConfig.factory({
          data: {
            catalog: {
              history: {
                database: {
                  connection: overrideConnection(),
                },
              },
            },
          },
        }),
      ],
    });

    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('catalog.history.database is deprecated'),
    );
    const cycleTable = await db('information_schema.tables')
      .where({ table_name: 'catalog_history_cycles' })
      .first();
    expect(cycleTable).toBeDefined();
  });

  it('skips schema bootstrap when catalog.history.enabled=false', async () => {
    backend = await startTestBackend({
      extensionPoints: [
        [catalogProcessingExtensionPoint, { addProcessor: jest.fn() }],
      ],
      features: [
        historyStoreServiceFactory,
        catalogModuleHistory,
        catalogServiceFactory,
        mockServices.database.factory({ knex: db }),
        mockServices.rootConfig.factory({
          data: { catalog: { history: { enabled: false } } },
        }),
      ],
    });

    const cycleTable = await db('information_schema.tables')
      .where({ table_name: 'catalog_history_cycles' })
      .first();
    expect(cycleTable).toBeUndefined();
  });

  it('boots with layer config keys and bootstraps the history schema', async () => {
    const logger = mockServices.logger.mock();
    const scheduler = mockServices.scheduler.mock();

    backend = await startTestBackend({
      extensionPoints: [
        [catalogProcessingExtensionPoint, { addProcessor: jest.fn() }],
      ],
      features: [
        historyStoreServiceFactory,
        catalogModuleHistory,
        catalogServiceFactory,
        logger.factory,
        scheduler.factory,
        mockServices.database.factory({ knex: db }),
        mockServices.rootConfig.factory({
          data: {
            catalog: {
              history: {
                provider: { enabled: true },
                processing: { enabled: true },
                reconciler: {
                  enabled: true,
                  schedule: {
                    frequency: { minutes: 30 },
                    timeout: { minutes: 5 },
                    initialDelay: { seconds: 30 },
                  },
                },
              },
            },
          },
        }),
      ],
    });

    const cycleTable = await db('information_schema.tables')
      .where({ table_name: 'catalog_history_cycles' })
      .first();
    expect(cycleTable).toBeDefined();

    const entityTable = await db('information_schema.tables')
      .where({ table_name: 'catalog_history_entities' })
      .first();
    expect(entityTable).toBeDefined();

    // Loose match on purpose: the exact sentence is not a contract, and a
    // full-string assertion forces churn in every PR that touches wording.
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining('provider=on'),
    );
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining('processing=on'),
    );
  });

  it('registers the history processor when processing capture is enabled', async () => {
    const addProcessor = jest.fn();

    backend = await startTestBackend({
      extensionPoints: [[catalogProcessingExtensionPoint, { addProcessor }]],
      features: [
        historyStoreServiceFactory,
        catalogModuleHistory,
        catalogServiceFactory,
        mockServices.database.factory({ knex: db }),
        mockServices.rootConfig.factory({
          data: { catalog: { history: { processing: { enabled: true } } } },
        }),
      ],
    });

    expect(addProcessor).toHaveBeenCalledTimes(1);
    expect(addProcessor.mock.calls[0][0]).toBeInstanceOf(
      HistoryRecordingCatalogProcessor,
    );
  });

  it('does not register the history processor by default', async () => {
    const addProcessor = jest.fn();

    backend = await startTestBackend({
      extensionPoints: [[catalogProcessingExtensionPoint, { addProcessor }]],
      features: [
        historyStoreServiceFactory,
        catalogModuleHistory,
        catalogServiceFactory,
        mockServices.database.factory({ knex: db }),
        mockServices.rootConfig.factory({ data: {} }),
      ],
    });

    expect(addProcessor).not.toHaveBeenCalled();
  });

  it('schedules the reconciler when reconciler capture is enabled', async () => {
    const scheduler = mockServices.scheduler.mock();

    backend = await startTestBackend({
      extensionPoints: [
        [catalogProcessingExtensionPoint, { addProcessor: jest.fn() }],
      ],
      features: [
        historyStoreServiceFactory,
        catalogModuleHistory,
        catalogServiceFactory,
        scheduler.factory,
        mockServices.database.factory({ knex: db }),
        mockServices.rootConfig.factory({
          data: { catalog: { history: { reconciler: { enabled: true } } } },
        }),
      ],
    });

    expect(scheduler.scheduleTask).toHaveBeenCalledTimes(1);
    expect(scheduler.scheduleTask).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'catalog-history-reconcile',
        frequency: { hours: 1 },
        timeout: { minutes: 10 },
        initialDelay: { seconds: 30 },
      }),
    );
  });

  it('does not schedule the reconciler by default', async () => {
    const scheduler = mockServices.scheduler.mock();

    backend = await startTestBackend({
      extensionPoints: [
        [catalogProcessingExtensionPoint, { addProcessor: jest.fn() }],
      ],
      features: [
        historyStoreServiceFactory,
        catalogModuleHistory,
        catalogServiceFactory,
        scheduler.factory,
        mockServices.database.factory({ knex: db }),
        mockServices.rootConfig.factory({ data: {} }),
      ],
    });

    expect(scheduler.scheduleTask).not.toHaveBeenCalled();
  });

  it('schedules the reconciler with explicit schedule config', async () => {
    const scheduler = mockServices.scheduler.mock();

    backend = await startTestBackend({
      extensionPoints: [
        [catalogProcessingExtensionPoint, { addProcessor: jest.fn() }],
      ],
      features: [
        historyStoreServiceFactory,
        catalogModuleHistory,
        catalogServiceFactory,
        scheduler.factory,
        mockServices.database.factory({ knex: db }),
        mockServices.rootConfig.factory({
          data: {
            catalog: {
              history: {
                reconciler: {
                  enabled: true,
                  schedule: {
                    frequency: { minutes: 30 },
                    timeout: { minutes: 5 },
                  },
                },
              },
            },
          },
        }),
      ],
    });

    expect(scheduler.scheduleTask).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'catalog-history-reconcile',
        frequency: { minutes: 30 },
        timeout: { minutes: 5 },
      }),
    );
  });

  it('passes the injected history store to processor capture', async () => {
    const store = new InMemoryHistoryStore();
    const addProcessor = jest.fn();

    backend = await startTestBackend({
      extensionPoints: [[catalogProcessingExtensionPoint, { addProcessor }]],
      features: [
        catalogModuleHistory,
        catalogServiceFactory,
        customStoreFactory(store),
        mockServices.rootConfig.factory({
          data: { catalog: { history: { processing: { enabled: true } } } },
        }),
      ],
    });

    const processor = addProcessor.mock
      .calls[0][0] as HistoryRecordingCatalogProcessor;
    await processor.postProcessEntity(
      user('di-processor'),
      { type: 'url', target: 'https://example.com' },
      jest.fn(),
      {} as never,
    );
    await processor.stop();

    expect(store.cycles).toHaveLength(1);
    expect(store.cycles[0].inserts.map(row => row.entityRef)).toEqual([
      'user:default/di-processor',
    ]);
  });

  it('passes the injected history store to scheduled reconciler capture', async () => {
    const store = new InMemoryHistoryStore();
    const scheduler = mockServices.scheduler.mock();
    fakeCatalogService.queryEntities.mockResolvedValue({
      items: [user('di-reconciler')],
      pageInfo: {},
    });

    backend = await startTestBackend({
      extensionPoints: [
        [catalogProcessingExtensionPoint, { addProcessor: jest.fn() }],
      ],
      features: [
        catalogModuleHistory,
        catalogServiceFactory,
        customStoreFactory(store),
        scheduler.factory,
        mockServices.rootConfig.factory({
          data: { catalog: { history: { reconciler: { enabled: true } } } },
        }),
      ],
    });

    await scheduler.scheduleTask.mock.calls[0][0].fn(
      new AbortController().signal,
    );

    expect(store.cycles).toHaveLength(1);
    expect(store.cycles[0]).toMatchObject({
      provider: 'reconciler',
      source: 'reconciler',
      mutationType: 'full',
    });
    expect(store.cycles[0].inserts.map(row => row.entityRef)).toEqual([
      'user:default/di-reconciler',
    ]);
  });
});
