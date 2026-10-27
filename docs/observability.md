# Observability

`0.3.0` adds four optional OpenTelemetry instruments through Backstage's `MetricsService`. Configure the SDK and exporter at the backend root; this package adds no exporter, endpoint, registry, dependency, health check, or readiness check. See Backstage's [metrics service guide](https://backstage.io/docs/backend-system/core-services/metrics) and [OpenTelemetry setup tutorial](https://backstage.io/docs/tutorials/setup-opentelemetry).

## Metric reference

These are SDK instrument names and units. Exporters can add prefixes, replace dots, or add unit suffixes, so inspect exported output before writing PromQL or percentile queries.

| Instrument                                       | Type and unit                              | Attributes                       | Use it to                                                                                           |
| ------------------------------------------------ | ------------------------------------------ | -------------------------------- | --------------------------------------------------------------------------------------------------- |
| `catalog.history.capture.operation.duration`     | Histogram, seconds                         | `source`, `operation`, `outcome` | Find slow or failing capture work, then use logs to identify the provider or run.                   |
| `catalog.history.storage.operation.duration`     | Histogram, seconds                         | `operation`, `source`, `outcome` | Find slow or failing history-store methods, then investigate the plugin storage path.               |
| `catalog.history.query.operation.duration`       | Histogram, seconds                         | `operation`, `outcome`           | Find slow, failed, or timed-out read operations, then inspect logs and query plans.                 |
| `catalog.history.capture.last_success.timestamp` | Observable gauge, seconds since Unix epoch | `source`                         | Check whether a self-owned history write has been acknowledged within its expected capture cadence. |

Histogram `count` (usually exported as `_count` for Prometheus) supports operation and error rates without separate counters. It is a count of completed instrumented operations, not an HTTP-request count. For example, cycle-list reads produce one `cycles` SQL-phase sample; cycle detail produces two `cycle_detail` SQL-phase samples. An empty successful as-of lookup is `success`, not `not_found`.

## Attributes and cardinality

All attributes are finite and controlled. Metrics never contain raw provider IDs, provider prefixes or names, entity references, SQL, payloads, or error text. Use the existing logs to identify those values.

`source` is one of `provider`, `processing`, `reconciler`, `all`, or `unknown` on storage metrics. Capture metrics use only `provider`, `processing`, and `reconciler`.

Capture `operation` is one of:

- `provider_mutation`
- `processing_entity`
- `processing_flush`
- `reconcile`

Query `operation` is one of:

- `timeline`, `feed`, `versions`, `detail`, or `diff` (unreleased)
- `cycles` or `cycle_detail`
- `as_of`, `providers`, `entities`, or `kinds`

Query outcomes are `success`, `error`, `timeout` (PostgreSQL `57014`), and `not_found` (`NotFoundError`). Capture and storage outcomes are `success` or `error`.

Four instrument names do not mean four time series. Each permitted label combination, histogram bucket, enabled capture layer, host View, and exporter can create additional series.

## Timings and success acknowledgement

Capture duration measures the complete high-level operation. `processing_entity` includes unchanged observations; `processing_flush` is emitted only for a nonempty buffer that is actually flushed. Use the former's histogram count for processing activity and the latter's error count for failed persistence.

Storage duration measures the complete store method, including mapping, schema work, pool wait, transaction handling, and database work. It is useful for locating time in the plugin's storage path; it is not a pure PostgreSQL server-execution timer. Compare it with whole-capture duration before investigating the database.

Query duration covers the query operation phase, including relevant pool and transaction work. It is not total HTTP latency. For a slow or timing-out operation, correlate the metric with backend logs and inspect the query plan; do not raise the default timeout without evidence.

The last-success gauge advances only after a successful, self-owned persistence transaction receives its commit acknowledgement. A caller-owned transaction uses a savepoint, so its outer commit is unknown and does not update the gauge—even if that caller later commits. Failed, rolled-back, or disposed transactions do not advance it. The observable callback only reads in-memory state; it does not probe database health or readiness. Startup diagnosis remains in existing logs; this source has no initialization metrics.

`source="processing"` can become old during normal quiet periods because unchanged processing observations do not flush. Do not alert on processing staleness. Instead, use `processing_entity` histogram count for activity and `processing_flush` error count for persistence failures. The gauge aggregates each source and cannot report individual-provider health.

Reconciliation can later observe current served state, but it cannot recover missed intermediate versions, actors, or event times.

## Buckets and SDK configuration

The package supplies static histogram advice with these second-based boundaries:

| Instrument | Boundaries (seconds)                                                   |
| ---------- | ---------------------------------------------------------------------- |
| Capture    | `.0001`, `.001`, `.01`, `.1`, `1`, `5`, `10`, `30`, `60`, `300`, `600` |
| Storage    | `.001`, `.01`, `.1`, `1`, `5`, `10`, `30`, `60`, `300`                 |
| Query      | `.001`, `.005`, `.01`, `.05`, `.1`, `.5`, `1`, `5`, `10`               |

This advice uses the existing metrics-service options; it is not a new configuration framework. Host OpenTelemetry Views can override advice. Keep Views and units consistent, and inspect exported bucket names and values before building percentile alerts.

## Wiring and custom storage

The default Postgres store gets metrics from its factory. The default catalog module supplies metrics automatically to internally created processing capture and scheduled reconciliation. Provider wrappers use manual dependency injection: add `metricsServiceRef` to the wrapper module's existing `registerInit` dependencies and pass the injected `metrics` value to `HistoryRecordingEntityProvider`.

```ts
import { metricsServiceRef } from '@backstage/backend-plugin-api/alpha';

deps: {
  // Keep the existing dependencies.
  metrics: metricsServiceRef,
},

new HistoryRecordingEntityProvider({
  inner,
  store: historyStore,
  logger,
  metrics,
});
```

A manually constructed Postgres store records storage and query metrics when you pass the same service:

```ts
const historyStore = new PostgresHistoryStore(db, { metrics });
```

Manual provider wrappers, custom stores, and standalone CLI calls can omit metrics and use the existing no-op behavior. Custom `HistoryStore` implementations are not instrumented automatically. Metric-SDK failures are isolated and do not change domain results, errors, or capture timestamps.

## Operator examples

- **Provider capture errors or latency:** filter capture duration by `source="provider"` and `operation="provider_mutation"`, then identify the provider in logs. A successful catalog mutation can still have a failed history write.
- **Processing persistence failure:** compare `processing_entity` activity with `processing_flush` errors. A failed nonempty flush is logged and dropped without changing processor behavior.
- **Slow storage:** compare storage-method duration with capture duration. If storage dominates, investigate mapping, schema work, pool wait, transaction handling, and SQL in the plugin storage path.
- **Slow history reads:** filter query duration by `operation` and `outcome`; investigate logs and plans for errors or `timeout` results.
- **Freshness:** alert on an old last-success timestamp only for provider or reconciler sources with a known expected cadence. It records an acknowledged self-owned history persistence, not full provider health or audit completeness.
