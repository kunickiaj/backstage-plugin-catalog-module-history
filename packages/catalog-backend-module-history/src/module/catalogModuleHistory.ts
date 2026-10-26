import {
  coreServices,
  createBackendModule,
  readSchedulerServiceTaskScheduleDefinitionFromConfig,
  type RootLifecycleService,
} from '@backstage/backend-plugin-api';
import { metricsServiceRef } from '@backstage/backend-plugin-api/alpha';
import { type Config, ConfigReader } from '@backstage/config';
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
import {
  hasActiveHistoryLayer,
  readHistoryLayers,
} from '../config/readHistoryLayers';
import { HistoryRecordingCatalogProcessor } from '../processor/HistoryRecordingCatalogProcessor';
import { CatalogServiceEntityFetcher } from '../reconciler/CatalogServiceEntityFetcher';
import { reconcile } from '../reconciler/reconcile';
import { createHistoryRouter } from '../service/createHistoryRouter';
import { readRetentionConfig } from '../retention/readRetentionConfig';
import {
  describeRetentionMode,
  requireRetentionStore,
  runRetention,
} from '../retention/runRetention';

const DEFAULT_RECONCILER_SCHEDULE = {
  frequency: { hours: 1 },
  timeout: { minutes: 10 },
  initialDelay: { seconds: 30 },
};

const DEFAULT_RETENTION_SCHEDULE = {
  frequency: { hours: 24 },
  timeout: { hours: 1 },
  initialDelay: { minutes: 5 },
};

// Backstage's parser requires frequency and timeout together, so merge
// operator keys over the defaults before parsing. This lets a cadence-only
// override inherit the default timeout and delay.
function readScheduleWithDefaults(
  scheduleConfig: Config | undefined,
  defaults: JsonObject,
  configKey: string,
) {
  return readSchedulerServiceTaskScheduleDefinitionFromConfig(
    new ConfigReader(
      { ...defaults, ...scheduleConfig?.get<JsonObject>() },
      configKey,
    ),
  );
}

/**
 * Backstage backend module for the catalog-history plugin. On init it
 * resolves the history store from Backstage DI. When history is enabled and
 * at least one read, capture, or retention layer is on, it prepares the store for use, so
 * migrations fail startup early. With history disabled or every layer off, it
 * leaves the store untouched and the default store acquires no client. When
 * processor-layer capture is enabled, it also registers a history processor
 * with the catalog processing extension point.
 *
 * Wrapping individual EntityProviders for cycle recording is handled at
 * backend wiring time via `HistoryRecordingEntityProvider.fromConfig`, which
 * shares the same plugin-scoped store.
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
 *     enabled: true       # set to false to skip database access entirely
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
 *     retention:
 *       enabled: false    # opt-in scheduled history retention
 *       maxAge: { days: 90 } # required when enabled; at least 1 day
 *       dryRun: true      # log counts only; set false to delete
 *       batchSize: 1000
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
        const layers = readHistoryLayers(config);
        if (!layers.enabled) {
          logger.info(
            'catalog-history is disabled via catalog.history.enabled=false; skipping schema bootstrap',
          );
          return;
        }

        const store: HistoryStore = historyStore;
        // Validate before any store work so bad retention config fails startup.
        const retention = readRetentionConfig(moduleConfig);
        const retentionStore = retention
          ? requireRetentionStore(store)
          : undefined;
        const retentionSchedule = retention
          ? readScheduleWithDefaults(
              moduleConfig?.getOptionalConfig('retention.schedule'),
              DEFAULT_RETENTION_SCHEDULE,
              'catalog.history.retention.schedule',
            )
          : undefined;
        if (layers.api) {
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

        const {
          provider: providerEnabled,
          processing: processingEnabled,
          reconciler: reconcilerEnabled,
        } = layers;
        logger.info(
          `catalog-history capture layers: provider=${
            providerEnabled ? 'on' : 'off'
          } processing=${processingEnabled ? 'on' : 'off'} reconciler=${
            reconcilerEnabled ? 'on' : 'off'
          }`,
        );
        logger.info(
          `catalog-history retention=${describeRetentionMode(retention)}`,
        );

        if (!hasActiveHistoryLayer(layers) && !retention) {
          logger.info(
            'catalog-history has no active read, capture, or retention layer; skipping schema bootstrap',
          );
          return;
        }

        const addTeardown = registerTeardown(lifecycle, store);
        await store.ensureReady?.();

        if (processingEnabled) {
          const processor = new HistoryRecordingCatalogProcessor({
            store,
            logger,
            metrics,
          });
          catalog.addProcessor(processor);
          addTeardown(async () => {
            await processor.stop();
          });
        }

        if (reconcilerEnabled) {
          const fetcher = new CatalogServiceEntityFetcher({
            catalog: catalogService,
            auth,
          });
          const scheduleConfig = moduleConfig
            ?.getOptionalConfig('reconciler')
            ?.getOptionalConfig('schedule');
          const schedule = readScheduleWithDefaults(
            scheduleConfig,
            DEFAULT_RECONCILER_SCHEDULE,
            'catalog.history.reconciler.schedule',
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

        if (retention && retentionStore && retentionSchedule) {
          await scheduler.scheduleTask({
            id: 'catalog-history-retention',
            ...retentionSchedule,
            fn: signal =>
              runRetention({
                store: retentionStore,
                settings: retention,
                logger,
                signal,
              }),
          });
        }

        logger.info('catalog-history store is ready');
      },
    });
  },
});

/**
 * Orders module teardown before the store releases its resources.
 *
 * Backstage runs shutdown hooks as an unordered batch, so a processor's final
 * flush must not race the destruction of a store-owned pool. A store with
 * `addShutdownHook` runs the step inside its own shutdown. Otherwise the
 * module's hook runs the steps first.
 *
 * The hook always ends with `store.shutdown`, because custom factories may
 * rely on the module for release. `shutdown` is idempotent, and plugin
 * lifecycle hooks run before root hooks, so for the default store this call
 * finds the factory's shutdown already complete.
 */
function registerTeardown(
  lifecycle: RootLifecycleService,
  store: HistoryStore,
): (step: () => Promise<void>) => void {
  const steps: Array<() => Promise<void>> = [];
  lifecycle.addShutdownHook(async () => {
    for (const step of steps) {
      await step();
    }
    await store.shutdown?.();
  });
  if (store.addShutdownHook) {
    return step => store.addShutdownHook!(step);
  }
  return step => {
    steps.unshift(step);
  };
}

export default catalogModuleHistory;
