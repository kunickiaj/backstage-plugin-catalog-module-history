import {
  createServiceFactory,
  ServiceRef,
} from '@backstage/backend-plugin-api';
import {
  TestDatabases,
  mockServices,
  startTestBackend,
} from '@backstage/backend-test-utils';
import { Entity } from '@backstage/catalog-model';
import {
  CatalogService,
  catalogServiceRef,
} from '@backstage/plugin-catalog-node';
import { Knex } from 'knex';
import { catalogModuleHistory } from '../catalogModuleHistory';

jest.setTimeout(30000);

function makeFakeCatalogService(entities: Entity[]): CatalogService {
  const notImplemented = () => {
    throw new Error('not implemented in this test');
  };
  return {
    async getEntities(): Promise<{ items: Entity[] }> {
      return { items: entities };
    },
    getEntitiesByRefs: notImplemented,
    queryEntities: notImplemented,
    getEntityAncestors: notImplemented,
    getEntityByRef: notImplemented,
    getEntityFacets: notImplemented,
    refreshEntity: notImplemented,
    getLocationByRef: notImplemented,
    getLocationById: notImplemented,
    getLocations: notImplemented,
    queryLocations: notImplemented,
    addLocation: notImplemented,
    removeLocationById: notImplemented,
    removeEntityByUid: notImplemented,
    validateEntity: notImplemented,
    streamEntities: notImplemented,
  } as unknown as CatalogService;
}

function fakeCatalogServiceFactory(catalog: CatalogService) {
  return createServiceFactory({
    service: catalogServiceRef as ServiceRef<
      CatalogService,
      'plugin',
      'singleton'
    >,
    deps: {},
    factory: () => catalog,
  });
}

describe('catalogModuleHistory', () => {
  const databases = TestDatabases.create({ ids: ['POSTGRES_16'] });
  let db: Knex;

  beforeEach(async () => {
    db = await databases.init('POSTGRES_16');
  });

  it('bootstraps the schema and schedules the reconciler on init', async () => {
    const catalog = makeFakeCatalogService([]);

    await startTestBackend({
      features: [
        catalogModuleHistory,
        fakeCatalogServiceFactory(catalog),
        mockServices.database.factory({ knex: db }),
        mockServices.rootConfig.factory({
          data: {
            catalog: {
              history: {
                enabled: true,
                reconciler: {
                  enabled: true,
                  frequency: { seconds: 60 },
                  timeout: { minutes: 1 },
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
  });
});
