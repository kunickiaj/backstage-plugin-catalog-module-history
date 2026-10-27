import {
  type BackendFeature,
  createServiceFactory,
} from '@backstage/backend-plugin-api';
import {
  mockCredentials,
  mockServices,
  startTestBackend,
  type TestBackend,
} from '@backstage/backend-test-utils';
import {
  catalogProcessingExtensionPoint,
  catalogServiceRef,
  type CatalogService,
} from '@backstage/plugin-catalog-node';
import { AuthorizeResult } from '@backstage/plugin-permission-common';
import {
  historyStoreServiceRef,
  type HistoryStore,
} from '@kunickiaj/backstage-plugin-catalog-history-node';
import { InMemoryHistoryStore } from '@kunickiaj/backstage-plugin-catalog-history-node/testUtils';
import { catalogModuleHistory } from '../catalogModuleHistory';

export type StartHistoryApiOptions = {
  /** Query methods the store exposes. Omit a method to test its 501. */
  query?: HistoryStore['query'];
  /** `catalog.history.api.enabled`; omitted leaves the key unset. */
  apiEnabled?: boolean;
  /** `catalog.history.enabled`. Defaults to true. */
  historyEnabled?: boolean;
  /** `permission.enabled`, or omit the permission config entirely. */
  permissionFramework?: 'enabled' | 'disabled' | 'omitted';
  /** The mocked permission decision when the framework is enabled. */
  decision?: AuthorizeResult.ALLOW | AuthorizeResult.DENY;
  /** Replaces the in-memory store factory, for example with the real one. */
  storeFeatures?: BackendFeature[];
};

/**
 * Starts a test backend with only the catalog history module and mocked
 * catalog, permissions, auth, and logging. The caller must stop the backend.
 */
export async function startHistoryApi(options: StartHistoryApiOptions = {}) {
  const store = Object.assign(new InMemoryHistoryStore(), {
    query: options.query,
  });
  const permissions = mockServices.permissions.mock();
  permissions.authorize.mockResolvedValue([
    { result: options.decision ?? AuthorizeResult.ALLOW },
  ]);
  const registry = mockServices.permissionsRegistry.mock();
  const logger = mockServices.logger.mock();
  const catalog = { queryEntities: jest.fn() };
  const framework = options.permissionFramework ?? 'enabled';
  const backend: TestBackend = await startTestBackend({
    extensionPoints: [
      [catalogProcessingExtensionPoint, { addProcessor: jest.fn() }],
    ],
    features: [
      catalogModuleHistory,
      ...(options.storeFeatures ?? [
        createServiceFactory({
          service: historyStoreServiceRef,
          deps: {},
          factory: () => store,
        }),
      ]),
      createServiceFactory({
        service: catalogServiceRef,
        deps: {},
        factory: () => catalog as unknown as CatalogService,
      }),
      framework === 'enabled'
        ? permissions.factory
        : mockServices.permissions.factory(),
      registry.factory,
      logger.factory,
      mockServices.httpAuth.factory({
        defaultCredentials: mockCredentials.none(),
      }),
      mockServices.rootConfig.factory({
        data: {
          ...(framework === 'omitted'
            ? {}
            : { permission: { enabled: framework === 'enabled' } }),
          catalog: {
            history: {
              enabled: options.historyEnabled ?? true,
              ...(options.apiEnabled === undefined
                ? {}
                : { api: { enabled: options.apiEnabled } }),
            },
          },
        },
      }),
    ],
  });
  return {
    backend,
    server: backend.server,
    store,
    permissions,
    registry,
    logger,
    catalog,
  };
}
