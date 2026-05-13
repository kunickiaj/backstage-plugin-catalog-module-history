# backstage-plugin-catalog-backend-module-history

A Backstage backend module that records every catalog `EntityProvider` mutation into a versioned history store, producing a queryable audit trail of every entity change with no impact on Backstage's hot path.

Ships with a Postgres backend in v1; designed around a pluggable `HistoryStore` interface so additional backends (Dolt, ClickHouse, etc.) can be added without changes to the wrapper.

**Status: pre-alpha.** Under active development; not yet published to npm.

## What it does

1. **Bootstraps the history schema** on backend startup (two tables in the same database Backstage's catalog uses, unless overridden).
2. **Wraps your `EntityProvider`s** with `HistoryRecordingEntityProvider` so every `applyMutation` call is mirrored into a versioned history table. The catalog write happens first; history recording is best-effort and never blocks or fails the catalog path.
3. **Provides a standalone reconciler CLI** (`reconcile-catalog-history`) for on-demand drift detection — useful when you suspect missed cycles, add a new provider without wrapping it, or perform manual catalog surgery.

History coverage today is **full mutations only**. `delta`-emitting providers (webhook-driven) are recognized and skipped with a warning; native delta recording and hybrid full+delta providers are on the v1.x roadmap.

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

That gives you the schema and types; nothing yet records anything. To actually capture mutations, wrap each provider you care about with `HistoryRecordingEntityProvider`:

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
          database: coreServices.database,
        },
        async init({ catalog, logger, database }) {
          const store = new PostgresHistoryStore(await database.getClient());
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

## Config

All optional; sensible defaults.

```yaml
catalog:
  history:
    enabled: true # set to false to skip schema bootstrap entirely

    # Optional: write to a different Postgres instance than Backstage's
    # main catalog DB. Defaults to the same DB Backstage uses.
    database:
      client: pg
      connection: ${PG_HISTORY_URL}
```

## Query the history

The module owns two tables in Postgres:

- `catalog_history_cycles` — one row per recorded `applyMutation`, with `n_added` / `n_modified` / `n_removed` / `n_unchanged` aggregates.
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

## Reconciler CLI (optional, on-demand)

The wrapper captures every mutation the providers themselves emit, so under normal operation history stays in sync with the catalog. If you suspect drift — a provider was registered without being wrapped, an `applyMutation` call failed silently, or someone modified the catalog out-of-band — run the reconciler once:

```sh
BACKSTAGE_BASE_URL=https://backstage.example.com \
BACKSTAGE_TOKEN=... \
PG_CONNECTION_STRING=postgres://... \
npx reconcile-catalog-history
```

It snapshots the live catalog, diffs against the history table, and records any drift as a single cycle attributed to `provider='reconciler'`. Safe to run repeatedly; a clean catalog records a no-op heartbeat cycle.

The reconciler is intentionally not scheduled as a background task. Running it from inside the catalog backend would mean a catalog plugin querying its own live state in a loop, which is a coupling smell. Run it externally (k8s CronJob, manual invocation, your CI/CD pipeline) when you actually want drift detection.

## Documentation

- [Implementation plan](docs/plans/2026-05-11-catalog-history-backstage-module.md)
- `docs/ARCHITECTURE.md` (Phase 10)
- `docs/USAGE.md` (Phase 10)
- `docs/INTEGRATION.md` (Phase 10)

## License

Apache-2.0
