import {
  coreServices,
  createServiceFactory,
} from '@backstage/backend-plugin-api';
import { type Knex, knex as createKnex } from 'knex';
import { historyStoreServiceRef } from '@kunickiaj/backstage-plugin-catalog-history-node';
import { PostgresHistoryStore } from '../postgres/PostgresHistoryStore';
import { normalizeQueryTimeoutMs } from '../postgres/historyQueryTimeout';

/**
 * Default factory for {@link @kunickiaj/backstage-plugin-catalog-history-node#historyStoreServiceRef}.
 *
 * Resolves the consuming plugin's history database and provides a
 * {@link PostgresHistoryStore} bound to that connection. By default it uses
 * Backstage's database service. For compatibility it also honors the
 * deprecated `catalog.history.database` override, but custom storage should be
 * supplied by registering a different factory for `historyStoreServiceRef`.
 *
 * The store runs history schema migrations lazily through `ensureReady()` or
 * before its first read/write, so consumers can depend on the service without
 * forcing schema bootstrap when history is disabled.
 *
 * Add it to the backend alongside modules that consume the ref:
 *
 * ```ts
 * import { historyStoreServiceFactory } from '@kunickiaj/backstage-plugin-catalog-history-storage-node';
 *
 * backend.add(historyStoreServiceFactory);
 * ```
 *
 * @public
 */
export const historyStoreServiceFactory = createServiceFactory({
  service: historyStoreServiceRef,
  deps: {
    config: coreServices.rootConfig,
    database: coreServices.database,
    logger: coreServices.logger,
    lifecycle: coreServices.lifecycle,
  },
  async factory({ config, database, logger, lifecycle }) {
    const queryTimeoutMs = normalizeQueryTimeoutMs(
      config.getOptionalBoolean('catalog.history.enabled') === false
        ? undefined
        : config.getOptionalNumber('catalog.history.api.queryTimeoutMs'),
    );
    const dbConfig = config.getOptionalConfig('catalog.history.database');
    let db: Knex;
    let ownsDatabase = false;

    if (dbConfig) {
      logger.warn(
        'catalog.history.database is deprecated; register a custom historyStoreServiceRef factory instead',
      );
      db = createKnex({
        client: dbConfig.getOptionalString('client') ?? 'pg',
        connection: dbConfig.get('connection') as
          | string
          | Knex.PgConnectionConfig,
      });
      ownsDatabase = true;
    } else {
      db = await database.getClient();
    }

    const store = new PostgresHistoryStore(db, {
      ownsDatabase,
      queryTimeoutMs,
    });
    lifecycle.addShutdownHook(async () => {
      await store.shutdown();
    });
    logger.info('catalog-history store is configured');
    return store;
  },
});
