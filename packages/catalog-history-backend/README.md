# @kunickiaj/backstage-plugin-catalog-history-storage-node

Storage, migrations, and history service factories for the Backstage catalog history plugin family.

This package is a `node-library`, not a backend plugin.

This package owns:

- the Postgres history schema migrations and `ensureSchema` bootstrap;
- `PostgresHistoryStore`, the Postgres implementation of the `HistoryStore` contract from `@kunickiaj/backstage-plugin-catalog-history-node`;
- `historyStoreServiceFactory`, the default factory for `historyStoreServiceRef`, which resolves the consuming plugin's database and provides a schema-aware store.

Add this factory when you want the default Postgres implementation directly:

```ts
import { historyStoreServiceFactory } from '@kunickiaj/backstage-plugin-catalog-history-storage-node';

backend.add(historyStoreServiceFactory);
```

The `@kunickiaj/backstage-plugin-catalog-backend-module-history` default export already includes this factory. If you need custom storage, register your own `createServiceFactory({ service: historyStoreServiceRef, ... })` and use the named `catalogModuleHistory` export instead of the module package's default loader.

For compatibility, the default factory still honors the deprecated `catalog.history.database` override. Prefer a custom service factory for new dedicated-storage setups.

## Migration bookkeeping (unreleased fix)

Backstage modules may own tables in their target plugin's logical database. The current source uses `catalog_history_knex_migrations` and its lock table for new history installations, separate from the target plugin's migration log. See the [Backstage module guidance](https://backstage.io/docs/backend-system/building-plugins-and-modules/).

Concurrent initializers use a PostgreSQL transaction-scoped advisory lock while selecting and bootstrapping the history migration log. This covers metadata creation before Knex's own migration lock exists; PostgreSQL releases the advisory lock on commit or rollback. The database must support PostgreSQL advisory locks.

Published `0.1.0` still uses Knex's default migration log and cannot initialize alongside an already-migrated catalog database. Do not enable that shared-database setup until this fix is released and validated in your environment.

Existing history-only `0.1.0` installations keep their legacy log when every recorded migration belongs to this package. This also supports a partially migrated history schema and a legacy table/schema configured through the Knex client's `migrations` settings. The migration schema setting affects the log, not the location of history data tables.

A history-only legacy log inside a database intended for an uninitialized catalog still blocks the catalog's later migrations. That state needs operator reconciliation; legacy-log reuse does not repair it.

Without an active dedicated log, mixed history/unrelated legacy records or history tables without recognized migration records stop automatic initialization. Back up the database and reconcile its actual schema with the migration records before retrying; this package does not automatically copy, rename, delete, or mark migration records complete. Do not move migration logs merely to bypass the error.

Downgrading an installation that uses the new dedicated log to `0.1.0` is unsupported. Keep a backup and use a compatible version instead of replaying the old migrations.

## Knex client compatibility (unreleased fix)

The current source uses the backend API's Knex `^3.0.0` dependency range, allowing applications to reuse their existing supported client. Published `0.1.0` requests `^3.2.10`, which can install a newer nested Knex with incompatible client types; do not hide that mismatch with a type cast.

Runtime coverage for these fixes includes Knex `3.1.0` and `3.2.10`. The supported range follows the backend API; other allowed versions are not individually tested here.

The productization roadmap discusses future query service and HTTP API work; this package currently remains a storage Node library.

For architecture and roadmap details, see the [workspace README](../../README.md).
