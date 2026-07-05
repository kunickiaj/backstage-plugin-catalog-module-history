import { createServiceFactory } from '@backstage/backend-plugin-api';
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
import type { Knex } from 'knex';
import { HistoryRecordingCatalogProcessor } from '../../processor/HistoryRecordingCatalogProcessor';
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

  beforeEach(async () => {
    jest.clearAllMocks();
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

  it('skips schema bootstrap when catalog.history.enabled=false', async () => {
    backend = await startTestBackend({
      extensionPoints: [
        [catalogProcessingExtensionPoint, { addProcessor: jest.fn() }],
      ],
      features: [
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
});
