import {
  coreServices,
  createBackendModule,
  createServiceFactory,
} from '@backstage/backend-plugin-api';
import type { Entity } from '@backstage/catalog-model';
import type { JsonObject } from '@backstage/types';
import {
  mockCredentials,
  mockServices,
  startTestBackend,
  TestDatabases,
  type TestBackend,
} from '@backstage/backend-test-utils';
import {
  catalogProcessingExtensionPoint,
  catalogServiceRef,
  type CatalogService,
  type EntityProvider,
  type EntityProviderConnection,
} from '@backstage/plugin-catalog-node';
import { AuthorizeResult } from '@backstage/plugin-permission-common';
import {
  historyStoreServiceRef,
  type HistoryStore,
} from '@kunickiaj/backstage-plugin-catalog-history-node';
import { historyStoreServiceFactory } from '@kunickiaj/backstage-plugin-catalog-history-storage-node';
import type { Knex } from 'knex';
import request from '../__testUtils__/testBackendRequest';
import { HistoryRecordingEntityProvider } from '../../provider/HistoryRecordingEntityProvider';
import { catalogModuleHistory } from '../catalogModuleHistory';

jest.setTimeout(30000);

const versionsPath =
  '/api/catalog/history/entities/User/default/alice/versions';

function alice(): Entity {
  return {
    apiVersion: 'backstage.io/v1alpha1',
    kind: 'User',
    metadata: { name: 'alice', namespace: 'default', etag: 'alice-etag' },
    spec: {},
  };
}

class StaticProvider implements EntityProvider {
  connection?: EntityProviderConnection;
  getProviderName() {
    return 'static-users';
  }
  async connect(connection: EntityProviderConnection) {
    this.connection = connection;
  }
}

describe('catalogModuleHistory initialization', () => {
  const databases = TestDatabases.create({ ids: ['POSTGRES_16'] });
  let db: Knex;
  let backend: TestBackend | undefined;
  let getClient: jest.Mock<Promise<Knex>, []>;

  beforeEach(async () => {
    db = await databases.init('POSTGRES_16');
    getClient = jest.fn(async () => db);
  });

  afterEach(async () => {
    await backend?.stop();
    backend = undefined;
  });

  async function historyTablesExist(): Promise<boolean> {
    const table = await db('information_schema.tables')
      .where({ table_name: 'catalog_history_cycles' })
      .first();
    return table !== undefined;
  }

  /**
   * Starts the default store and module plus a consumer catalog module that
   * wraps one selected provider through the config-aware constructor, and a
   * second module that only reads the injected store.
   */
  async function start(history: JsonObject) {
    const inner = new StaticProvider();
    const injected: HistoryStore[] = [];
    const addEntityProvider = jest.fn();
    const permissions = mockServices.permissions.mock();
    permissions.authorize.mockResolvedValue([
      { result: AuthorizeResult.ALLOW },
    ]);

    const providerModule = createBackendModule({
      pluginId: 'catalog',
      moduleId: 'selected-provider-history',
      register(reg) {
        reg.registerInit({
          deps: {
            catalog: catalogProcessingExtensionPoint,
            config: coreServices.rootConfig,
            logger: coreServices.logger,
            historyStore: historyStoreServiceRef,
          },
          async init({ catalog, config, logger, historyStore }) {
            injected.push(historyStore);
            catalog.addEntityProvider(
              HistoryRecordingEntityProvider.fromConfig(config, {
                inner,
                store: historyStore,
                logger,
              }),
            );
          },
        });
      },
    });
    const readerModule = createBackendModule({
      pluginId: 'catalog',
      moduleId: 'history-reader',
      register(reg) {
        reg.registerInit({
          deps: { historyStore: historyStoreServiceRef },
          async init({ historyStore }) {
            injected.push(historyStore);
          },
        });
      },
    });

    backend = await startTestBackend({
      extensionPoints: [
        [
          catalogProcessingExtensionPoint,
          { addProcessor: jest.fn(), addEntityProvider },
        ],
      ],
      features: [
        historyStoreServiceFactory,
        catalogModuleHistory,
        providerModule,
        readerModule,
        createServiceFactory({
          service: catalogServiceRef,
          deps: {},
          factory: () => ({}) as CatalogService,
        }),
        createServiceFactory({
          service: coreServices.database,
          deps: {},
          factory: () => ({ getClient }),
        }),
        permissions.factory,
        mockServices.httpAuth.factory({
          defaultCredentials: mockCredentials.none(),
        }),
        mockServices.rootConfig.factory({
          data: { permission: { enabled: true }, catalog: { history } },
        }),
      ],
    });

    const [wrapper] = addEntityProvider.mock.calls[0];
    const applyMutation = jest.fn();
    await (wrapper as EntityProvider).connect({
      applyMutation,
      refresh: jest.fn(),
    });
    const emit = () =>
      inner.connection!.applyMutation({
        type: 'full',
        entities: [{ entity: alice(), locationKey: 'static' }],
      });
    const readVersions = () =>
      request(backend!.server)
        .get(versionsPath)
        .set('Authorization', mockCredentials.user.header());

    return { injected, applyMutation, emit, readVersions };
  }

  it('acquires no client and runs no migrations when history is disabled', async () => {
    // Act
    const { emit, applyMutation, readVersions } = await start({
      enabled: false,
      api: { enabled: true },
    });
    await emit();
    // Assert: the wrapper is a passthrough and the API is not mounted.
    expect(applyMutation).toHaveBeenCalledTimes(1);
    expect((await readVersions()).status).toBe(404);
    await backend!.stop();
    backend = undefined;
    expect(getClient).not.toHaveBeenCalled();
    expect(await historyTablesExist()).toBe(false);
  });

  it('acquires no client when every read and capture layer is off', async () => {
    // Act
    const { emit } = await start({ provider: { enabled: false } });
    await emit();
    // Assert
    expect(getClient).not.toHaveBeenCalled();
    expect(await historyTablesExist()).toBe(false);
  });

  it('prepares the default store when only retention is enabled', async () => {
    // Act: retention needs the schema even with every capture layer off.
    await start({
      provider: { enabled: false },
      retention: { enabled: true, maxAge: { days: 90 } },
    });
    // Assert
    expect(getClient).toHaveBeenCalledTimes(1);
    expect(await historyTablesExist()).toBe(true);
  });

  it('serves reads without recording when only the API is enabled', async () => {
    // Act
    const { emit, applyMutation, readVersions } = await start({
      provider: { enabled: false },
      api: { enabled: true },
    });
    await emit();
    const response = await readVersions();
    // Assert
    expect(applyMutation).toHaveBeenCalledTimes(1);
    expect(response.status).toBe(200);
    expect(response.body.items).toEqual([]);
    expect(await db('catalog_history_cycles').count()).toEqual([
      { count: '0' },
    ]);
  });

  it('records selected providers without mounting reads when only provider capture is enabled', async () => {
    // Act
    const { emit, readVersions } = await start({});
    await emit();
    // Assert
    expect((await readVersions()).status).toBe(404);
    expect(await db('catalog_history_entities').pluck('entity_ref')).toEqual([
      'user:default/alice',
    ]);
  });

  it('shares one store and one client between wrappers and the read API', async () => {
    // Act
    const { injected, emit, readVersions } = await start({
      api: { enabled: true },
    });
    await emit();
    const response = await readVersions();
    // Assert
    expect(injected).toHaveLength(2);
    expect(injected[0]).toBe(injected[1]);
    expect(getClient).toHaveBeenCalledTimes(1);
    expect(response.status).toBe(200);
    expect(response.body.items).toHaveLength(1);
  });

  it('leaves the shared database pool usable after backend shutdown', async () => {
    // Arrange
    const { emit } = await start({ api: { enabled: true } });
    await emit();
    // Act
    await backend!.stop();
    backend = undefined;
    // Assert: Backstage owns this pool, so the store must not destroy it.
    expect(await db('catalog_history_cycles').count()).toEqual([
      { count: '1' },
    ]);
  });
});
