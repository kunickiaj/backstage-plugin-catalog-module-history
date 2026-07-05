import {
  coreServices,
  createBackendModule,
} from '@backstage/backend-plugin-api';
import { catalogProcessingExtensionPoint } from '@backstage/plugin-catalog-node';
import { Knex, knex as createKnex } from 'knex';
import { HistoryRecordingCatalogProcessor } from '../processor/HistoryRecordingCatalogProcessor';
import { ensureSchema } from '../postgres/ensureSchema';
import { PostgresHistoryStore } from '../postgres/PostgresHistoryStore';

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
 *     provider:
 *       enabled: true     # gates provider-layer recording wrapper wiring
 *     processing:
 *       enabled: false    # opt-in CatalogProcessor capture
 *     reconciler:
 *       enabled: false    # reserved; in-process scheduled reconciliation is not implemented yet
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
        lifecycle: coreServices.rootLifecycle,
      },
      async init({ logger, config, database, catalog, lifecycle }) {
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
            reconcilerEnabled ? 'on (not yet implemented)' : 'off'
          }`,
        );

        if (processingEnabled) {
          const processor = new HistoryRecordingCatalogProcessor({
            store: new PostgresHistoryStore(db),
            logger,
          });
          catalog.addProcessor(processor);
          lifecycle.addShutdownHook(async () => {
            await processor.stop();
          });
        }

        logger.info('catalog-history schema is ready');
      },
    });
  },
});

export default catalogModuleHistory;
