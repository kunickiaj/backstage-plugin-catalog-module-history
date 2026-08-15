import {
  coreServices,
  createBackendModule,
  readSchedulerServiceTaskScheduleDefinitionFromConfig,
} from '@backstage/backend-plugin-api';
import {
  catalogProcessingExtensionPoint,
  catalogServiceRef,
} from '@backstage/plugin-catalog-node';
import {
  type HistoryStore,
  historyStoreServiceRef,
} from '@kunickiaj/catalog-history-node';
import { HistoryRecordingCatalogProcessor } from '../processor/HistoryRecordingCatalogProcessor';
import { CatalogServiceEntityFetcher } from '../reconciler/CatalogServiceEntityFetcher';
import { reconcile } from '../reconciler/reconcile';

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
        config: coreServices.rootConfig,
        historyStore: historyStoreServiceRef,
        catalog: catalogProcessingExtensionPoint,
        catalogService: catalogServiceRef,
        scheduler: coreServices.scheduler,
        auth: coreServices.auth,
        lifecycle: coreServices.rootLifecycle,
      },
      async init({
        logger,
        config,
        historyStore,
        catalog,
        catalogService,
        scheduler,
        auth,
        lifecycle,
      }) {
        const moduleConfig = config.getOptionalConfig('catalog.history');
        if (moduleConfig?.getOptionalBoolean('enabled') === false) {
          logger.info(
            'catalog-history is disabled via catalog.history.enabled=false; skipping schema bootstrap',
          );
          return;
        }

        const store: HistoryStore = historyStore;

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
          const schedule = scheduleConfig
            ? readSchedulerServiceTaskScheduleDefinitionFromConfig(
                scheduleConfig,
              )
            : {
                frequency: { hours: 1 },
                timeout: { minutes: 10 },
                initialDelay: { seconds: 30 },
              };

          await scheduler.scheduleTask({
            id: 'catalog-history-reconcile',
            ...schedule,
            fn: async () => {
              try {
                await reconcile({ fetcher, store, logger });
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
