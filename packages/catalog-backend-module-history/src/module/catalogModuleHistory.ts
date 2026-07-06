import {
  coreServices,
  createBackendModule,
  readSchedulerServiceTaskScheduleDefinitionFromConfig,
} from '@backstage/backend-plugin-api';
import {
  catalogProcessingExtensionPoint,
  catalogServiceRef,
} from '@backstage/plugin-catalog-node';
import { type Knex, knex as createKnex } from 'knex';
import {
  ensureSchema,
  PostgresHistoryStore,
} from '@kunickiaj/catalog-history-backend';
import { HistoryRecordingCatalogProcessor } from '../processor/HistoryRecordingCatalogProcessor';
import { CatalogServiceEntityFetcher } from '../reconciler/CatalogServiceEntityFetcher';
import { reconcile } from '../reconciler/reconcile';

/**
 * Backstage backend module for the catalog-history plugin. On init it
 * resolves the database connection (either an explicit catalog.history.
 * database config or Backstage's shared database service) and runs the
 * history schema migrations. When processor-layer capture is enabled, it also
 * registers a history processor with the catalog processing extension point.
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
 *     database:           # optional; falls back to Backstage's DB
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
        database: coreServices.database,
        catalog: catalogProcessingExtensionPoint,
        catalogService: catalogServiceRef,
        scheduler: coreServices.scheduler,
        auth: coreServices.auth,
        lifecycle: coreServices.rootLifecycle,
      },
      async init({
        logger,
        config,
        database,
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

        // Note: catalog.history.database only affects the stores created by
        // this module (processor-layer capture and the scheduled reconciler).
        // Provider-layer capture is wired externally via the exported
        // HistoryRecordingEntityProvider and writes to whatever database that
        // wiring passes in — point it at the same connection if you use a
        // dedicated history database.
        const dbConfig = moduleConfig?.getOptionalConfig('database');
        const db: Knex = dbConfig
          ? createKnex({
              client: dbConfig.getOptionalString('client') ?? 'pg',
              connection: dbConfig.get('connection') as Knex.PgConnectionConfig,
            })
          : await database.getClient();

        // Backstage runs shutdown hooks as an unordered batch, so teardown
        // steps that depend on each other must live in a single hook:
        // the processor's final flush has to complete before a self-created
        // pool is destroyed, or the flush writes to a closed pool.
        const teardown: Array<() => Promise<void>> = [];
        lifecycle.addShutdownHook(async () => {
          for (const step of teardown) {
            await step();
          }
        });
        if (dbConfig) {
          // The framework owns the shared client's lifecycle, but a
          // connection pool we created ourselves is ours to close. Runs
          // last (steps are unshifted ahead of it below).
          teardown.push(async () => {
            await db.destroy();
          });
        }

        await ensureSchema(db);
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
            store: new PostgresHistoryStore(db),
            logger,
          });
          catalog.addProcessor(processor);
          // Runs before the pool-destroy step registered above.
          teardown.unshift(async () => {
            await processor.stop();
          });
        }

        if (reconcilerEnabled) {
          const fetcher = new CatalogServiceEntityFetcher({
            catalog: catalogService,
            auth,
          });
          const store = new PostgresHistoryStore(db);
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

        logger.info('catalog-history schema is ready');
      },
    });
  },
});

export default catalogModuleHistory;
