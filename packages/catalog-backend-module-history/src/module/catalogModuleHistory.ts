import {
  coreServices,
  createBackendModule,
  readSchedulerServiceTaskScheduleDefinitionFromConfig,
} from '@backstage/backend-plugin-api';
import { metricsServiceRef } from '@backstage/backend-plugin-api/alpha';
import { ConfigReader } from '@backstage/config';
import type { JsonObject } from '@backstage/types';
import {
  catalogProcessingExtensionPoint,
  catalogServiceRef,
} from '@backstage/plugin-catalog-node';
import {
  type HistoryStore,
  historyStoreServiceRef,
} from '@kunickiaj/backstage-plugin-catalog-history-node';
import { catalogHistoryReadPermission } from '@kunickiaj/backstage-plugin-catalog-history-common';
import { HistoryRecordingCatalogProcessor } from '../processor/HistoryRecordingCatalogProcessor';
import { CatalogServiceEntityFetcher } from '../reconciler/CatalogServiceEntityFetcher';
import { reconcile } from '../reconciler/reconcile';
import { createHistoryRouter } from '../service/createHistoryRouter';

const DEFAULT_RECONCILER_SCHEDULE = {
  frequency: { hours: 1 },
  timeout: { minutes: 10 },
  initialDelay: { seconds: 30 },
};

/**
 * Backstage backend module for the catalog-history plugin. On init it
 * resolves the history store from Backstage DI and prepares it for use. When
 * processor-layer capture is enabled, it also registers a history processor
 * with the catalog processing extension point.
 *
 * Wrapping individual EntityProviders for cycle recording is handled at
 * backend wiring time via the exported `HistoryRecordingEntityProvider`.
 *
 * Reconciliation is opt-in and can be scheduled in-process via Backstage's
 * scheduler service. The external CLI shim (`bin/reconcile-catalog-history.js`)
 * also remains available for ad-hoc drift detection or external CronJobs.
 *
 * Config (all optional, sensible defaults):
 *
 * ```yaml
 * catalog:
 *   history:
 *     enabled: true       # set to false to skip schema bootstrap entirely
 *     database:           # deprecated compatibility override honored by the default historyStoreServiceFactory
 *       client: pg
 *       connection: ${PG_HISTORY_URL}
 *     provider:
 *       enabled: true     # gates provider-layer recording wrapper wiring
 *     processing:
 *       enabled: false    # opt-in CatalogProcessor capture
 *     reconciler:
 *       enabled: false    # opt-in scheduled in-process reconciliation
 *       schedule:
 *         frequency: { minutes: 30 }
 *         timeout: { minutes: 5 }
 *         initialDelay: { seconds: 30 }
 * ```
 */
export const catalogModuleHistory = createBackendModule({
  pluginId: 'catalog',
  moduleId: 'history',
  register(reg) {
    reg.registerInit({
      deps: {
        logger: coreServices.logger,
        metrics: metricsServiceRef,
        config: coreServices.rootConfig,
        historyStore: historyStoreServiceRef,
        catalog: catalogProcessingExtensionPoint,
        catalogService: catalogServiceRef,
        scheduler: coreServices.scheduler,
        auth: coreServices.auth,
        lifecycle: coreServices.rootLifecycle,
        httpRouter: coreServices.httpRouter,
        httpAuth: coreServices.httpAuth,
        permissions: coreServices.permissions,
        permissionsRegistry: coreServices.permissionsRegistry,
      },
      async init({
        logger,
        metrics,
        config,
        historyStore,
        catalog,
        catalogService,
        scheduler,
        auth,
        lifecycle,
        httpRouter,
        httpAuth,
        permissions,
        permissionsRegistry,
      }) {
        const moduleConfig = config.getOptionalConfig('catalog.history');
        if (moduleConfig?.getOptionalBoolean('enabled') === false) {
          logger.info(
            'catalog-history is disabled via catalog.history.enabled=false; skipping schema bootstrap',
          );
          return;
        }

        const store: HistoryStore = historyStore;
        if (moduleConfig?.getOptionalBoolean('api.enabled') === true) {
          if (
            !store.query ||
            typeof store.query.getEntityTimeline !== 'function' ||
            typeof store.query.getEntityVersions !== 'function' ||
            typeof store.query.getEntityVersion !== 'function'
          ) {
            throw new Error(
              'Catalog history API requires historyStoreServiceRef to provide timeline, version list, and exact version query methods backed by the recording store',
            );
          }
          const router = createHistoryRouter({
            query: store.query,
            httpAuth,
            permissions,
            config,
            logger,
          });
          permissionsRegistry.addPermissions([catalogHistoryReadPermission]);
          httpRouter.use(router);
        }

        // Backstage runs shutdown hooks as an unordered batch, so teardown
        // steps that depend on each other must live in a single hook:
        // the processor's final flush has to complete before a self-created
        // pool is destroyed, or the flush writes to a closed pool.
        const teardown: Array<() => Promise<void>> = [];
        lifecycle.addShutdownHook(async () => {
          for (const step of teardown) {
            await step();
          }
          await store.shutdown?.();
        });
        await store.ensureReady?.();
        const providerEnabled =
          moduleConfig
            ?.getOptionalConfig('provider')
            ?.getOptionalBoolean('enabled') ?? true;
        const processingEnabled =
          moduleConfig
            ?.getOptionalConfig('processing')
            ?.getOptionalBoolean('enabled') ?? false;
        const reconcilerEnabled =
          moduleConfig
            ?.getOptionalConfig('reconciler')
            ?.getOptionalBoolean('enabled') ?? false;

        logger.info(
          `catalog-history capture layers: provider=${
            providerEnabled ? 'on' : 'off'
          } processing=${processingEnabled ? 'on' : 'off'} reconciler=${
            reconcilerEnabled ? 'on' : 'off'
          }`,
        );

        if (processingEnabled) {
          const processor = new HistoryRecordingCatalogProcessor({
            store,
            logger,
            metrics,
          });
          catalog.addProcessor(processor);
          const stopProcessor = async () => {
            await processor.stop();
          };
          // If the store owns a database pool, the store-level hook keeps this
          // flush ordered before pool destruction even if Backstage starts
          // lifecycle hooks as an unordered batch.
          if (store.addShutdownHook) {
            store.addShutdownHook(stopProcessor);
          } else {
            teardown.unshift(stopProcessor);
          }
        }

        if (reconcilerEnabled) {
          const fetcher = new CatalogServiceEntityFetcher({
            catalog: catalogService,
            auth,
          });
          const scheduleConfig = moduleConfig
            ?.getOptionalConfig('reconciler')
            ?.getOptionalConfig('schedule');
          // Backstage's parser requires frequency and timeout together, so
          // merge operator keys over the defaults before parsing. This lets a
          // cadence-only override inherit the default timeout and delay.
          const schedule = readSchedulerServiceTaskScheduleDefinitionFromConfig(
            new ConfigReader(
              {
                ...DEFAULT_RECONCILER_SCHEDULE,
                ...scheduleConfig?.get<JsonObject>(),
              },
              'catalog.history.reconciler.schedule',
            ),
          );

          await scheduler.scheduleTask({
            id: 'catalog-history-reconcile',
            ...schedule,
            fn: async () => {
              try {
                await reconcile({ fetcher, store, logger, metrics });
              } catch (err) {
                logger.error(
                  'catalog-history scheduled reconcile failed',
                  err instanceof Error ? err : { error: String(err) },
                );
              }
            },
          });
        }

        logger.info('catalog-history store is ready');
      },
    });
  },
});

export default catalogModuleHistory;
