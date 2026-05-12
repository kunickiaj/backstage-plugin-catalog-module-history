import {
  coreServices,
  createBackendModule,
  readSchedulerServiceTaskScheduleDefinitionFromConfig,
  type SchedulerServiceTaskScheduleDefinition,
} from '@backstage/backend-plugin-api';
import { catalogServiceRef } from '@backstage/plugin-catalog-node';
import { Knex, knex as createKnex } from 'knex';
import { ensureSchema } from '../postgres/ensureSchema';
import { PostgresHistoryStore } from '../postgres/PostgresHistoryStore';
import { reconcile } from '../reconciler/reconcile';
import { EntityFetcher } from '../reconciler/EntityFetcher';

const DEFAULT_RECONCILER_SCHEDULE: SchedulerServiceTaskScheduleDefinition = {
  frequency: { hours: 1 },
  timeout: { minutes: 10 },
};

/**
 * Backstage backend module that bootstraps the catalog history schema and
 * runs the reconciler on a schedule. Wrapping individual EntityProviders is
 * handled by users at backend wiring time via the exported
 * `HistoryRecordingEntityProvider` class.
 *
 * Config (all optional, sensible defaults):
 *
 * ```yaml
 * catalog:
 *   history:
 *     enabled: true              # set to false to disable the module entirely
 *     database:                  # optional; falls back to Backstage's DB
 *       client: pg
 *       connection: ${PG_HISTORY_URL}
 *     reconciler:
 *       enabled: true            # set to false if running an external CronJob
 *       frequency: { hours: 1 }
 *       timeout: { minutes: 10 }
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
        scheduler: coreServices.scheduler,
        auth: coreServices.auth,
        catalog: catalogServiceRef,
      },
      async init({ logger, config, database, scheduler, auth, catalog }) {
        const moduleConfig = config.getOptionalConfig('catalog.history');
        if (moduleConfig?.getOptionalBoolean('enabled') === false) {
          logger.info(
            'catalog-history is disabled via catalog.history.enabled=false; no schema bootstrap, no reconciler scheduled',
          );
          return;
        }

        const dbConfig = moduleConfig?.getOptionalConfig('database');
        const db: Knex = dbConfig
          ? createKnex({
              client: dbConfig.getOptionalString('client') ?? 'pg',
              connection: dbConfig.get('connection') as Knex.PgConnectionConfig,
            })
          : await database.getClient();

        await ensureSchema(db);
        logger.info('catalog-history schema is ready');

        const store = new PostgresHistoryStore(db);

        const reconcilerConfig = moduleConfig?.getOptionalConfig('reconciler');
        const reconcilerEnabled =
          reconcilerConfig?.getOptionalBoolean('enabled') !== false;

        if (!reconcilerEnabled) {
          logger.info(
            'catalog-history reconciler is disabled; expect to run the reconciler CLI externally',
          );
          return;
        }

        const schedule: SchedulerServiceTaskScheduleDefinition =
          reconcilerConfig
            ? readSchedulerServiceTaskScheduleDefinitionFromConfig(
                reconcilerConfig,
              )
            : DEFAULT_RECONCILER_SCHEDULE;

        const fetcher: EntityFetcher = {
          async getEntities() {
            const credentials = await auth.getOwnServiceCredentials();
            const response = await catalog.getEntities({}, { credentials });
            return response.items;
          },
        };

        await scheduler.scheduleTask({
          ...schedule,
          id: 'catalog-history-reconciler',
          scope: 'global',
          fn: async () => {
            try {
              await reconcile({ fetcher, store, logger });
            } catch (err) {
              logger.error(
                'Reconciler run failed',
                err instanceof Error ? err : { error: String(err) },
              );
            }
          },
        });

        logger.info(
          'catalog-history reconciler scheduled (scope=global, runs in-process across replicas with distributed locking)',
        );
      },
    });
  },
});

export default catalogModuleHistory;
