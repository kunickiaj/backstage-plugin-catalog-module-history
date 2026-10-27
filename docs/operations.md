# History operations

Use this runbook when the history module is enabled in a production Backstage backend.

## History tables are growing

The module writes two PostgreSQL tables:

- `catalog_history_cycles` records capture cycles, including provider refreshes and reconciler heartbeats that might not add entity rows.
- `catalog_history_entities` records changed entity observations and their stored fields.

Growth depends on enabled capture layers, their schedules, the catalog's change rate, and retained payload size. A current catalog entity count is not enough to predict either table's size. Use [History storage sizing](sizing.md) to estimate retained rows, measure relation size, and choose a retention window.

Enable retention when the retained history exceeds the window the organization needs, or when measured growth would exceed the database capacity plan. Start with a dry run. [Run retention safely](#run-retention-safely) describes the deleting step.

## Startup failed during migration

When any history read, capture, or retention layer is on, the module calls `ensureReady` during backend startup. The default PostgreSQL store then opens a connection and runs its migrations. A migration failure therefore prevents the backend from starting.

The history migration ledger is `catalog_history_knex_migrations`. Check that table in the database and schema used by the history store, then compare its records with the installed migration files. Also check PostgreSQL connectivity, credentials, available disk, locks, and the backend log for the original migration error.

These errors need operator review:

- `History migration records are mixed with unrelated migrations in ...; automatic migration refused. Back up and reconcile the migration records before retrying.`
- `History tables exist without recognized history migration records; automatic migration refused. Back up and reconcile the schema and migration records before retrying.`

Do not run down migrations. Do not edit migration records by hand without a backup and an operator review of the schema and migration history. See [Plan the database upgrade](migration.md#7-plan-the-database-upgrade) before changing a production history database.

## The reconciler timed out or failed

The scheduled reconciler is enabled by `catalog.history.reconciler.enabled`. Its default schedule is one-hour frequency, 10-minute timeout, and 30-second initial delay. Configure all three under `catalog.history.reconciler.schedule`, or set only the values that need to differ because omitted keys use the defaults.

```yaml
catalog:
  history:
    reconciler:
      enabled: true
      schedule:
        frequency: { hours: 1 }
        timeout: { minutes: 10 }
        initialDelay: { seconds: 30 }
```

Successful unchanged runs log:

```text
Reconciler heartbeat: no drift across <count> entities
```

Runs that record changes log:

```text
Reconciler recorded drift: <inserts> insert(s), <updates> update(s), <deletes> delete(s); <unchanged> unchanged
```

The scheduler logs a failed run as `catalog-history scheduled reconcile failed`. Check the attached error, scheduler timeout, catalog API availability, database activity, and the time needed to scan the served catalog. The first successful run records the whole catalog as inserts because its reconciler baseline is empty. See [Reconciler capture](sizing.md#reconciler-capture) for its scan and storage costs.

## History reads exceed their deadline

`catalog.history.api.queryTimeoutMs` limits each history-read SQL statement in the default PostgreSQL store. It defaults to `10000` milliseconds. Set it to `0` only to remove the plugin's limit. A lower PostgreSQL `statement_timeout` still applies.

```yaml
catalog:
  history:
    api:
      queryTimeoutMs: 10000
```

The API logs `Catalog history query failed` with error metadata and returns a sanitized HTTP `500` response, `Unable to retrieve catalog history`. Start by checking `catalog.history.query.operation.duration`, filtered by `operation` and `outcome`. A PostgreSQL cancellation has `outcome="timeout"`. Use the matching backend log and query plan before raising the limit. See [Slow history reads](observability.md#operator-examples) for the metric names and their limits.

## Provider history is falling behind

A provider wrapper records mutations in arrival order. When history writes are slower than the provider's mutations, recordings wait in line. The wrapper logs one warning when more than 20 are queued, and warns again only after the queue drains:

```text
History recording for provider <name> is <count> mutations behind. Catalog writes continue, but each applyMutation call waits for its own recording.
```

Catalog writes still go through, but the provider's `applyMutation` calls take longer, because each call waits for its own recording. Check `catalog.history.storage.operation.duration` for `record_cycle` and `load_current_etags`, database load, and locks on the history tables. With `convertFullToDelta` on, each converted full reads the history baseline before it forwards, so slow history also delays that provider's catalog writes. A history call that hangs stops them until it finishes. The `queryTimeoutMs` deadline does not apply to these baseline reads or to recording writes. See [Overlapping provider mutations](../packages/catalog-backend-module-history/README.md#overlapping-provider-mutations-in-050).

## Run retention safely

Retention is off by default. It requires `catalog.history.retention.enabled: true` and a `maxAge` of at least one day. `dryRun` defaults to `true`, so start with it enabled and inspect the next log:

```text
catalog-history retention finished: mode=dry-run cutoff=<timestamp> deletedEntityRows=<count> supersededRows=<count> emptyCycles=<count>
```

`deletedEntityRows` counts rows for entities whose retained capture streams ended in old deletes. `supersededRows` counts old rows with a newer row in the same entity, source, and provider stream. `emptyCycles` counts old cycles left without rows. A dry run changes nothing.

Before the first deleting run, take a tested backup. Deletion cannot be undone. Then set `catalog.history.retention.dryRun: false` and keep the first window and batch size conservative. A deleting run logs the same fields with `mode=delete`.

```yaml
catalog:
  history:
    retention:
      enabled: true
      maxAge: { days: 90 }
      dryRun: false
      batchSize: 1000
```

Deleting runs commit batches of at most `batchSize` rows or cycles. A large first cleanup can take several scheduled runs. If the scheduler timeout stops a run, it logs:

```text
catalog-history retention stopped before finishing: mode=delete cutoff=<timestamp> deletedEntityRows=<count> supersededRows=<count> emptyCycles=<count>
```

Later runs continue from the remaining eligible rows. A dry run counts all eligible rows in one query. The scheduler timeout does not stop that query, so a dry run can take longer than an individual deleting batch.

Deleting rows does not immediately reduce PostgreSQL table files. PostgreSQL can reuse the freed space after vacuum. Reclaiming file size requires `VACUUM FULL` or `pg_repack`, both with locking implications. Plan that work with the database operator instead of running it as part of retention.

Retention can invalidate a change-feed cursor when it points to a removed row. The API returns `400`. Clients must restart from the first page.

See [Plan retention](sizing.md#plan-retention) for retention behavior and storage planning.

## Users receive 401, 403, or permission denied

History routes require user authentication and the `catalog-history.read` permission. When Backstage permissions are enabled, the policy must return an explicit `ALLOW`. A `DENY` or conditional decision is rejected.

- `401` means the request has no acceptable user authentication.
- `403` means authentication succeeded but the permission decision was rejected.
- `404` means the requested route or resource was not found. It is not a permission response.

Check the user's authentication path and the policy decision for `catalog-history.read`. Read access grants retained history across entities, including deleted entities, without following current catalog visibility. See the [HTTP API access rules](../README.md#read-history-over-http-in-020).

## Disable history without deleting data

Set `catalog.history.enabled: false` to turn off all history layers. The module opens no history database connection and runs no migrations. Existing rows stay in `catalog_history_cycles` and `catalog_history_entities`.

Leaving history enabled but turning off the API, provider, processing, reconciler, and retention layers also opens no connection and runs no migrations.

Provider wrappers created with `HistoryRecordingEntityProvider.fromConfig` become passthroughs when history or provider capture is off. They do not call the history store. A wrapper created with the constructor follows its own `enabled` option, not `catalog.history.enabled`. Review manually constructed wrappers before using the master switch as a database-access guarantee.
