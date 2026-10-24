# @kunickiaj/backstage-plugin-catalog-history-storage-node

Storage, migrations, and history service factories for the Backstage catalog history plugin family.

This package is a `node-library`, not a backend plugin.

This package owns:

- the Postgres history schema migrations and `ensureSchema` bootstrap;
- `PostgresHistoryStore`, the Postgres implementation of the `HistoryStore` contract from `@kunickiaj/backstage-plugin-catalog-history-node`;
- `historyStoreServiceFactory`, the default factory for `historyStoreServiceRef`, which resolves the consuming plugin's database and provides a schema-aware store with the query capability, including `getEntityVersion`, used by the catalog module's opt-in HTTP API.

Add this factory when you want the default Postgres implementation directly:

```ts
import { historyStoreServiceFactory } from '@kunickiaj/backstage-plugin-catalog-history-storage-node';

backend.add(historyStoreServiceFactory);
```

The `@kunickiaj/backstage-plugin-catalog-backend-module-history` default export already includes this factory. If you need custom storage, register your own `createServiceFactory({ service: historyStoreServiceRef, ... })` and use the named `catalogModuleHistory` export instead of the module package's default loader. The catalog module's `0.2.0` HTTP API reads from this same store and database; a custom factory must implement its optional query capability, including `getEntityVersion`, before `catalog.history.api.enabled` can be set to `true`.

For compatibility, the default factory still honors the deprecated `catalog.history.database` override. Prefer a custom service factory for new dedicated-storage setups.

## Statement timeouts

Current source adds a 10-second PostgreSQL `statement_timeout` for each history-read SQL statement made through the default store. The setting is available after the next release; it does not apply to capture writes, schema setup, pool acquisition, application-side mapping, transaction cleanup, or the whole HTTP request. A timed-out read follows the existing sanitized backend-error path, which currently returns `500`, not a new timeout status.

```yaml
catalog:
  history:
    api:
      queryTimeoutMs: 10000
```

A disconnected HTTP client does not immediately cancel its SQL; the statement can continue until its database deadline. Exact event detail runs two SELECTs, each with its own limit rather than one shared request budget.

`queryTimeoutMs` must be an integer from `0` through `2147483647`. Set it to `0` to disable the plugin limit; an existing database `statement_timeout` still applies, and a lower positive database limit wins over the configured value.

Backstage treats a configuration value of `null` as absent, so it selects the default rather than disabling the limit. Use `0` explicitly to disable the plugin limit.

The setting configures the default Postgres factory. Custom query implementations must set their own limits. A manually constructed `PostgresHistoryStore` can use the same option:

```ts
import { PostgresHistoryStore } from '@kunickiaj/backstage-plugin-catalog-history-storage-node';

const store = new PostgresHistoryStore(db, { queryTimeoutMs: 5_000 });
```

## Migration bookkeeping in `0.2.0`

Backstage modules may own tables in their target plugin's logical database. The current source uses `catalog_history_knex_migrations` and its lock table for new history installations, separate from the target plugin's migration log. See the [Backstage module guidance](https://backstage.io/docs/backend-system/building-plugins-and-modules/).

Concurrent initializers use a PostgreSQL transaction-scoped advisory lock while selecting and bootstrapping the history migration log. This covers metadata creation before Knex's own migration lock exists; PostgreSQL releases the advisory lock on commit or rollback. The database must support PostgreSQL advisory locks.

Published `0.1.0` still uses Knex's default migration log and cannot initialize alongside an already-migrated catalog database. Do not enable that shared-database setup until this fix is released and validated in your environment.

Existing history-only `0.1.0` installations keep their legacy log when every recorded migration belongs to this package. This also supports a partially migrated history schema and a legacy table/schema configured through the Knex client's `migrations` settings. The migration schema setting affects the log, not the location of history data tables.

A history-only legacy log inside a database intended for an uninitialized catalog still blocks the catalog's later migrations. That state needs operator reconciliation; legacy-log reuse does not repair it.

Without an active dedicated log, mixed history/unrelated legacy records or history tables without recognized migration records stop automatic initialization. Back up the database and reconcile its actual schema with the migration records before retrying; this package does not automatically copy, rename, delete, or mark migration records complete. Do not move migration logs merely to bypass the error.

Downgrading an installation that uses the new dedicated log to `0.1.0` is unsupported. Keep a backup and use a compatible version instead of replaying the old migrations.

## Global history feed index in `0.2.0`

Migration `20261023000000_global_feed_ordering_index.js` adds the B-tree index `catalog_history_entities_changed_at_id_idx` on `(changed_at DESC, id DESC)`. It supports the global feed's newest-first ordering and cursor pages without sorting the entire retained history.

The index builds during normal history schema bootstrap, including installations with the HTTP API disabled. The existing migration runner uses a transaction and serializes initializers with an advisory lock. PostgreSQL allows reads during this regular index build but blocks writes to `catalog_history_entities` until it finishes; backend startup waits for completion.

**Plan a maintenance window when upgrading large retained histories.** Allow disk space for the index and account for its ongoing write overhead. This migration does not use `CREATE INDEX CONCURRENTLY`, which PostgreSQL prohibits inside the runner's outer transaction; disabling a migration's own transaction would not remove that outer transaction.

Rollback removes only the new index, not recorded entities or cycles. No automatic online-index-build workflow is provided.

## Knex client compatibility in `0.2.0`

The current source uses the backend API's Knex `^3.0.0` dependency range, allowing applications to reuse their existing supported client. Published `0.1.0` requests `^3.2.10`, which can install a newer nested Knex with incompatible client types; do not hide that mismatch with a type cast.

Runtime coverage for these fixes includes Knex `3.1.0` and `3.2.10`. The supported range follows the backend API; other allowed versions are not individually tested here.

The HTTP API is an opt-in `0.2.0` feature of the catalog backend module, not a separate backend plugin. This package remains a storage Node library.

For architecture and roadmap details, see the [workspace README](../../README.md).
