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
  EntityCatalogHistoryContent,
} from '../src';
import { createFixtureApi } from './fixture-api';
import { previewEntity, previewEntityRef } from './fixtures';

function Preview() {
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
      ],
    }),
    createFrontendPlugin({
      pluginId: 'catalog-history-preview',
      extensions: [
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
