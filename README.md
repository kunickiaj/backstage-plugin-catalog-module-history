# backstage-plugin-catalog-backend-module-history

A Backstage backend module that records every catalog `EntityProvider` mutation into a versioned history store, producing a queryable audit trail of every entity change with no impact on Backstage's hot path.

Ships with a Postgres backend in v1; designed around a pluggable `HistoryStore` interface so additional backends (Dolt, ClickHouse, etc.) can be added without changes to the wrapper.

**Status: pre-alpha.** Under active development; not yet published to npm.

## What it does

1. **Wraps your `EntityProvider`s** with `HistoryRecordingEntityProvider` so every `applyMutation` call is mirrored into a versioned history table. The catalog write happens first; history recording is best-effort and never blocks or fails the catalog path.
2. **Records cycles** to two tables: `catalog_history_cycles` (one row per mutation, including heartbeats with zero row changes) and `catalog_history_entities` (one row per entity change with structured columns + JSONB metadata/spec).
3. **Runs a reconciler** on a schedule (default hourly) that snapshots the live catalog and records any drift attributed to `provider='reconciler'`, so missed cycles get caught.

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

// Optional: wrap individual entity providers so their mutations are
// recorded under the provider's own name (instead of getting picked up
// only by the reconciler at the next scheduled run).
import { HistoryRecordingEntityProvider } from 'backstage-plugin-catalog-backend-module-history';
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
          store: /* your HistoryStore */,
        },
        async init({ catalog, logger, store }) {
          const inner = OktaOrgEntityProvider.fromConfig(...);
          catalog.addEntityProvider(
            new HistoryRecordingEntityProvider({ inner, store, logger }),
          );
        },
      });
    },
  }),
);

backend.start();
```

The reconciler safety net runs regardless of whether you wrap individual providers, so the minimum viable setup is just `backend.add(import('backstage-plugin-catalog-backend-module-history'))`.

## Config

All optional; sensible defaults.

```yaml
catalog:
  history:
    enabled: true # set to false to disable the module entirely

    # Optional: write to a different Postgres instance than Backstage's
    # main catalog DB. Defaults to the same DB Backstage uses.
    database:
      client: pg
      connection: ${PG_HISTORY_URL}

    reconciler:
      enabled: true # set to false to run the CLI as an external CronJob instead
      frequency: { hours: 1 }
      timeout: { minutes: 10 }
```

## Query the history

Once running, the module owns two tables in Postgres:

- `catalog_history_cycles` — one row per provider refresh / reconciler run, with `n_added` / `n_modified` / `n_removed` / `n_unchanged` aggregates.
- `catalog_history_entities` — one row per entity change, with structured columns (`entity_ref`, `kind`, `namespace`, `name`, `provider`, `op`, `etag`, `display_name`, `email`, `owner`, `parent`, `member_of`) plus JSONB `metadata` and `spec`.

Example queries (`docs/USAGE.md` coming in Phase 10):

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
```

## Standalone reconciler CLI (optional)

For ad-hoc backfills or running the reconciler as an external CronJob, the package exposes a `bin`:

```sh
BACKSTAGE_BASE_URL=https://backstage.example.com \
BACKSTAGE_TOKEN=... \
PG_CONNECTION_STRING=postgres://... \
npx reconcile-catalog-history
```

Set `catalog.history.reconciler.enabled: false` in the Backstage app config when running this way to avoid the in-process schedule double-running.

## Documentation

- [Implementation plan](docs/plans/2026-05-11-catalog-history-backstage-module.md)
- `docs/ARCHITECTURE.md` (Phase 10)
- `docs/USAGE.md` (Phase 10)
- `docs/INTEGRATION.md` (Phase 10)

## License

Apache-2.0
