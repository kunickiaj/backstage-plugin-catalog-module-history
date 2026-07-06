import { createServiceRef } from '@backstage/backend-plugin-api';
import type { HistoryStore } from '../store/HistoryStore';

/**
 * Service ref for the catalog history store.
 *
 * The default factory is provided by `@kunickiaj/catalog-history-backend`;
 * backend modules that record history should depend on this ref instead of
 * constructing their own database clients.
 *
 * Apps that need custom storage should register their own service factory for
 * this ref and pass the injected store into provider/processor constructors at
 * catalog module init time.
 *
 * Plugin-scoped: each consuming plugin gets its own factory invocation,
 * matching how Backstage scopes database connections per plugin.
 *
 * @public
 */
export const historyStoreServiceRef = createServiceRef<HistoryStore>({
  id: 'catalog-history.store',
  scope: 'plugin',
});
