# Observability

The unreleased source after `0.2.0` records storage and capture-lifecycle metrics through Backstage's built-in `MetricsService`. The default Postgres store receives the service from its factory; the default catalog module also passes it to internally created processing capture and scheduled reconciliation.

The plugin creates instruments only. Configure the OpenTelemetry SDK and exporter at the backend root, following Backstage's [metrics service guide](https://backstage.io/docs/backend-system/core-services/metrics) and [OpenTelemetry setup tutorial](https://backstage.io/docs/tutorials/setup-opentelemetry). It adds no package dependency, registry, exporter configuration, endpoint, health check, or readiness check.

## Metric reference

Metric names and units below are SDK instrument names. An exporter can normalize dots or add unit suffixes, so do not assume every backend exposes the same literal PromQL name.

| Instrument                                       | Type and unit               | Attributes                       | Records                                                                                                                             |
| ------------------------------------------------ | --------------------------- | -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `catalog.history.storage.operations`             | Counter, `{operation}`      | `operation`, `source`, `outcome` | Store methods: `record_cycle`, `load_current_etags`, and `load_all_current_etags`.                                                  |
| `catalog.history.storage.operation.duration`     | Histogram, `s`              | `operation`, `source`, `outcome` | The complete store method, including lazy schema setup, pool wait, mapping, and database work.                                      |
| `catalog.history.storage.persistence.duration`   | Histogram, `s`              | `source`, `outcome`              | The transaction invocation through its awaited commit acknowledgement, including pool work, cycle insert, mapping, SQL, and commit. |
| `catalog.history.capture.window.duration`        | Histogram, `s`              | `source`, `outcome`              | A valid nonnegative `finishedAt - startedAt` interval from the capture input.                                                       |
| `catalog.history.capture.last_success.timestamp` | Observable gauge, `s`       | `source`                         | Application time after a persistence transaction succeeds, including empty heartbeat cycles.                                        |
| `catalog.history.query.operations`               | Counter, `{operation}`      | `operation`, `outcome`           | Database query phases for `timeline`, `feed`, `versions`, and `detail`.                                                             |
| `catalog.history.query.operation.duration`       | Histogram, `s`              | `operation`, `outcome`           | The query-phase wrapper, including pool, transaction control, and cleanup.                                                          |
| `catalog.history.schema.initializations`         | Counter, `{initialization}` | `component`, `outcome`           | Actual `ensureSchema` attempts and retries for `store` and `query`.                                                                 |
| `catalog.history.schema.initialization.duration` | Histogram, `s`              | `component`, `outcome`           | Duration of the same schema-initialization attempt.                                                                                 |
| `catalog.history.schema.initialized`             | Observable gauge, `1`       | `component`                      | `0` before an observed initialization or after a failed attempt; `1` after `ensureSchema` fulfills.                                 |
| `catalog.history.capture.operations`             | Counter, `{operation}`      | `source`, `operation`, `outcome` | One completed high-level provider mutation, processing observation, nonempty processing flush, or reconciliation run.               |
| `catalog.history.capture.operation.duration`     | Histogram, `s`              | `source`, `operation`, `outcome` | Duration of that same high-level operation.                                                                                         |
| `catalog.history.capture.phases`                 | Counter, `{phase}`          | `source`, `phase`, `outcome`     | One completed capture phase.                                                                                                        |
| `catalog.history.capture.phase.duration`         | Histogram, `s`              | `source`, `phase`, `outcome`     | Duration of that same capture phase.                                                                                                |

`source` is one of `provider`, `processing`, `reconciler`, `all`, or `unknown` where applicable. The high-level instruments use only `provider`, `processing`, and `reconciler`. Persistence converts `all` to `unknown` because it is not a capture source. Storage outcomes are `success` and `error`; query metrics also classify `NotFoundError` as `not_found` and PostgreSQL cancellation (`57014`) as `timeout`.

Labels are finite and controlled. The plugin does not add raw provider IDs, entity references, SQL, payloads, or error strings to metric attributes. Provider details remain in the existing logs.

### High-level capture labels

High-level `operation` values are fixed:

- `provider_mutation`
- `processing_entity`
- `processing_flush`
- `reconcile`

High-level `phase` values are fixed:

- `fetch`
- `baseline`
- `prepare`
- `forward`
- `record`

All high-level outcomes are `success` or `error`. They do not classify cancellation or reporting timeouts. This change does not add SQL, pool, or timeout instrumentation beyond the existing storage and query metrics.

`processing_flush` is emitted only for a nonempty buffer that is actually flushed. Its timer starts when flushing begins, so it excludes time spent waiting in the batch buffer.

Provider and reconciler `baseline` phases time their store reads. Processing records baseline access for each observation; after its initial seed, that access can be a cached map rather than another store read.

### What high-level timings include

`provider_mutation` includes catalog forwarding and awaited history reads, preparation, and recording. It is not a timer for storage SQL alone. If a history write fails after the catalog mutation succeeds, the wrapper fulfills as before but reports the operation as `error`.

For full-to-delta conversion, a failed baseline read forwards the original full mutation, skips history recording, and reports `error`. A catalog forwarding failure still propagates unchanged and reports `forward` as `error`.

`processing_entity` covers entity observation, mapping, baseline access, and the synchronous classify-and-queue flow, including unchanged entities. It can report `success` when `processing_flush` reports `error`: a failed flush is logged and its batch is forfeited without changing processor behavior. Instrumentation adds no await inside the processor's atomic classify-and-queue section.

`reconcile` covers the full run: fetch, mapping and diff preparation, baseline load, and record. Its failures still propagate to the caller; the scheduled module logs them as before.

Phase intervals can repeat or overlap. For example, processing has separate `prepare` intervals for mapping and classification, and reconciliation has separate mapping and diff intervals. Do not add phase durations and expect the operation duration.

`record` with `outcome="success"` means `store.recordCycle` fulfilled. It does not prove an outer caller-owned transaction committed or that retained history is a complete audit trail.

### Existing storage details

Use attributes as dimensions, not as identifiers for individual catalog objects:

- `operation` has the fixed values listed in the metric table.
- `source` reports a capture layer rather than a provider name. `all` is used for store reads without a source filter, and `unknown` covers absent or unsupported values.
- `component` is `store` or `query`.
- `outcome` is intentionally small. Query metrics classify only a `NotFoundError` and PostgreSQL code `57014` beyond `success` and `error`.

The existing gauges retain only per-source success timestamps and per-component schema state in memory. Collection is passive: it neither opens a connection nor runs a database query.

When a store receives a caller-owned Knex transaction, its nested transaction only releases a savepoint. The store omits persistence-duration and last-success signals in that case, even if the caller later commits, because it cannot observe the caller's final commit acknowledgement. Method-operation and capture-window metrics still describe the method's outcome, not that outer commit.

`capture.window.duration` describes the capture input boundary from `startedAt` to `finishedAt`; it does not change the timestamp contract. Provider recording forwards the catalog mutation first and then awaits best-effort history persistence.

The storage-operation histogram is the broad method timer. It includes a lazy schema check, whereas the query-operation histogram starts after the shared schema check and ends before result mapping. Use the persistence histogram when diagnosing writes, and use the capture-window histogram when comparing time reported by a capture caller.

None of these values is a pure PostgreSQL server-execution measurement. Pool acquisition, transaction setup, cleanup, and application work can contribute to the relevant operation duration.

## Enable capture lifecycle metrics

The default catalog module supplies `metricsServiceRef` to processing capture and scheduled reconciliation automatically. The default Postgres store metrics are also automatic, even when provider lifecycle metrics are not wired.

Provider wrappers are created by the host module, so add `metrics: metricsServiceRef` to that module's existing `registerInit` dependencies and pass the injected service to the wrapper. Keep its existing catalog, logger, config, and history-store dependencies.

```ts
import { metricsServiceRef } from '@backstage/backend-plugin-api/alpha';

// In the existing registerInit deps:
deps: {
  // Keep the existing catalog, logger, config, and historyStore entries.
  metrics: metricsServiceRef,
},

// In the existing init callback and provider wrapper:
new HistoryRecordingEntityProvider({
  inner,
  store: historyStore,
  logger,
  metrics,
});
```

This uses normal Backstage dependency injection; it does not fetch a global meter. The installed `@backstage/backend-plugin-api` `1.10.1` alpha surface provides `metricsServiceRef`, and the standard `createBackend()` in `@backstage/backend-defaults` `0.18.0` registers its factory.

Manual provider wrappers, processors, and `reconcile` calls accept an optional metrics service. A standalone CLI or manual reconciliation call without one is not high-level instrumented; its existing logs and domain behavior remain unchanged. There is no implicit global meter or `HistoryStore` telemetry interface.

Custom `HistoryStore` implementations are not instrumented automatically.

Metrics SDK failures are isolated. They cannot mask a domain result, replace an error, or rewrite capture timestamps.

## Operational examples

**A catalog mutation succeeds but capture reports an error.** A provider may forward its mutation to the catalog, then fail to record history. Treat an `error` sample on `catalog.history.capture.operations` with `source="provider"` and `operation="provider_mutation"` as a possible history gap, then use the existing provider logs to identify the provider. A later full refresh can recover current state, but not the intermediate versions that were missed.

**A processor flush is failing.** Check `processing_flush` errors separately from `processing_entity`. The processor can continue returning entities while a failed nonempty batch is logged and dropped; the reconciler can later capture current served state.

**A source appears stalled.** Alert on an old `catalog.history.capture.last_success.timestamp` for a source expected to refresh regularly, then correlate high-level `error` outcomes and existing logs. This aggregate cannot identify a provider or prove every provider succeeded.

**Investigate a slow history page.** Compare `catalog.history.query.operation.duration` by `operation` and `outcome`, then correlate failures and timeouts with existing backend logs. The duration covers the database operation phase, not request validation, authorization, JSON mapping, or total HTTP latency.

**Watch schema retries during startup.** A rising `catalog.history.schema.initializations` count with `outcome="error"` means the store or query layer attempted schema setup and failed. `catalog.history.schema.initialized` remains `0` until a later attempt completes; it is not a connection or database-health check.

Do not use these metrics as a complete availability signal or audit-completeness proof. They do not provide a storage/schema active probe, public health status, provider identity, or a guarantee that all catalog capture was recorded.

## Custom storage

The default `historyStoreServiceFactory` injects `metricsServiceRef` from the installed `@backstage/backend-plugin-api` `1.10.1` alpha surface. When constructing the Postgres store yourself, metrics are optional:

```ts
import { PostgresHistoryStore } from '@kunickiaj/backstage-plugin-catalog-history-storage-node';

const store = new PostgresHistoryStore(db, { metrics });
```

Obtain `metrics` through normal Backstage service injection. Do not create a separate metrics registry for this store.

Observable callbacks only read in-memory metric state and do not query the database. Store shutdown removes their callbacks; removal is idempotent.
