import {
  coreServices,
  createServiceFactory,
} from '@backstage/backend-plugin-api';
import { historyStoreServiceRef } from '@kunickiaj/catalog-history-node';
import { ensureSchema } from '../postgres/ensureSchema';
import { PostgresHistoryStore } from '../postgres/PostgresHistoryStore';

/**
 * Default factory for {@link @kunickiaj/catalog-history-node#historyStoreServiceRef}.
 *
 * Resolves the consuming plugin's database through Backstage's database
 * service, runs the history schema migrations, and provides a
 * {@link PostgresHistoryStore} bound to that connection.
 *
 * Add it to the backend alongside modules that consume the ref:
 *
 * ```ts
 * import { historyStoreServiceFactory } from '@kunickiaj/catalog-history-backend';
 *
 * backend.add(historyStoreServiceFactory);
 * ```
 *
 * Note: this factory only covers the shared Backstage database service. The
 * catalog history module still constructs its own store directly because it
 * supports a dedicated `catalog.history.database` connection override that
 * this factory cannot express yet; the module is rewired to consume this ref
 * in a follow-up.
 *
 * @public
 */
export const historyStoreServiceFactory = createServiceFactory({
  service: historyStoreServiceRef,
  deps: {
    database: coreServices.database,
    logger: coreServices.logger,
  },
  async factory({ database, logger }) {
    const db = await database.getClient();
    await ensureSchema(db);
    logger.info('catalog-history store schema is ready');
    return new PostgresHistoryStore(db);
  },
});
