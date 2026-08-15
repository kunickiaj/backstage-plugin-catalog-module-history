# Package Split — Implementation Plan

> Tracking issue: [#11](https://github.com/kunickiaj/backstage-plugin-catalog-module-history/issues/11)
>
> Status: **partially executed.** The private Yarn workspace root and initial `packages/catalog-backend-module-history` move have landed. The package-boundary split, service-ref extraction, backend storage package, and frontend package remain planned follow-up work.

## Goal

Split the current single package into two, with clear ownership boundaries:

- **`@kunickiaj/plugin-history-backend`** — owns the `catalog_history_cycles` / `catalog_history_entities` tables. Uses Backstage's plugin-scoped `coreServices.database`. Exposes a `historyStoreServiceRef` so other backend modules can write/read cycles. Owns the migrations and the standalone reconciler CLI.
- **`@kunickiaj/catalog-backend-module-history`** — just the wrapper. Depends on `historyStoreServiceRef`. `HistoryRecordingEntityProvider` and `entityToRow` live here. No DB access of its own.

Both ship from the same repo as a small monorepo (Yarn workspaces).

## Target layout

```
backstage-plugin-catalog-module-history/        ← workspace root
  package.json                                    workspaces: ["packages/*"]
  tsconfig.json                                   project references
  yarn.lock                                       single lock for the workspace
  .yarnrc.yml                                     nodeLinker: node-modules
  .github/
    workflows/ci.yml                              builds and tests both packages
    dependabot.yml                                already exists; tweak directories
  packages/
    plugin-history-backend/
      package.json                                name: "@kunickiaj/plugin-history-backend"
      tsconfig.json                               extends root
      src/
        index.ts                                  exports HistoryStore, services, plugin
        plugin.ts                                 createBackendPlugin({ pluginId: 'history' })
        services/
          historyStoreServiceRef.ts               new — DI surface
          historyStoreServiceFactory.ts           new — provides PostgresHistoryStore
        store/
          HistoryStore.ts                         moved from src/store/
          types.ts                                moved
          __tests__/InMemoryHistoryStore.ts       moved (test util)
          __tests__/InMemoryHistoryStore.test.ts
        postgres/
          ensureSchema.ts                         moved
          PostgresHistoryStore.ts                 moved
          __tests__/
        reconciler/
          reconcile.ts                            moved
          paginateEntities.ts                     moved
          EntityFetcher.ts                        moved
          __tests__/
        bin/
          reconcile.ts                            moved
      migrations/
        20260512000000_initial.js                 moved from repo root
      bin/
        reconcile-catalog-history.js              moved
      scripts/
        symlink-self.js                           moved
    catalog-backend-module-history/
      package.json                                name: "@kunickiaj/catalog-backend-module-history"
      tsconfig.json                               extends root
      src/
        index.ts                                  exports HistoryRecordingEntityProvider, module
        provider/
          HistoryRecordingEntityProvider.ts       moved from src/provider/
          __tests__/
        mapping/
          entityToRow.ts                          moved
          __tests__/
        module/
          catalogModuleHistory.ts                 moved + rewired to depend on
                                                  historyStoreServiceRef
          __tests__/
```

## Service ref contract (`@kunickiaj/plugin-history-backend`)

```ts
// services/historyStoreServiceRef.ts
import { createServiceRef } from '@backstage/backend-plugin-api';
import type { HistoryStore } from '../store/HistoryStore';

export const historyStoreServiceRef = createServiceRef<HistoryStore>({
  id: 'history.store',
  scope: 'plugin',
});
```

The factory:

```ts
// services/historyStoreServiceFactory.ts
import {
  coreServices,
  createServiceFactory,
} from '@backstage/backend-plugin-api';
import { ensureSchema } from '../postgres/ensureSchema';
import { PostgresHistoryStore } from '../postgres/PostgresHistoryStore';
import { historyStoreServiceRef } from './historyStoreServiceRef';

export const historyStoreServiceFactory = createServiceFactory({
  service: historyStoreServiceRef,
  deps: { database: coreServices.database, logger: coreServices.logger },
  async factory({ database, logger }) {
    const db = await database.getClient();
    await ensureSchema(db);
    logger.info('history store schema is ready');
    return new PostgresHistoryStore(db);
  },
});
```

The plugin:

```ts
// plugin.ts
import { createBackendPlugin } from '@backstage/backend-plugin-api';

export const historyPlugin = createBackendPlugin({
  pluginId: 'history',
  register(reg) {
    reg.registerInit({
      deps: {},
      async init() {
        // Plugin reserves the `history` pluginId. The service factory is a
        // separate feature that consumers must also add to the backend (see
        // wiring below) — Backstage's backend system does not let a plugin's
        // register block register service factories itself.
      },
    });
  },
});
```

Wiring in a consumer Backstage app — **both the plugin and the service factory must be added**, otherwise modules that depend on `historyStoreServiceRef` will fail at startup with an unresolved-service error:

```ts
// packages/backend/src/index.ts
import { createBackend } from '@backstage/backend-defaults';
import {
  historyPlugin,
  historyStoreServiceFactory,
} from '@kunickiaj/plugin-history-backend';

const backend = createBackend();

backend.add(import('@backstage/plugin-catalog-backend'));
backend.add(historyPlugin); //         reserves the pluginId
backend.add(historyStoreServiceFactory); // provides historyStoreServiceRef

// ... your own catalog modules that consume historyStoreServiceRef

backend.start();
```

For ergonomics, `@kunickiaj/plugin-history-backend` should also export a convenience bundle so most consumers only call `backend.add` once:

```ts
// index.ts
export const historyBackendFeatures = [historyPlugin, historyStoreServiceFactory];

// consumer usage:
import { historyBackendFeatures } from '@kunickiaj/plugin-history-backend';
historyBackendFeatures.forEach(f => backend.add(f));
```

## Module rewiring (`@kunickiaj/catalog-backend-module-history`)

The module shrinks from "bootstrap schema and run migrations" to "register no built-in wrapper" — it only exists for the historical alias. Schema bootstrap moves into the history plugin's service factory.

The wrapper itself stays a class consumers wire manually. Example:

```ts
import { historyStoreServiceRef } from '@kunickiaj/plugin-history-backend';
import { HistoryRecordingEntityProvider } from '@kunickiaj/catalog-backend-module-history';

backend.add(
  createBackendModule({
    pluginId: 'catalog',
    moduleId: 'okta-with-history',
    register(reg) {
      reg.registerInit({
        deps: {
          catalog: catalogProcessingExtensionPoint,
          logger: coreServices.logger,
          store: historyStoreServiceRef,
        },
        async init({ catalog, logger, store }) {
          const inner = OktaOrgEntityProvider.fromConfig(/* ... */);
          catalog.addEntityProvider(
            new HistoryRecordingEntityProvider({ inner, store, logger }),
          );
        },
      });
    },
  }),
);
```

## Dependency graph after the split

```
plugin-history-backend
  ├── @backstage/backend-plugin-api
  ├── @backstage/catalog-client            (CLI only)
  ├── @backstage/catalog-model
  ├── @backstage/types
  ├── knex
  ├── pg
  └── json-stable-stringify

catalog-backend-module-history
  ├── @backstage/backend-plugin-api
  ├── @backstage/catalog-model
  ├── @backstage/plugin-catalog-node
  ├── @backstage/types
  ├── json-stable-stringify
  └── peerDependency: @kunickiaj/plugin-history-backend (for historyStoreServiceRef)
```

## CI changes

The `Lint, build, test (Node 22|24)` matrix is preserved but per-package:

```yaml
- name: Lint plugin-history-backend
  working-directory: packages/plugin-history-backend
  run: yarn lint

- name: Test plugin-history-backend
  working-directory: packages/plugin-history-backend
  run: yarn test

- name: Lint catalog-backend-module-history
  working-directory: packages/catalog-backend-module-history
  run: yarn lint

- name: Test catalog-backend-module-history
  working-directory: packages/catalog-backend-module-history
  run: yarn test
```

Or one `yarn workspaces foreach -A run lint` / `yarn workspaces foreach -A run test` step that fans out.

Branch protection's required check names stay the same (`Lint, build, test (Node 22)` + `(Node 24)`) since those are the job names, not step names.

`dependabot.yml` gets a second `directory:` per package so both lockfiles stay in sync.

## Migration order (suggested PR sequence)

1. **`chore: introduce workspaces layout`** — root `package.json` becomes a workspace; `packages/` directory created empty; CI runs unchanged because no package exists yet. Trivial diff, validates the scaffold.
2. **`refactor: move HistoryStore + PostgresHistoryStore to plugin-history-backend`** — physical move, no logic changes. Update internal imports.
3. **`refactor: move reconciler + CLI to plugin-history-backend`** — same shape.
4. **`feat(plugin-history-backend): expose historyStoreServiceRef`** — new service ref + factory + plugin.
5. **`refactor: move wrapper + mapping to catalog-backend-module-history`** — physical move; module rewired to consume `historyStoreServiceRef` instead of building its own knex.
6. **`ci: per-package lint/build/test`** — split the workflow steps.
7. **`docs: README split + cross-reference`** — top-level README points at both packages; each package gets its own README.

Each step builds + tests on its own. The whole split lands across ~5–7 small PRs instead of one mega-PR.

## Open questions to settle before execution

- **Package scope.** `@kunickiaj/*` is the natural personal scope for now; should switch to `@backstage-community/*` if/when contributing to `backstage/community-plugins`.
- **Should `historyStoreServiceRef` be `'plugin'` scope or `'root'` scope?** Plugin-scoped means each plugin that consumes it gets its own factory invocation (and thus its own knex connection pool). Root-scoped means one shared instance. Plugin-scoped is more idiomatic; root-scoped is more efficient at scale. Lean plugin-scoped unless we have a reason.
- **Does the history plugin need its own backend route/router?** Initial answer: no — it's a service-ref-only plugin. If we later want HTTP endpoints (e.g., for a frontend), add an `http` service via `coreServices.httpRouter` in the plugin's init.
- **Migration ownership on a shared Postgres.** Today both packages would write to `catalog_history_*` in whatever DB the consumer provides. With plugin-scoped database service, Backstage gives the history plugin its own schema (or its own DB). We should rename tables to drop the `catalog_history_` prefix (just `cycles` / `entities` inside the history plugin's schema). That's a one-time data migration consumers do when upgrading.

## When to execute

- Wait for PRs #5, #6, #7, #12, #13 to merge.
- Confirm CI is green on `main` with everything landed.
- Then sequence the seven migration PRs above on a fresh branch off `main`.

## Why we're not doing this in the current stack

- The stack is mid-merge. Restacking 5 open PRs across a layout move generates noise that overwhelms the small content changes in each.
- The split is a structural refactor, not a feature. It deserves a dedicated effort window.
- The work is bounded but big (~3000 LOC of mostly renames). A single dedicated PR series stays reviewable; an in-stack one doesn't.
