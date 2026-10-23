/** @jsxRuntime automatic */
import {
  ApiBlueprint,
  createFrontendPlugin,
  discoveryApiRef,
  fetchApiRef,
} from '@backstage/frontend-plugin-api';
import { EntityContentBlueprint } from '@backstage/plugin-catalog-react/alpha';
import { catalogHistoryApiRef } from './api/CatalogHistoryApi';
import { CatalogHistoryClient } from './api/CatalogHistoryClient';

/** Default authenticated catalog history API. @public */
export const catalogHistoryApi = ApiBlueprint.make({
  params: defineParams =>
    defineParams({
      api: catalogHistoryApiRef,
      deps: { discoveryApi: discoveryApiRef, fetchApi: fetchApiRef },
      factory: options => new CatalogHistoryClient(options),
    }),
});

/** Entity History tab extension for the new frontend system. @public */
export const catalogHistoryEntityContent = EntityContentBlueprint.make({
  params: {
    path: 'history',
    title: 'History',
    loader: () =>
      import('./components/EntityCatalogHistoryContent').then(m => (
        <m.EntityCatalogHistoryContent />
      )),
  },
});

/** Catalog history plugin for the new frontend system. @public */
export const catalogHistoryPlugin = createFrontendPlugin({
  pluginId: 'catalog-history',
  extensions: [catalogHistoryApi, catalogHistoryEntityContent],
});
