/** @jsxRuntime automatic */
import { createDevApp } from '@backstage/frontend-dev-utils';
import {
  createFrontendPlugin,
  PageBlueprint,
} from '@backstage/frontend-plugin-api';
import { EntityProvider } from '@backstage/plugin-catalog-react';
import { Box, Text } from '@backstage/ui';
import {
  catalogHistoryPlugin,
  catalogHistoryApi,
  catalogHistoryApiRef,
  catalogHistoryEntityContent,
  catalogHistoryPage,
  EntityCatalogHistoryContent,
  CatalogHistoryPage,
} from '../src';
import { createFixtureApi } from './fixture-api';
import { previewEntity, previewEntityRef } from './fixtures';

function EntityPreview() {
  return (
    <EntityProvider entity={previewEntity}>
      <Box p="4">
        <Text as="h1" variant="title-small">
          Catalog history preview
        </Text>
        <p role="note">Synthetic data only — no backend connection.</p>
        <Text as="p">Entity: {previewEntityRef}</Text>
      </Box>
      <EntityCatalogHistoryContent />
    </EntityProvider>
  );
}

function Preview() {
  return (
    <>
      <Box p="4">
        <p role="note">
          Synthetic data only — all entities, no backend connection.
        </p>
        <a href="/entity-history">View the single-entity history example</a>
      </Box>
      <CatalogHistoryPage />
    </>
  );
}

createDevApp({
  features: [
    catalogHistoryPlugin.withOverrides({
      extensions: [
        catalogHistoryApi.override({
          params: defineParams =>
            defineParams({
              api: catalogHistoryApiRef,
              deps: {},
              factory: createFixtureApi,
            }),
        }),
        // The standalone preview has no catalog entity page to attach to.
        catalogHistoryEntityContent.override({ disabled: true }),
        catalogHistoryPage.override({
          params: { loader: () => Promise.resolve(<Preview />) },
        }),
      ],
    }),
    createFrontendPlugin({
      pluginId: 'catalog-history-preview',
      extensions: [
        PageBlueprint.make({
          name: 'entity',
          params: {
            path: '/entity-history',
            title: 'Entity history example',
            noHeader: true,
            loader: () => Promise.resolve(<EntityPreview />),
          },
        }),
        PageBlueprint.make({
          params: {
            path: '/',
            noHeader: true,
            loader: () => Promise.resolve(<Preview />),
          },
        }),
      ],
    }),
  ],
});
