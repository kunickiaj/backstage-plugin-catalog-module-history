# Migrate from the single history module

Move a Backstage backend from the historical, unscoped
`backstage-plugin-catalog-backend-module-history` package at `0.1.0` to the
current package family. The old package name is not an npm alias for the new
one. Run these commands in the consuming Backstage repository, not this source
workspace.

## 1. Replace the module dependency

Most backends need only the current module package. Its default feature loader
includes the default Postgres `historyStoreServiceRef` factory.

```fish
yarn --cwd packages/backend remove 'backstage-plugin-catalog-backend-module-history'
yarn --cwd packages/backend add '@kunickiaj/backstage-plugin-catalog-backend-module-history@^0.2.0'
```

Add direct dependencies only for APIs the host imports:

```fish
# Provider modules that import HistoryStore or historyStoreServiceRef
yarn --cwd packages/backend add '@kunickiaj/backstage-plugin-catalog-history-node@^0.2.0'

# A host-owned Postgres factory or storage implementation
yarn --cwd packages/backend add '@kunickiaj/backstage-plugin-catalog-history-storage-node@^0.2.0'
```

| Package                                                      | Use it when                                               |
| ------------------------------------------------------------ | --------------------------------------------------------- |
| `@kunickiaj/backstage-plugin-catalog-backend-module-history` | Adding catalog capture behavior                           |
| `@kunickiaj/backstage-plugin-catalog-history-node`           | Importing backend contracts or `historyStoreServiceRef`   |
| `@kunickiaj/backstage-plugin-catalog-history-storage-node`   | Using Postgres storage, migrations, or a factory directly |
| `@kunickiaj/backstage-plugin-catalog-history-common`         | Sharing frontend-safe DTOs, filters, or permissions       |
| `@kunickiaj/backstage-plugin-catalog-history`                | Adding the optional NFS frontend                          |

Do not install all five packages into every backend. The storage package is a
Node library, not a separate history backend plugin.

## 2. Update backend registration

Keep the catalog backend registration and replace only the history module
specifier:

```ts
// Before
backend.add(import('@backstage/plugin-catalog-backend'));
backend.add(import('backstage-plugin-catalog-backend-module-history'));

// After
backend.add(import('@backstage/plugin-catalog-backend'));
backend.add(
  import('@kunickiaj/backstage-plugin-catalog-backend-module-history'),
);
```

The current default export is a backend feature loader. It registers both
`catalogModuleHistory` and the default Postgres history-store factory. The
historical default was the named `catalogModuleHistory` value, not a feature
loader. Code that needs only the module must use the named
`catalogModuleHistory` export and supply a store factory, as shown below.

## 3. Move provider storage wiring to dependency injection

Provider capture remains a wrapper around the original provider. Replace the
locally constructed `PostgresHistoryStore` with the injected
`historyStoreServiceRef`.

The current provider module imports these values from the public packages:

```ts
import { historyStoreServiceRef } from '@kunickiaj/backstage-plugin-catalog-history-node';
import { HistoryRecordingEntityProvider } from '@kunickiaj/backstage-plugin-catalog-backend-module-history';
```

```ts
// Before: historical provider module fragment
deps: {
  catalog: catalogProcessingExtensionPoint,
  logger: coreServices.logger,
  config: coreServices.rootConfig,
  database: coreServices.database,
},
async init({ catalog, logger, config, database }) {
  const inner = MyEntityProvider.fromConfig(/* ... */);
  const store = new PostgresHistoryStore(await database.getClient());
  catalog.addEntityProvider(
    new HistoryRecordingEntityProvider({ inner, store, logger }),
  );
}

// After: current provider module fragment
deps: {
  catalog: catalogProcessingExtensionPoint,
  logger: coreServices.logger,
  config: coreServices.rootConfig,
  historyStore: historyStoreServiceRef,
},
async init({ catalog, logger, config, historyStore }) {
  const inner = MyEntityProvider.fromConfig(/* ... */);
  catalog.addEntityProvider(
    HistoryRecordingEntityProvider.fromConfig(config, {
      inner,
      store: historyStore,
      logger,
    }),
  );
}
```

`fromConfig` records only when both `catalog.history.enabled` and
`catalog.history.provider.enabled` are on. Earlier examples passed only
`catalog.history.provider.enabled`, so their wrappers kept recording after
`catalog.history.enabled: false`. The constructor's `enabled` option still
works for callers that need their own rule.

Keep the wrapper at its existing provider registration site. Optional processor
and reconciler capture remain configuration-driven. Processor capture does not
observe deletes, so use provider capture or reconciliation when delete coverage
is required.

## 4. Use canonical import locations

Move contracts and storage imports to their canonical packages. Releases
`0.2.0` through `0.4.0` re-exported them from the module; the next release
removes those re-exports.

| Historical export                                                                                                                                | Current import location                                      |
| ------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------ |
| `HistoryStore`, `CurrentEtag`, `RECONCILER_PROVIDER`, `CaptureSource`, `CycleInput`, `EntityRow`, `MutationType`                                 | `@kunickiaj/backstage-plugin-catalog-history-node`           |
| `ensureSchema`, `PostgresHistoryStore`                                                                                                           | `@kunickiaj/backstage-plugin-catalog-history-storage-node`   |
| `entityToRow`, `HistoryRecordingEntityProvider`, `HistoryRecordingCatalogProcessor`, `reconcile`, `EntityFetcher`, `CatalogServiceEntityFetcher` | `@kunickiaj/backstage-plugin-catalog-backend-module-history` |

```ts
import type { HistoryStore } from '@kunickiaj/backstage-plugin-catalog-history-node';
import { PostgresHistoryStore } from '@kunickiaj/backstage-plugin-catalog-history-storage-node';
import {
  HistoryRecordingEntityProvider,
  reconcile,
} from '@kunickiaj/backstage-plugin-catalog-backend-module-history';
```

See the [module's removed re-exports table](../packages/catalog-backend-module-history/README.md#removed-compatibility-re-exports-unreleased)
when updating imports.

## 5. Keep configuration, then review storage

Existing `catalog.history.*` keys continue to apply. The default store factory
still honors `catalog.history.database` as a deprecated compatibility override,
so recorder and query consumers use the same selected database. Prefer the
Backstage core database service and a custom factory for new dedicated-storage
setups.

```yaml
catalog:
  history:
    enabled: true
    provider:
      enabled: true
    processing:
      enabled: false
    reconciler:
      enabled: false
    api:
      enabled: false
```

Set `catalog.history.api.enabled: true` only when the selected store supports
the query capability. The API requires authenticated users and, when the
permission framework is enabled, an explicit `ALLOW` for
`catalog-history.read`. That permission grants retained-history access across
all entities, including deleted entities; it does not follow live catalog
visibility.

## 6. Register custom storage once

For custom storage, register the named catalog module and exactly one factory
for the existing `historyStoreServiceRef`. Do not combine this with the default
loader, which already registers the default factory.

```ts
import { createServiceFactory } from '@backstage/backend-plugin-api';
import { catalogModuleHistory } from '@kunickiaj/backstage-plugin-catalog-backend-module-history';
import { historyStoreServiceRef } from '@kunickiaj/backstage-plugin-catalog-history-node';

const myHistoryStoreServiceFactory = createServiceFactory({
  service: historyStoreServiceRef,
  deps: {},
  async factory() {
    return createMyHistoryStore();
  },
});

backend.add(catalogModuleHistory);
backend.add(myHistoryStoreServiceFactory);
```

Replace `createMyHistoryStore()` with your implementation returning a
`HistoryStore`; it is not a function supplied by this package.

The custom store must provide the read/query capability, including
`getEntityVersion`, before enabling the HTTP API. In `0.3.0`,
`getEntities` and `getKinds` are optional query methods: existing custom stores
continue to start and serve their existing routes. The authenticated discovery
routes return `501` after authorization when a custom query omits either
method; an older backend without the route returns `404`. There is no separate
history backend plugin to register.

## 7. Plan the database upgrade

Use Node 22 or 24, PostgreSQL, and the backend API's Knex `^3` range. Back up
data needed for recovery before testing the upgrade. Current installations use
an isolated history migration log; history-only legacy `0.1.0` logs remain
supported, but shared migration logs need operator review rather than an
automatic repair.

The historical `0.1.0` migration log is unsafe to initialize beside an
already-migrated catalog database. Do not enable that shared-database setup
until the isolated-log upgrade is in place and validated for the host.

The global-feed index builds during schema bootstrap and blocks writes to
`catalog_history_entities` while PostgreSQL builds it. Schedule a maintenance
window for large retained histories. Do not downgrade a database using the new
dedicated migration log to `0.1.0`.

`0.3.0` adds migration
`20261025000000_entity_discovery_name_index.js`. It creates
`catalog_history_entities_name_prefix_idx` on the first 128 folded name
characters with `C` collation and `text_pattern_ops`, then runs `ANALYZE`.
The regular transactional build also blocks history entity writes until commit;
reads continue. `catalog.history.api.queryTimeoutMs` applies to read SQL only,
not schema bootstrap, index build, or `ANALYZE`. Back up first, validate the
upgrade with representative retained history in staging, and schedule an
operator-controlled maintenance window. The migration has no concurrent-build
or automatic precreation path.

Read the [storage migration notes](../packages/catalog-history-backend/README.md#migration-bookkeeping-in-020)
and [global index notes](../packages/catalog-history-backend/README.md#global-history-feed-index-in-020)
before production rollout.

## 8. Add the frontend only when needed

The historical package was backend-only. The current optional frontend is an
NFS plugin that uses Backstage UI (BUI) and React 18; it is not a legacy
Material UI migration. Enable the backend read API, install the frontend in the
host app, and register its default NFS plugin alongside existing features.

```fish
yarn --cwd packages/app add '@kunickiaj/backstage-plugin-catalog-history@^0.2.0'
```

```ts
import { createApp } from '@backstage/frontend-defaults';
import catalogHistoryPlugin from '@kunickiaj/backstage-plugin-catalog-history';

export default createApp({
  features: [
    // Keep the app's existing features here.
    catalogHistoryPlugin,
  ],
});
```

See the [frontend package README](../packages/catalog-history/README.md) for
NFS registration, BUI styles, and user-facing behavior. This guide does not
assume an older frontend integration to convert.
