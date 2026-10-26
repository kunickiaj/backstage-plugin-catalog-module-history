# History storage sizing

Size history storage from retained changed observations, payload size, enabled
capture sources, and recording cycles. Do not size it from the current catalog
entity count alone.

There is no universal maximum catalog size, supported retention period, or
latency objective for this module. An installation's change rate and payloads
determine both storage growth and work. A catalog with 1,000 frequently changing
entities can retain more history than a 20,000-entity catalog whose records
rarely change.

## Start with the retained-row estimate

For a planning window, estimate entity-observation rows as:

```text
sum over enabled capture layers of
  (daily inserts + daily updates + daily deletes) × planning days
```

Use measurements from the installation for each term. Count changes observed by
each enabled capture layer, rather than multiplying catalog entities by the
number of sources or by every cycle. `provider`, `processing`, and `reconciler`
record different views of an entity. Treat their observations separately when
sizing; their stored content and etags are not interchangeable.

The estimate is for stored entity rows. It does not include the separate cycle
ledger, write-ahead log (WAL), backups, free space, table and index bloat,
vacuum work, or temporary disk required by index builds. Plan capacity for
those operational needs from measurements of the intended PostgreSQL service;
the fixture data below does not provide a fixed headroom ratio.

Choose the planning window from the history users need to investigate or retain.
It is an input to storage planning, not an automatic retention setting. Current
source has no `catalog.history.retention` configuration or retention job. Rows
remain until an operator-managed database lifecycle changes them.

## Account for each capture layer

### Provider capture

Provider capture occurs only when a consumer registers a
`HistoryRecordingEntityProvider` around that provider. The wrapper is not added
automatically by this module. When registered, its `enabled` option defaults to
`true`; the application must pass `catalog.history.provider.enabled` into its
own wrapper wiring for that setting to take effect.

With enabled, successful capture, each provider `full` or `delta` `applyMutation`
call records a cycle, including a mutation whose entities are unchanged. Entity rows are written only for
inserts, updates, and deletes. A busy provider schedule can therefore grow the
cycle table even when its payload-row count is flat.

Provider rows represent what the provider emitted. A full mutation compares its
incoming set with the provider baseline to infer deletions; this is not proof
that every catalog deletion action passed through that provider.

Recording is best effort: a catalog mutation can succeed while history capture
fails. Measure capture failures alongside stored rows so gaps do not understate
expected storage growth.

### Processing capture

Processing capture is off by default. When
`catalog.history.processing.enabled` is `true`, it observes entities during
processing, compares each entity's etag with a processing-only baseline, and
flushes changed rows at 500 rows or after 10 seconds by default.

Processing can observe entities repeatedly, so its observation volume can be
much higher than provider mutation volume. It stores inserts and updates
when the observed content changes, not one payload row per observation. It
cannot observe deletes, and independently registered modules can affect whether
it sees the final processor output.

Unchanged-only processing activity does not create a heartbeat cycle. The
processor flushes only a nonempty changed buffer; unchanged counts can be
carried into a later changed batch and are a best-effort aggregate. Do not use
the processing cycle count as a count of all processing passes.

### Reconciler capture

The scheduled reconciler is off by default
(`catalog.history.reconciler.enabled: false`). When it is enabled and
`catalog.history.reconciler.schedule` is omitted, the scheduler uses a one-hour
frequency, a 10-minute timeout, and a 30-second initial delay.

Keys omitted from an explicit `schedule` inherit those defaults, so setting only
`frequency` keeps the 10-minute timeout and 30-second initial delay. Set
`initialDelay: { seconds: 0 }` to start without a delay.

Each reconcile run walks every catalog page, using 500-entity pages by default,
and accumulates the entities in memory before mapping and diffing. It also loads
an unpaged map of the latest retained reconciler states. Catalog pagination does
not make the overall run incremental: every run scans the full served catalog
and queries retained reconciler state. A successful run records a cycle; an
unchanged run records a heartbeat cycle but no entity payload rows.

The first run stores the whole observed catalog as inserts because its baseline
is empty. Later runs store only observed inserts, updates, and deletes. Shortening
the interval increases full-scan work and cycle rows. Successful runs refresh the
observed state at that cadence, but delays or failures can make it older. The
reconciler cannot retain intermediate versions that appear and disappear between
observations or recover a missed deletion's original actor, time, or payload.

Choose the cadence from the freshness required by the installation and observed
run completion time. Start with the default, then measure reconciler runtime,
database pool activity, and capture/store errors before reducing the interval.
The scheduler timeout is a scheduler budget, not evidence that a running SQL
statement is cancelled then or that the cadence creates a lossless audit record.

## Measure before projecting

Collect a representative period of actual source changes before reserving long
term capacity. Record, separately for provider, processing, and reconciler:

- inserted, updated, and deleted entity rows per day;
- cycles per day, including empty provider and reconciler cycles;
- metadata, spec, relations, and status payload sizes for retained rows;
- enabled providers and their refresh or webhook patterns; and
- reconciler completion time, failures, and freshness needs.

Catalog entity count cannot supply these values. It does not reveal source change
rates, processor emissions, provider cadence, payload width, or enabled layers.

The capture lifecycle metrics described in [Observability](observability.md)
can help correlate capture operations and store failures. They are optional host
telemetry: this module does not add an exporter, endpoint, health check, or
readiness signal. Use the host's existing OpenTelemetry configuration and its
own service-level objectives when defining alerts.

For a low-cost physical-size check, an authorized database operator can inspect
the history relation without scanning every row:

```sql
SELECT
  pg_total_relation_size('catalog_history_entities'::regclass) AS total_bytes,
  pg_indexes_size('catalog_history_entities'::regclass) AS index_bytes;
```

`pg_total_relation_size` includes the table, indexes, and TOAST storage. Do not
add `index_bytes` to it. Check installed indexes separately from this repository's
source definitions, because a database can have a different migration history:

```sql
SELECT indexname, indexdef
FROM pg_indexes
WHERE schemaname = current_schema()
  AND tablename = 'catalog_history_entities'
ORDER BY indexname;
```

These reads require the operator to select the correct database and schema. Do
not turn routine sizing into an unbounded production `COUNT(*)` probe without
first accounting for its cost on that service.

## Use fixture measurements as a starting point, not a capacity limit

The [history store query benchmark](benchmark-queries.md) measured direct store
calls in an owned PostgreSQL 16 Docker database. It did not run a catalog
backend, HTTP API, provider, processor, reconciler, production concurrency, or
a retention workflow. The four completed runs used workspace source labelled
`0.2.0` with post-release code, not a published-package benchmark.

The fixture used compact UTF-8 `metadata` plus `spec` targets of 1,190 bytes
for `standard` and 8,882 bytes for `heavy`. They are not full entity sizes or
production JSON compression profiles: deterministic SHA-256 ASCII padding kept
fixture widths stable. The separate catalog baseline adds required
managed-location annotations, making its standard submitted payload 1,311 bytes.

After 5,000 write-probe rows, `catalog_history_entities` occupied:

| Fixture case | Final rows | Total relation size | Index size | TOAST total |
| ------------ | ---------: | ------------------: | ---------: | ----------: |
| Standard     |     15,000 |           27.26 MiB |   3.79 MiB |    0.01 MiB |
| Standard     |    105,000 |          188.02 MiB |  23.88 MiB |    0.01 MiB |
| Standard     |    205,000 |          367.91 MiB |  47.47 MiB |    0.01 MiB |
| Heavy        |     15,000 |          143.52 MiB |   3.80 MiB |  133.52 MiB |

The corresponding exact totals were 28,581,888; 197,156,864; 385,777,664; and
150,495,232 bytes. The standard cases worked out to about 1.8–1.9 KiB per retained
row, while the heavy case was about 9.8 KiB per row, including indexes, TOAST,
and page alignment. Treat these as conditional fixture observations, not linear
storage guarantees or a supported-million-row capacity plan.

The 20,000-reference, 200,000-seed-row case was a direct-store fixture. It did
not serve a 20,000-entity catalog end to end. The catalog backend baseline
diagnostic exercised catalog 4.0.2 with a 1,000-reference standard scenario; it
did not reproduce an earlier five-second timeout.

## Interpret the query measurements by shape

At 200,000 seeded standard rows, the direct public latest-etag lookup had about
one-second quiescent p95 for both provider/source and all/source scopes. The
unfiltered 25-item feed p95 stayed below 7 ms across the standard size ladder.
That difference reflects query scope, not a general rule that a history table is
fast or slow at a particular size.

The latest-etag lookup supports capture baselines and is unpaged. Watch it as
retained history grows. Entity-page tail values varied by phase, and the
benchmark did not capture plans that identify a cause.

The index experiments do not change production indexes or queries. A covering
candidate improved an unscoped fixture read from a 934 ms median to 27 ms, but
failed for a valid opaque 5,000-byte etag. The later late-join and LATERAL
candidates had mixed scope-specific results. The raw LATERAL case hit the
fixture's 30-second SQL cap at 200,000 rows without statistics. The materialized
case had unscoped p95 of 319 ms versus 1,014 ms for baseline, but provider-plus-
source p95 of 517 ms versus 168 ms. No fixture result supports a universal
fast-query claim or a migration recommendation.

## Plan retention as a separate change

Until retention work exists, choose a desired history window only for storage,
backup, and restore planning. Set storage alerts, take backups, and verify a
restore path before any future maintenance work. Do not treat the roadmap's
example retention keys or TTLs as current configuration.

Future retention design must preserve the newest useful state, delete tombstones
for an appropriate period, source and provider detail, version history, and the
predecessor needed for useful comparisons.

See the [productization roadmap](plans/2026-07-05-catalog-history-productization-roadmap.md#phase-4--retention-and-compaction)
for the planned, not implemented, retention work. The [known deletion-capture
limitation](../README.md#known-deletion-capture-limitation) remains relevant:
retained history is not a complete record of catalog deletion actions.

## Limits of the available evidence

The benchmark environment was Node 24.22.1, PostgreSQL 16.15, and macOS arm64
on an Apple M4 Max with 14 host CPUs and about 36 GiB host memory. Container CPU
and memory quotas were unknown. PostgreSQL used `shared_buffers = 128MiB`,
`work_mem = 4MiB`, and `synchronous_commit = on`.

The benchmark used warm local conditions. It did not measure cold operating
system cache, soak behavior, representative concurrent traffic, full HTTP query
paths, production I/O, retention, destructive cleanup, or external durability.
The local `synchronous_commit` setting is not a durability report for another
database service.

Each store benchmark run seeded 10,000, 100,000, or 200,000 rows, plus 5,000
committed writer-probe rows where applicable. It recorded 50 samples after five
warmups for 10 query shapes in each of two states: 1,000 reads per run. Its 50
writer holds were uncommitted-read barriers followed by commits, not concurrent
inserts or a load test.
