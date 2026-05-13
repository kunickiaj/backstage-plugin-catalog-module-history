import {
  coreServices,
  createBackendModule,
} from '@backstage/backend-plugin-api';
import { Knex, knex as createKnex } from 'knex';
import { ensureSchema } from '../postgres/ensureSchema';

/**
 * Backstage backend module for the catalog-history plugin. On init it
 * resolves the database connection (either an explicit catalog.history.
 * database config or Backstage's shared database service) and runs the
 * history schema migrations. That's the entire module surface today.
 *
 * Wrapping individual EntityProviders for cycle recording is handled at
 * backend wiring time via the exported `HistoryRecordingEntityProvider`.
 *
 * Reconciliation is intentionally not scheduled in-process. The
 * reconciler ({@link reconcile}) and the CLI shim (`bin/reconcile-
 * catalog-history.js`) remain available for on-demand drift detection or
 * an external CronJob; they're not run automatically because the wrapper
 * captures every mutation the catalog itself ingests, making a periodic
 * full catalog snapshot from inside the catalog plugin unnecessary in
 * the common case.
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
      },
      async init({ logger, config, database }) {
        const moduleConfig = config.getOptionalConfig('catalog.history');
        if (moduleConfig?.getOptionalBoolean('enabled') === false) {
          logger.info(
            'catalog-history is disabled via catalog.history.enabled=false; skipping schema bootstrap',
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
      },
    });
  },
});

export default catalogModuleHistory;
