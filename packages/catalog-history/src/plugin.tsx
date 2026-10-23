/** @jsxRuntime automatic */
import {
  ApiBlueprint,
  PageBlueprint,
  createFrontendPlugin,
  discoveryApiRef,
  fetchApiRef,
} from '@backstage/frontend-plugin-api';
import { EntityContentBlueprint } from '@backstage/plugin-catalog-react/alpha';
import { RiHistoryLine } from '@remixicon/react';
import { catalogHistoryApiRef } from './api/CatalogHistoryApi';
import { CatalogHistoryClient } from './api/CatalogHistoryClient';
import { catalogHistoryRouteRef } from './routes';

/** Standalone catalog history page extension. @public */
export const catalogHistoryPage = PageBlueprint.make({
  params: {
    path: '/catalog-history',
    title: 'Catalog history',
    icon: <RiHistoryLine aria-hidden="true" />,
    routeRef: catalogHistoryRouteRef,
    loader: () =>
      import('./components/CatalogHistoryPage').then(m => (
        <m.CatalogHistoryPage />
      )),
  },
});

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
  extensions: [
    catalogHistoryApi,
    catalogHistoryEntityContent,
    catalogHistoryPage,
  ],
  routes: { root: catalogHistoryRouteRef },
});
