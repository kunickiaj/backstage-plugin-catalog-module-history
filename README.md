# @kunickiaj/backstage-plugin-catalog-backend-module-history

A Backstage backend module that records catalog entity changes into a versioned history store, producing a queryable audit trail across provider, processing, and served-catalog layers.

Ships with a Postgres backend in v1; designed around a pluggable `HistoryStore` interface so additional backends (Dolt, ClickHouse, etc.) can be added without changes to the wrapper.

**Status: pre-alpha.** All five public packages are published at `0.2.0` with the `latest` dist-tag, including the frontend package. The HTTP read API and migration-log isolation fix ship in `0.2.0`; read the [storage notes](packages/catalog-history-backend/README.md#migration-bookkeeping-in-020) and [migration guide](docs/migration.md) before using a shared catalog database.

Maintainers: see [Publishing packages](docs/publishing.md) for validation, npm trusted publishing, artifact verification, release notes, and recovery.

The `0.2.0` global-feed index builds during history startup and blocks history entity writes while it builds. Before deploying it to a database with a large retained history, plan a maintenance window; see the [index upgrade notes](packages/catalog-history-backend/README.md#global-history-feed-index-in-020).

## What it does

1. **Bootstraps the history schema** on backend startup (two history tables in the consuming plugin's database, unless overridden). The current source keeps new installations' migration records in a dedicated history log; existing history-only `0.1.0` logs remain supported.
2. **Captures provider-origin truth** with `HistoryRecordingEntityProvider` (`source='provider'`). It mirrors every `full` or `delta` `applyMutation` after forwarding to the catalog. Cheap: one cycle per provider refresh/mutation. Best fit: identity-shaped entities like Users and Groups.
3. **Optionally observes processing output** with `catalog.history.processing.enabled` (`source='processing'`). It sees processor mutations and processor-emitted entities, but cannot observe deletes and cannot guarantee registration order across independent modules. It hash-skips unchanged entities and micro-batches changes (default: 500 rows or 10s). Note: the first processing cycle after enabling records the entire catalog as inserts under `source='processing'` — expected one-time cost, since each source keeps its own baseline.
4. **Optionally reconciles served catalog truth** (`source='reconciler'`). The in-process scheduler reads the public Catalog API, including stitched `relations`, `status.items`, and orphan state. Defaults when enabled: hourly, 10m timeout, 30s initial delay, task id `catalog-history-reconcile`. The external CLI remains available for isolated CronJobs or ad-hoc runs.
5. **Optionally serves retained history** from the same store (`catalog.history.api.enabled`). The catalog module exposes authenticated, permission-controlled routes under `/api/catalog/history`, including a feed across entities that were later deleted; it does not require a separate backend plugin or database.

## Known deletion-capture limitation

History records a delete only when a configured capture path observes it. Actions such as **Unregister** that remove entities or locations directly can bypass the provider wrapper, so they do not guarantee a delete event. Earlier retained events can remain readable on the global history page; they do not prove that deletion was captured or make history a complete audit log of catalog deletion actions.

The reconciler is disabled by default and runs hourly when enabled without a custom schedule. It needs its own earlier scan as a baseline; provider and processing records do not supply that baseline.

It can later record an observed disappearance, but misses entities deleted before its first scan and deletions followed by recreation between scans. Its recorded time is the observation time, not the actual deletion time, and it cannot recover the deletion actor or payload.

## Install

```sh
yarn add @kunickiaj/backstage-plugin-catalog-backend-module-history @kunickiaj/backstage-plugin-catalog-history-node
```

## Wire it up

In your Backstage backend (`packages/backend/src/index.ts`):

```ts
import { createBackend } from '@backstage/backend-defaults';

const backend = createBackend();

// ... your other plugins / modules

backend.add(import('@backstage/plugin-catalog-backend'));
backend.add(
  import('@kunickiaj/backstage-plugin-catalog-backend-module-history'),
);

backend.start();
```

The module package default export installs the catalog backend module and the default Postgres `historyStoreServiceRef` factory from `@kunickiaj/backstage-plugin-catalog-history-storage-node`. That gives you schema bootstrap, optional processor capture, optional scheduled reconciliation, and the opt-in HTTP read API.

Provider capture still needs provider wiring: in the catalog module where you create the provider, depend on `historyStoreServiceRef` and pass the injected store into `HistoryRecordingEntityProvider`:

```ts
import { HistoryRecordingEntityProvider } from '@kunickiaj/backstage-plugin-catalog-backend-module-history';
import { historyStoreServiceRef } from '@kunickiaj/backstage-plugin-catalog-history-node';
import { OktaOrgEntityProvider } from '@backstage/plugin-catalog-backend-module-okta';

backend.add(
  createBackendModule({
    pluginId: 'catalog',
    moduleId: 'okta-with-history',
    register(reg) {
      reg.registerInit({
        deps: {
          catalog: catalogProcessingExtensionPoint,
          logger: coreServices.logger,
          config: coreServices.rootConfig,
          historyStore: historyStoreServiceRef,
        },
        async init({ catalog, logger, config, historyStore }) {
          const inner = OktaOrgEntityProvider.fromConfig(/* ... */);
          catalog.addEntityProvider(
            new HistoryRecordingEntityProvider({
              inner,
              store: historyStore,
              logger,
              enabled:
                config.getOptionalBoolean('catalog.history.provider.enabled') ??
                true,
            }),
          );
        },
      });
    },
  }),
);
```

## Config

All optional; sensible defaults.

```yaml
catalog:
  history:
    enabled: true

    # Deprecated compatibility path: write to a different Postgres instance
    # than Backstage's main catalog DB. Prefer a custom historyStoreServiceRef
    # factory for new dedicated-storage setups.
    database:
      client: pg
      connection: ${PG_HISTORY_URL}

    # Provider-layer recording via HistoryRecordingEntityProvider wrapper.
    provider:
      enabled: true

    # Processor-layer recording via HistoryRecordingCatalogProcessor.
    processing:
      enabled: false

    # Serve authenticated entity-history reads from the catalog backend.
    api:
      enabled: false
      # Default Postgres history-read statement limit (current source; next release).
      queryTimeoutMs: 10000

    # Scheduled in-process reconciliation through the public Catalog API.
    reconciler:
      enabled: false
      schedule:
        frequency: { hours: 1 }
        timeout: { minutes: 10 }
        initialDelay: { seconds: 30 }
```

| Key                                                | Default                    | Effect                                                                                                                                               |
| -------------------------------------------------- | -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `catalog.history.enabled`                          | `true`                     | Master switch. Set to `false` to skip schema bootstrap, processor capture, and reconciler.                                                           |
| `catalog.history.database`                         | unset                      | Deprecated history database override honored by the default store factory. Prefer custom `historyStoreServiceRef` factories for new setups.          |
| `catalog.history.database.client`                  | `pg`                       | Knex client for the deprecated history database override.                                                                                            |
| `catalog.history.database.connection`              | Backstage database service | Knex connection string or object for the deprecated history storage override. Treated as secret config.                                              |
| `catalog.history.provider`                         | unset                      | Provider-layer capture settings.                                                                                                                     |
| `catalog.history.provider.enabled`                 | `true`                     | Gates provider-layer recording when passed to `HistoryRecordingEntityProvider`.                                                                      |
| `catalog.history.processing`                       | unset                      | Processor-layer capture settings.                                                                                                                    |
| `catalog.history.processing.enabled`               | `false`                    | Enables processor-layer capture via `HistoryRecordingCatalogProcessor`.                                                                              |
| `catalog.history.api`                              | unset                      | HTTP history API settings.                                                                                                                           |
| `catalog.history.api.enabled`                      | `false`                    | Enables entity history, version, and cross-entity change-feed routes under `/api/catalog/history`.                                                   |
| `catalog.history.api.queryTimeoutMs`               | `10000`                    | Current source: per-SQL-statement timeout in milliseconds for history reads through the default Postgres store. `0` disables only this plugin limit. |
| `catalog.history.reconciler`                       | unset                      | Scheduled in-process reconciler settings.                                                                                                            |
| `catalog.history.reconciler.enabled`               | `false`                    | Enables scheduled in-process reconciliation.                                                                                                         |
| `catalog.history.reconciler.schedule`              | unset                      | Optional Backstage scheduler config; omitted uses the defaults below.                                                                                |
| `catalog.history.reconciler.schedule.frequency`    | `{ hours: 1 }`             | Scheduler frequency for the in-process reconciler.                                                                                                   |
| `catalog.history.reconciler.schedule.timeout`      | `{ minutes: 10 }`          | Scheduler timeout for one reconcile run.                                                                                                             |
| `catalog.history.reconciler.schedule.initialDelay` | `{ seconds: 30 }`          | Delay before the first scheduled reconcile run.                                                                                                      |

Processing capture and the scheduled reconciler are config-only after `backend.add(import('@kunickiaj/backstage-plugin-catalog-backend-module-history'))`; no extra code wiring is needed.

## Read history over HTTP in `0.2.0`

Enable the API in the existing catalog module. It uses the same history store and database as recording; do not install a separate history backend plugin. Its route prefix is `/api/catalog/history`, not the previously planned `/api/catalog-history`.

Current source adds `catalog.history.api.queryTimeoutMs`, which defaults to 10 seconds after the next release. It limits each history-read SQL statement in the default Postgres store, not the complete HTTP request; a detail lookup can run two separately limited statements. A lower positive Postgres `statement_timeout` remains in effect, while `0` removes only the plugin limit and retains any database limit.

```yaml
catalog:
  history:
    api:
      enabled: true
```

The routes require user authentication and the `catalog-history.read` permission, exported as `catalogHistoryReadPermission` from `@kunickiaj/backstage-plugin-catalog-history-common`. When Backstage's permission framework is enabled, the policy must return an explicit `ALLOW`; `DENY` and conditional decisions are rejected. Without that framework, authenticated users follow Backstage's normal permission behavior.

```sh
curl -H 'Authorization: Bearer <TOKEN>' \
  'https://backstage.example.com/api/catalog/history/entities/User/default/alice/history?source=provider&limit=25'

curl -H 'Authorization: Bearer <TOKEN>' \
  'https://backstage.example.com/api/catalog/history/entities/User/default/alice/versions?changedAfter=2026-01-01T00:00:00Z'

curl -H 'Authorization: Bearer <TOKEN>' \
  'https://backstage.example.com/api/catalog/history/entities/User/default/alice/versions/42'
```

`GET /api/catalog/history/entities/:kind/:namespace/:name/history` returns all recorded changes, including `insert`, `update`, and `delete`. `GET /api/catalog/history/entities/:kind/:namespace/:name/versions` omits deletes and returns the latest representative for each `source`/`provider`/etag combination. It excludes null etags. `GET /api/catalog/history/changes` returns retained changes across entities. All list responses use the shared `{ items, nextCursor }` shape. Feed items include the affected entity's `entityRef`, `kind`, `namespace`, and `name`.

`GET /api/catalog/history/entities/:kind/:namespace/:name/versions/:id` returns the exact history row for the canonical entity reference and row ID, including provenance and snapshot. It can also include `previousVersion`, the immediately preceding saved row for the same entity, source, and provider, ordered by `changedAt` and then `id`; etags do not deduplicate events. A delete row has no current snapshot, but `previousVersion` can provide the last saved snapshot from that source and provider.

For update rows with both snapshots available, `changes` contains field paths and before/after values computed from stored payload fields. Identity and etag noise are excluded, and arrays are compared as whole values rather than semantically. `changes` is absent when no prior saved snapshot can be compared, and an empty array means no saved field differences. These retained-snapshot changes are not necessarily the delta sent by the original capture source.

Use a timeline item's `id` to inspect that event. Do not look it up by etag or use the versions list: an `A → B → A` sequence retains all three event occurrences.

The entity list routes accept `source` (`provider`, `processing`, or `reconciler`), `provider`, `changedAfter`, `changedBefore`, `limit`, and `cursor`; the history route also accepts `op` (`insert`, `update`, or `delete`). The change-feed route accepts those filters plus `entityRef` and `kind`. `entityRef` is an exact canonical entity reference, not a partial search. `kind` is an exact, case-insensitive match and supports custom kinds. Timestamps must be ISO 8601 instants. `limit` is a positive integer, defaults to `25`, and is capped at `100`. Cursors are opaque and paginate live data, not a frozen result set. Pass `nextCursor` as `cursor` unchanged, and reset pagination after changing filters or refreshing results. Unknown, empty, or repeated query parameters, invalid values, and the unsupported `owner` filter return `400`.

The detail route accepts no query parameters. Invalid, nonpositive, or out-of-range PostgreSQL bigint IDs return `400`; an absent row or an ID for another entity returns `404`. The API returns retained history for deleted entities and does not filter rows by current catalog visibility. An approved `catalog-history.read` permission grants access to all retained history, not only entities visible in the current catalog. An empty list is `200` with `items: []`. Errors are `401` for missing authentication, `403` for a rejected permission decision, and `500` for a sanitized backend failure. Cycle, stats, facets, as-of, arbitrary diff, and timeline-summary routes are not available yet; the current timeline summary is `{}` and has no semantic badges.

## Add the frontend History tab and page in `0.2.0`

`packages/catalog-history` contains the `@kunickiaj/backstage-plugin-catalog-history` NFS frontend package. It is published at `0.2.0` with the other four public packages; install the exact published version for host E2E work.

After installing the frontend package in your app workspace, enable the catalog read API and add the default NFS plugin to `createApp`:

```yaml
catalog:
  history:
    api:
      enabled: true
```

```ts
import { createApp } from '@backstage/frontend-defaults';
import catalogHistoryPlugin from '@kunickiaj/backstage-plugin-catalog-history';

export default createApp({
  features: [catalogHistoryPlugin],
});
```

The plugin adds a **History** entity tab at the `history` extension path and a navigation page at `/catalog-history` titled **Catalog history**. It uses BUI and needs the application's BUI stylesheet. The tab stays scoped to its current entity and filters its retained events only by source, provider, operation, and recorded time. It has no entity-reference or kind filter.

The standalone page browses retained history across all entities, including deleted entities. Its table shows each affected entity's kind, namespace, and name, as does the entity-scoped table. It can filter by an exact entity reference, kind, source, provider, operation, and recorded time. Entity-reference short names default to `Component:default`; canonical references are preserved. Kind matching is case-insensitive and accepts custom kinds.

Text fields apply after 300 ms; dropdowns and valid dates apply immediately. Date fields use local time and convert to ISO instants. An invalid date or range shows an error without changing results. Any filter change resets pagination. **Reset filters** clears filters and cancels pending text input.

Select a timeline row by pointer or keyboard to inspect its exact event; there is no separate inspect action. The responsive timeline and inspector panels show update field changes when available, plus raw JSON separately. Delete events remain tombstones with no current snapshot; when a prior saved snapshot is available, the inspector labels it as the last recorded snapshot before deletion and shows its provenance. It is not the deletion payload.

The backend requires an authenticated user and, when permissions are enabled, an explicit `ALLOW` for `catalog-history.read`. A disabled, unreachable, or older backend without the route appears as a history `404`; expired sessions return `401`; rejected permission decisions return `403`. The standalone page shows a compatibility message when a custom history API does not implement the change feed (`501`); the entity tab remains available. Deleted entities may have retained API history, but the entity tab cannot open after the catalog entity itself is absent. There is no cycle, stats, facets, as-of, or arbitrary version-comparison view.

See the [frontend package README](packages/catalog-history/README.md) for workspace use, NFS exports, and user-facing error guidance.

### Custom history storage

For custom storage, register your own service factory and use the named catalog module export instead of the default loader:

```ts
import { createServiceFactory } from '@backstage/backend-plugin-api';
import { historyStoreServiceRef } from '@kunickiaj/backstage-plugin-catalog-history-node';
import { catalogModuleHistory } from '@kunickiaj/backstage-plugin-catalog-backend-module-history';

const myHistoryStoreServiceFactory = createServiceFactory({
  service: historyStoreServiceRef,
  deps: {
    // your deps here
  },
  async factory() {
    return createMyHistoryStore();
  },
});

backend.add(catalogModuleHistory);
backend.add(myHistoryStoreServiceFactory);
```

## Query the history directly

The module owns two tables in Postgres:

- `catalog_history_cycles` — one row per recorded cycle, with `provider`, `source`, mutation type, timestamps, and `n_added` / `n_modified` / `n_removed` / `n_unchanged` aggregates.
- `catalog_history_entities` — one row per entity change, with structured columns (`entity_ref`, `kind`, `namespace`, `name`, `provider`, `source`, `op`, `etag`, `display_name`, `email`, `owner`, `parent`, `member_of`, `orphan`) plus JSONB `metadata`, `spec`, `relations`, and `status_items`.

Example queries:

```sql
-- Who left the platform team between two cycles?
WITH before AS (
  SELECT entity_ref FROM catalog_history_entities
  WHERE cycle_id = '...' AND member_of ? 'group:default/platform'
),
after AS (
  SELECT entity_ref FROM catalog_history_entities
  WHERE cycle_id = '...' AND member_of ? 'group:default/platform'
)
SELECT entity_ref FROM before EXCEPT SELECT entity_ref FROM after;

-- Org chart as of a past timestamp.
SELECT DISTINCT ON (entity_ref) *
FROM catalog_history_entities
WHERE changed_at <= '2026-03-05'
ORDER BY entity_ref, changed_at DESC;

-- Compare origin truth vs served catalog truth for one entity.
SELECT DISTINCT ON (source)
  source, entity_ref, etag, relations, status_items, orphan, changed_at
FROM catalog_history_entities
WHERE entity_ref = 'user:default/alice'
  AND source IN ('provider', 'reconciler')
ORDER BY source, changed_at DESC;

-- Find relation changes in served catalog history.
WITH served AS (
  SELECT
    entity_ref,
    changed_at,
    relations,
    lag(relations) OVER (PARTITION BY entity_ref ORDER BY changed_at) AS previous_relations
  FROM catalog_history_entities
  WHERE source = 'reconciler'
)
SELECT entity_ref, changed_at, previous_relations, relations
FROM served
WHERE relations IS DISTINCT FROM previous_relations
  AND relations @> '[{"type":"ownedBy","targetRef":"group:default/platform"}]'::jsonb
ORDER BY changed_at DESC;
```

## Reconciler modes

The reconciler snapshots the live catalog and diffs against its own previously recorded state (`source='reconciler'` rows only — etags from other capture layers are computed over different content and are not comparable). Changes are recorded as a cycle with `provider='reconciler'` and `source='reconciler'`. Safe to run repeatedly; an unchanged catalog records a heartbeat cycle. The first run records the entire catalog as inserts — an expected one-time cost, same as first enabling processing capture.

Preferred mode: scheduled in-process reconciliation:

```yaml
catalog:
  history:
    reconciler:
      enabled: true
```

External mode: run the CLI manually or from a CronJob when you want isolation from the backend process:

```sh
env \
  BACKSTAGE_BASE_URL=https://backstage.example.com \
  BACKSTAGE_TOKEN=... \
  PG_CONNECTION_STRING=postgres://... \
  npx reconcile-catalog-history
```

## Documentation

- [Migrate from the historical single module](docs/migration.md)
- [Implementation plan](docs/plans/2026-05-11-catalog-history-backstage-module.md)
- [Productization roadmap](docs/plans/2026-07-05-catalog-history-productization-roadmap.md)
- [Architecture](docs/ARCHITECTURE.md)
- [Observability (current source after `0.2.0`)](docs/observability.md)
- [`0.2.0` release and E2E setup](docs/releases/0.2.0.md)

## License

Apache-2.0
