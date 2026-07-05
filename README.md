# backstage-plugin-catalog-backend-module-history

A Backstage backend module that records catalog entity changes into a versioned history store, producing a queryable audit trail across provider, processing, and served-catalog layers.

Ships with a Postgres backend in v1; designed around a pluggable `HistoryStore` interface so additional backends (Dolt, ClickHouse, etc.) can be added without changes to the wrapper.

**Status: pre-alpha.** Under active development; not yet published to npm.

## What it does

1. **Bootstraps the history schema** on backend startup (two tables in the same database Backstage's catalog uses, unless overridden).
2. **Captures provider-origin truth** with `HistoryRecordingEntityProvider` (`source='provider'`). It mirrors every `full` or `delta` `applyMutation` after forwarding to the catalog. Cheap: one cycle per provider refresh/mutation. Best fit: identity-shaped entities like Users and Groups.
3. **Optionally observes processing output** with `catalog.history.processing.enabled` (`source='processing'`). It sees processor mutations and processor-emitted entities, but cannot observe deletes and cannot guarantee registration order across independent modules. It hash-skips unchanged entities and micro-batches changes (default: 500 rows or 10s).
4. **Optionally reconciles served catalog truth** (`source='reconciler'`). The in-process scheduler reads the public Catalog API, including stitched `relations`, `status.items`, and orphan state. Defaults when enabled: hourly, 10m timeout, 30s initial delay, task id `catalog-history-reconcile`. The external CLI remains available for isolated CronJobs or ad-hoc runs.

## Install

```sh
yarn add backstage-plugin-catalog-backend-module-history
```

## Wire it up

In your Backstage backend (`packages/backend/src/index.ts`):

```ts
import { createBackend } from '@backstage/backend-defaults';

const backend = createBackend();

// ... your other plugins / modules

backend.add(import('@backstage/plugin-catalog-backend'));
backend.add(import('backstage-plugin-catalog-backend-module-history'));

backend.start();
```

That gives you schema bootstrap, optional processor capture, and optional scheduled reconciliation. Provider capture still needs provider wiring: wrap each provider you care about with `HistoryRecordingEntityProvider`:

```ts
import {
  HistoryRecordingEntityProvider,
  PostgresHistoryStore,
} from 'backstage-plugin-catalog-backend-module-history';
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
          database: coreServices.database,
        },
        async init({ catalog, logger, config, database }) {
          const store = new PostgresHistoryStore(await database.getClient());
          const inner = OktaOrgEntityProvider.fromConfig(/* ... */);
          catalog.addEntityProvider(
            new HistoryRecordingEntityProvider({
              inner,
              store,
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

    # Optional: write to a different Postgres instance than Backstage's
    # main catalog DB. Defaults to the same DB Backstage uses.
    database:
      client: pg
      connection: ${PG_HISTORY_URL}

    # Provider-layer recording via HistoryRecordingEntityProvider wrapper.
    provider:
      enabled: true

    # Processor-layer recording via HistoryRecordingCatalogProcessor.
    processing:
      enabled: false

    # Scheduled in-process reconciliation through the public Catalog API.
    reconciler:
      enabled: false
      schedule:
        frequency: { hours: 1 }
        timeout: { minutes: 10 }
        initialDelay: { seconds: 30 }
```

| Key                                                | Default                    | Effect                                                                                     |
| -------------------------------------------------- | -------------------------- | ------------------------------------------------------------------------------------------ |
| `catalog.history.enabled`                          | `true`                     | Master switch. Set to `false` to skip schema bootstrap, processor capture, and reconciler. |
| `catalog.history.database`                         | unset                      | Optional history database override; omitted uses Backstage's database service.             |
| `catalog.history.database.client`                  | `pg`                       | Knex client for the history database override.                                             |
| `catalog.history.database.connection`              | Backstage database service | Knex connection string or object for history storage. Treated as secret config.            |
| `catalog.history.provider`                         | unset                      | Provider-layer capture settings.                                                           |
| `catalog.history.provider.enabled`                 | `true`                     | Gates provider-layer recording when passed to `HistoryRecordingEntityProvider`.            |
| `catalog.history.processing`                       | unset                      | Processor-layer capture settings.                                                          |
| `catalog.history.processing.enabled`               | `false`                    | Enables processor-layer capture via `HistoryRecordingCatalogProcessor`.                    |
| `catalog.history.reconciler`                       | unset                      | Scheduled in-process reconciler settings.                                                  |
| `catalog.history.reconciler.enabled`               | `false`                    | Enables scheduled in-process reconciliation.                                               |
| `catalog.history.reconciler.schedule`              | unset                      | Optional Backstage scheduler config; omitted uses the defaults below.                      |
| `catalog.history.reconciler.schedule.frequency`    | `{ hours: 1 }`             | Scheduler frequency for the in-process reconciler.                                         |
| `catalog.history.reconciler.schedule.timeout`      | `{ minutes: 10 }`          | Scheduler timeout for one reconcile run.                                                   |
| `catalog.history.reconciler.schedule.initialDelay` | `{ seconds: 30 }`          | Delay before the first scheduled reconcile run.                                            |

Processing capture and the scheduled reconciler are config-only after `backend.add(import('backstage-plugin-catalog-backend-module-history'))`; no extra code wiring is needed.

## Query the history

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

The reconciler snapshots the live catalog, diffs against the history table, and records drift as a cycle with `provider='reconciler'` and `source='reconciler'`. Safe to run repeatedly; a clean catalog records a heartbeat cycle.

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

- [Implementation plan](docs/plans/2026-05-11-catalog-history-backstage-module.md)
- [Architecture](docs/ARCHITECTURE.md)

## License

Apache-2.0
