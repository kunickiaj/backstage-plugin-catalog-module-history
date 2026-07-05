import {
  TestDatabases,
  TestBackend,
  mockServices,
  startTestBackend,
} from '@backstage/backend-test-utils';
import { catalogProcessingExtensionPoint } from '@backstage/plugin-catalog-node';
import type { Knex } from 'knex';
import { HistoryRecordingCatalogProcessor } from '../../processor/HistoryRecordingCatalogProcessor';
import { catalogModuleHistory } from '../catalogModuleHistory';

jest.setTimeout(30000);

describe('catalogModuleHistory', () => {
  const databases = TestDatabases.create({ ids: ['POSTGRES_16'] });
  let db: Knex;
  let backend: TestBackend | undefined;

  beforeEach(async () => {
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

    backend = await startTestBackend({
      extensionPoints: [
        [catalogProcessingExtensionPoint, { addProcessor: jest.fn() }],
      ],
      features: [
        catalogModuleHistory,
        logger.factory,
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

    expect(logger.info).toHaveBeenCalledWith(
      'catalog-history capture layers: provider=on processing=on reconciler=on (not yet implemented)',
    );
  });

  it('registers the history processor when processing capture is enabled', async () => {
    const addProcessor = jest.fn();

    backend = await startTestBackend({
      extensionPoints: [[catalogProcessingExtensionPoint, { addProcessor }]],
      features: [
        catalogModuleHistory,
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
        mockServices.database.factory({ knex: db }),
        mockServices.rootConfig.factory({ data: {} }),
      ],
    });

    expect(addProcessor).not.toHaveBeenCalled();
  });
});
