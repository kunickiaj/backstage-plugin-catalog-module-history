# Observability

The current source, planned for the release after `0.2.0`, records storage metrics through Backstage's built-in `MetricsService`. The default Postgres store receives that service from its factory; a standard `createBackend()` application provides the factory dependency.

The history plugin creates instruments only. Configure the OpenTelemetry SDK and exporter at the backend root, following Backstage's [metrics service guide](https://backstage.io/docs/backend-system/core-services/metrics) and [OpenTelemetry setup tutorial](https://backstage.io/docs/tutorials/setup-opentelemetry). It does not configure a provider or exporter, and it does not add a `/metrics`, health, or readiness endpoint.

## Metric reference

Metric names and units below are SDK instrument names. An exporter may normalize dots or add unit suffixes, so do not assume every backend exposes the same literal PromQL name.

| Instrument                                       | Type and unit               | Attributes                       | Records                                                                                                                                                                          |
| ------------------------------------------------ | --------------------------- | -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `catalog.history.storage.operations`             | Counter, `{operation}`      | `operation`, `source`, `outcome` | Store methods: `record_cycle`, `load_current_etags`, and `load_all_current_etags`.                                                                                               |
| `catalog.history.storage.operation.duration`     | Histogram, `s`              | `operation`, `source`, `outcome` | The complete store method, including lazy schema setup, pool wait, mapping, and database work.                                                                                   |
| `catalog.history.storage.persistence.duration`   | Histogram, `s`              | `source`, `outcome`              | The transaction invocation through its awaited commit acknowledgement, including pool work, cycle insert, mapping, SQL, and commit. It is not database-server commit time alone. |
| `catalog.history.capture.window.duration`        | Histogram, `s`              | `source`, `outcome`              | A valid nonnegative `finishedAt - startedAt` interval from the capture input. It does not measure persistence or commit duration.                                                |
| `catalog.history.capture.last_success.timestamp` | Observable gauge, `s`       | `source`                         | Application time after a persistence transaction succeeds, including empty heartbeat cycles. Failed writes do not move it forward.                                               |
| `catalog.history.query.operations`               | Counter, `{operation}`      | `operation`, `outcome`           | Database query phases for `timeline`, `feed`, `versions`, and `detail`.                                                                                                          |
| `catalog.history.query.operation.duration`       | Histogram, `s`              | `operation`, `outcome`           | The query-phase wrapper, including pool, transaction control, and cleanup. It excludes shared schema setup, mapping, authorization, and HTTP handling.                           |
| `catalog.history.schema.initializations`         | Counter, `{initialization}` | `component`, `outcome`           | Actual `ensureSchema` attempts and retries for `store` and `query`, not callers awaiting a cached initialization.                                                                |
| `catalog.history.schema.initialization.duration` | Histogram, `s`              | `component`, `outcome`           | Duration of the same schema-initialization attempt.                                                                                                                              |
| `catalog.history.schema.initialized`             | Observable gauge, `1`       | `component`                      | `0` before an observed initialization or after a failed attempt; `1` after `ensureSchema` fulfills. It does not report live database availability.                               |

`source` is one of `provider`, `processing`, `reconciler`, `all`, or `unknown` where applicable. Persistence converts `all` to `unknown` because it is not a capture source. Storage outcomes are `success` and `error`; query outcomes also include `not_found` and PostgreSQL cancellation (`57014`) as `timeout`.

Labels are finite and controlled. The plugin does not add raw provider IDs, entity references, SQL, payloads, or error strings to metric attributes. Provider details remain in the existing logs.

### Attribute values

Use the attributes as dimensions, not as identifiers for individual catalog objects:

- `operation` has the fixed values listed in the metric table.
- `source` reports a capture layer rather than a provider name. `all` is used for store reads without a source filter, and `unknown` covers absent or unsupported values.
- `component` is `store` or `query`.
- `outcome` is intentionally small. Query metrics classify only a `NotFoundError` and PostgreSQL code `57014` beyond `success` and `error`.

The gauges retain only per-source success timestamps and per-component schema state in memory. Collection is passive: it neither opens a connection nor runs a database query.

## Reading capture metrics

`capture.last_success.timestamp` aggregates by capture source, not provider. It is useful for detecting that a source which normally runs has stopped persisting, but it cannot show whether every provider succeeded or identify the failing provider. A quiet provider is normal when it has no expected activity.

When a store receives a caller-owned Knex transaction, its nested transaction only releases a savepoint. The store omits persistence-duration and last-success signals in that case, even if the caller later commits, because it cannot observe the caller's final commit acknowledgement. Method-operation and capture-window metrics still describe the method's outcome, not that outer commit.

`capture.window.duration` describes the capture input boundary from `startedAt` to `finishedAt`; it does not change the timestamp contract. Provider recording forwards the catalog mutation first and then awaits best-effort history persistence.

A slow history write delays wrapper completion, but not the earlier catalog write. If capture fails after that catalog write, retained history can have gaps; a later full refresh can recover current state, not intermediate versions.

The metric scope is the plugin-scoped Backstage meter (normally `backstage-plugin-catalog`), not a meter per provider or user.

### What is and is not timed

The storage-operation histogram is the broad method timer. It includes a lazy schema check, whereas the query-operation histogram starts after the shared schema check and ends before result mapping. Use the persistence histogram when diagnosing writes, and use the capture-window histogram when comparing time reported by a capture caller.

None of these values is a pure PostgreSQL server-execution measurement. Pool acquisition, transaction setup, cleanup, and application work can contribute to the relevant operation duration.

## Operational examples

**Detect a stalled source.** Alert when a source that should refresh regularly has an old `catalog.history.capture.last_success.timestamp`, and alert on new `error` outcomes from `catalog.history.storage.operations`. Treat `provider` as an aggregate: use its existing logs and operation counts to find the provider involved.

**Investigate a slow history page.** Compare `catalog.history.query.operation.duration` by `operation` and `outcome`, then correlate failures and timeouts with existing backend logs. The duration covers the database operation phase, not request validation, authorization, JSON mapping, or total HTTP latency.

**Watch schema retries during startup.** A rising `catalog.history.schema.initializations` count with `outcome="error"` means the store or query layer attempted schema setup and failed. `catalog.history.schema.initialized` remains `0` until a later attempt completes; it is not a connection or database-health check.

Do not use these metrics as a complete availability signal or audit-completeness proof. They do not instrument provider, processor, or reconciler lifecycle work before storage, and the plugin does not expose a storage/schema active probe or public health status.

## Custom storage

The default `historyStoreServiceFactory` injects `metricsServiceRef` from the installed `@backstage/backend-plugin-api` `1.10.1` alpha surface. Custom `HistoryStore` implementations are not instrumented automatically.

When constructing the Postgres store yourself, metrics are optional. Omitting them retains the existing no-op behavior:

```ts
import { PostgresHistoryStore } from '@kunickiaj/backstage-plugin-catalog-history-storage-node';

const store = new PostgresHistoryStore(db, { metrics });
```

Obtain `metrics` through normal Backstage service injection. Do not create a separate metrics registry for this store.

Observable callbacks only read in-memory metric state and do not query the database. Store shutdown removes their callbacks; removal is idempotent. Metrics failures are best effort and do not change, mask, or replace history-store results.

Future work may add provider, processor, and reconciler lifecycle metrics. Those metrics are not part of the current source.
