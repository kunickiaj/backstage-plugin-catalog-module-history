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

## Cycle-read capability in `0.3.0`

The cycle endpoints additionally use the optional `listCycles` and `getCycle` query methods. A custom store that supports older history routes but omits either method continues to serve those routes; the corresponding cycle route returns `501` after the normal user authentication and `catalog-history.read` authorization. It does not change `401` or `403` handling.

`listCycles` returns recorded cycle headers and `getCycle` returns one header with a page of retained change metadata. Cycle counts are values recorded for the capture run, so they can exceed the retained rows returned by a detail page. The default Postgres implementation runs one query for a cycle list and two for a cycle detail: it loads the header first and does not query changes when the header is absent.

## As-of read capability in `0.3.0`

`HistoryStore.query.getEntityAsOf` is optional for custom stores. It accepts an entity reference, a required timestamp, and optional exact source and provider filters; it returns the latest retained physical observation at or before that timestamp, or no observation. A custom store without it continues to serve existing routes; the catalog route returns `501` after normal authentication and `catalog-history.read` authorization.

The default Postgres implementation uses one lookup with an inclusive timestamp cutoff, ordered by stored `changed_at` and bigint `id`, both descending. It applies the normal per-statement timeout and records the fixed query-metric operation `as_of`.

## Diff capability (unreleased)

`HistoryStore.query.getEntityDiff` is optional for custom stores. A custom store without it continues to serve existing routes. The catalog diff route returns `501` after normal authentication and `catalog-history.read` authorization.

The default Postgres implementation loads both rows of the entity in one statement under the normal per-statement timeout and records the query-metric operation `diff`. A missing row, or a row of another entity, raises `NotFoundError`. An invalid row ID or the same row twice raises `InputError`.

## Statement timeouts

`0.3.0` adds a 10-second PostgreSQL `statement_timeout` for each history-read SQL statement made through the default store. It does not apply to capture writes, schema setup, pool acquisition, application-side mapping, transaction cleanup, or the whole HTTP request. A timed-out read follows the existing sanitized backend-error path, which currently returns `500`, not a new timeout status.

```yaml
catalog:
  history:
    api:
      queryTimeoutMs: 10000
```

A disconnected HTTP client does not immediately cancel its SQL; the statement can continue until its database deadline. Exact event detail and cycle detail each run two SELECTs, each with its own limit rather than one shared request budget.

`queryTimeoutMs` must be an integer from `0` through `2147483647`. Set it to `0` to disable the plugin limit; an existing database `statement_timeout` still applies, and a lower positive database limit wins over the configured value.

Backstage treats a configuration value of `null` as absent, so it selects the default rather than disabling the limit. Use `0` explicitly to disable the plugin limit.

The setting configures the default Postgres factory. Custom query implementations must set their own limits. A manually constructed `PostgresHistoryStore` can use the same option:

```ts
import { PostgresHistoryStore } from '@kunickiaj/backstage-plugin-catalog-history-storage-node';

const store = new PostgresHistoryStore(db, { queryTimeoutMs: 5_000 });
```

## Saved-field summaries in `0.3.0`

The default Postgres store supplies optional owner, relations, status, and orphan change flags on entity timeline rows and current exact-event detail responses. Comparisons use the immediately preceding physical saved event from the same entity, source, and provider, ordered by stored timestamp and ID. Owner, operation, time, and page filters select displayed rows without redefining their predecessors.

A supplied flag is `true` for different known saved values and `false` for equal known values. If either field was not recorded, the flag is omitted. Inserts, deletes, updates without a predecessor, and updates immediately following a deletion return `{}`. Array values are compared whole and order-sensitive; object key order is ignored. These summaries do not describe upstream deltas or graph changes.

The metadata-only global feed, version lists, and nested `previousVersion.summary` keep empty summaries. Custom query implementations may also leave summaries unavailable. Timeline enrichment stays within one paged SQL statement; exact detail keeps its existing two statements. The returned page size limits predecessor payloads, not the amount of database work.

## Provider discovery in `0.3.0`

The default store adds optional `getProviders` discovery over retained entity-history rows. It returns original provider-name strings, with literal case-insensitive prefix matching and deterministic `C`-collated name pagination. All supplied entity, kind, source, operation, and time filters apply before distinct-name selection. Existing history `provider` matching remains exact.

The capability is optional on `HistoryStore.query`; custom stores do not need it to initialize or serve existing routes. The catalog module exposes it through the authenticated provider route described in the [workspace API guide](../../README.md#provider-discovery-in-030). Unsupported custom queries return `501` only after the existing read authorization succeeds.

Discovery uses the normal per-statement read limit and fixed `providers` query-metric operation. A small returned name page can still scan or sort retained history; no new index or count query is added, and the page limit is not a database-work bound.

## Entity and Kind discovery in `0.3.0`

The default store implements optional `HistoryStore.query.getEntities` and
`getKinds`. `getEntities` makes one paged SELECT and returns retained identity
metadata (`entityRef`, `kind`, `namespace`, and `name`) from the latest matching
row for each canonical reference. It applies entity-search filters before that
deduplication, includes delete-only identities, and does not query the live
catalog or fetch a snapshot per result. `getKinds` makes one paged SELECT over
all retained kinds; it is not a filtered facet or event-count query.

Both methods use the normal per-statement read timeout and fixed query-metric
operations, `entities` and `kinds`. The page lookahead (`limit + 1`) detects a
next cursor; it does not bound database work. Schema setup runs before the
query-phase timer, so `catalog.history.query.operation.duration` measures the
query SQL phase rather than schema initialization.

## Entity-discovery name index in `0.3.0`

Migration `20261025000000_entity_discovery_name_index.js` adds
`catalog_history_entities_name_prefix_idx` on
`(left(lower(name), 128) COLLATE "C") text_pattern_ops`, then runs `ANALYZE
catalog_history_entities`. The bounded expression keeps previously valid wide
names writable. Discovery still rechecks the complete folded name prefix, so
the index does not truncate a reader's prefix or a stored name.

This is a regular transactional index build during `ensureSchema`, not a
concurrent build. PostgreSQL reads can continue, but history writes to
`catalog_history_entities` wait until the migration commits. The read-query
timeout does not cover schema bootstrap, index build, or `ANALYZE`. Back up the
database, test the upgrade against representative retained history, and use an
operator-controlled maintenance window before upgrading a large installation.
No automated precreation or online-index path is provided.

The index helps selective literal name prefixes. Empty searches, broad name
prefixes, late pages, and Kind enumeration can still scan or sort retained
history. See the [entity-discovery evaluation](../../docs/entity-discovery-evaluation.md)
for the measured fixture shapes and limits; its results are not an operator or
production performance guarantee.

## Metrics in `0.3.0`

`0.3.0` adds four optional OpenTelemetry instruments through Backstage's `metricsServiceRef`:

- `catalog.history.capture.operation.duration`
- `catalog.history.storage.operation.duration`
- `catalog.history.query.operation.duration`
- `catalog.history.capture.last_success.timestamp`

The default factory wires the Postgres store automatically. Custom `HistoryStore` implementations and manually constructed stores without a metrics service keep their existing no-op behavior.

Storage duration includes the store method's mapping, schema work, pool wait, transaction handling, and database work; it is not a pure PostgreSQL server timer. Histogram `count` supports operation and error rates without separate counters. Configure the SDK and exporter at the backend root. The workspace [observability guide](../../docs/observability.md) lists the exact names, labels, bucket advice, and manual-store wiring.

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
