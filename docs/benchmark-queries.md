# History store query benchmark

Four completed runs show that unpaged current-etag lookups were the slowest
measured shape: quiescent p95 reached 1,006.57 ms for `latest.provider/source`
at 200,000 seeded rows. These lookups return hashes of the latest recorded
entity states for capture baselines. Unfiltered feed pages stayed at or below 6.75 ms p95 across the
standard size ladder. Entity-page tails varied between ordered phases, so they
need controlled query-plan investigation rather than an index change based on
these measurements alone.

This opt-in benchmark measures selected public `PostgresHistoryStore` reads and
controlled writes against an owned PostgreSQL 16 Docker database. It exercises
the store directly; it does not start a catalog backend, make HTTP calls, run
providers or processors, or use a network proxy.

## Run a benchmark

Docker is required. The harness rejects the presence of
`BACKSTAGE_TEST_DATABASE_POSTGRES16_CONNECTION_STRING`, including an empty
value, before it calls `TestDatabases.create`. It does not use a caller-supplied
database or change host, global, role, authentication, or readiness settings.

Start with the default 10,000-row seed case. Run larger cases only after that
case passes, and preserve each generated artifact before clearing `.tmp/`.

```sh
env CI=1 \
  yarn workspace @kunickiaj/backstage-plugin-catalog-backend-module-history bench:queries
```

The default uses 1,000 entity references and 10 revisions per reference. It
seeds one committed public `recordCycle` call per revision, with inserts for the
first revision and updates for later revisions. During generation, the fixture
retains the baseline and current revision arrays, not all historical entities.

Use these variables to choose a synthetic case:

| Variable                  |    Default | Allowed values        | Purpose                 |
| ------------------------- | ---------: | --------------------- | ----------------------- |
| `HISTORY_QUERY_REFS`      |      1,000 | 1–20,000              | Entity references       |
| `HISTORY_QUERY_REVISIONS` |         10 | 2–100                 | Revisions per reference |
| `HISTORY_QUERY_PROFILE`   | `standard` | `standard` or `heavy` | Fixture payload profile |

The product of references and revisions must not exceed 200,000 rows. The
`heavy` profile permits at most 1,000 references.

```sh
env CI=1 HISTORY_QUERY_REFS=1000 HISTORY_QUERY_REVISIONS=100 \
  yarn workspace @kunickiaj/backstage-plugin-catalog-backend-module-history bench:queries
```

The size ladder is 1,000 × 10 (10,000 seeded rows), 1,000 × 100 (100,000),
20,000 × 10 (200,000), and the optional 1,000 × 10 `heavy` case. The 50
controlled writer cycles add 5,000 rows whenever the case has at least 100
references.

## Fixture and store scope

The fixture targets compact `metadata` plus `spec` sizes of 1,190 bytes for
`standard` and 8,882 bytes for `heavy`. It adjusts padding for revision digit
length so the target stays exact. Each revision has a unique etag; it does not
reuse named stages or etag values.

Fixtures have no managed-location annotations because the store is the component
under test. They use one kind, provider, and source, with inserts followed by
updates at deterministic timestamps. A
uniform provider label does not show that a provider filter is selective.

Seeding uses 1,000-row internal chunks. This is an implementation detail, not a
batching API. The benchmark makes no schema, index, catalog, reconciler,
provider, processor, cycle, or as-of change.

## Timed reads

The benchmark calls four public query methods plus current-etag lookups. It
measures these shapes:

- `timeline.first` and `timeline.cursor`;
- `versions.first` and `versions.cursor`;
- `detail.known-update`;
- `feed.unfiltered.first` and `feed.unfiltered.cursor`, which have no filters;
- `feed.filtered-entity`, with `entityRef`, kind, provider, source, operation,
  and an inclusive time range; and
- `latest.provider/source` and `latest.all/source`.

Entity pages contain five items and feed pages contain 25. Cursor requests carry
the original scope filter. A cursor marks a position, not a repeatable snapshot;
using an older cursor after new head writes does not promise a historical view.
The harness fully traverses entity timeline and version pages before writes. It
checks only the first two feed pages and uses independent SQL counts, so it does
not claim to page through a 200,000-row feed.

Each phase excludes five warmups, then records 50 successful samples per shape.
The overlap warmups run before any writer is held. The timer covers the awaited
public method, including its response mapping and snapshot-diff work where that
method performs it. Harness assertions, serialization, and artifact writes are
outside the timer. A method or validation failure records its duration and safe
`errorType`; failures are never dropped from the artifact.

The first query that enters schema readiness has a separate
`first-query-schema-promise-unprepared` label. It is neither an operating-system
cache measurement nor a prepared PostgreSQL statement measurement.

The report computes p50 and p95 from raw durations using nearest rank:
`ceil(p × N) - 1`. Public-method time is not pure PostgreSQL execution time and
is not HTTP latency.

## Controlled write overlap

After seeding, the benchmark performs 50 update cycles over
`min(100, HISTORY_QUERY_REFS)` references. It reports normal committed pooled
`recordCycle` seed cost separately from the nested `recordCycle` savepoint cost
and outer commit cost.

For each overlap sample, nested `recordCycle` runs inside an explicit outer
transaction. The harness verifies that the writer is pending before and after
all read shapes use another connection, then commits and awaits settlement in
`finally`. It reports writer failures and attempts cleanup of both owned pools
when a step fails. Current-etag maps are checked after the writer ends.

Each shape has 50 overlap samples. The deliberate barrier dwell is outside the
write timers. This is a read phase with an uncommitted writer held open, followed
by a commit; it is not simultaneous active `INSERT` and `SELECT`, a throughput
test, a saturation test, or a load test.

## Time limits and cleanup

The fixture pool uses a 30-second SQL statement cap, a 35-second acquisition
cap, and 12 connections. The plugin read limit is 10 seconds per SQL statement;
that differs from the baseline diagnostic's zero read limit. The watchdog and
test deadline do not show that an abandoned query is cancelled or define an
application service-level objective.

The fixture shuts down the store, verifies that the owned pool and PostgreSQL
are idle, and destroys both owned pools. A `result: pass` record is written only
after that cleanup returns. `TestDatabases` still releases the SDK container in
Jest `afterAll`, after the fixture's final result record.

## Completed runs

All four final runs passed 37 tests with a passing final result, successful
fixture cleanup, 50 writer barriers, and 1,000 read samples per run (10 shapes ×
50 samples × 2 phases). The root review parsed each artifact's quantiles,
cleanup records, current-etag counts, and final row counts. No run reported a
SQL timeout or a method, validation, writer, or cleanup failure.

| Case          | Seed rows | Final rows | Artifact run ID                        |
| ------------- | --------: | ---------: | -------------------------------------- |
| Standard 10k  |    10,000 |     15,000 | `fb451f75-ca29-4b9b-8d3e-e4780796e14d` |
| Standard 100k |   100,000 |    105,000 | `3db82c64-b4d4-418d-af21-0004ce4b1187` |
| Standard 200k |   200,000 |    205,000 | `37012ca0-7374-472a-b9ec-b18743d778c1` |
| Heavy 10k     |    10,000 |     15,000 | `8ed19a0f-46c0-4aee-867b-77d8dc0f66a4` |

Artifacts are local, ignored files at
`.tmp/history-queries/<run ID>/report.jsonl`; they are not checked in. Each run
used source SHA `e063c30bff32724b043fab2e348742c4b3c71471` with a dirty workspace
because the benchmark files were uncommitted.

### Quiescent reads

All values are milliseconds, shown as p50 / p95 from 50 samples. `latest` reads
scan the current state for the stated scope; they are not paged.

| Shape                    |  Standard 10k |   Standard 100k |     Standard 200k |
| ------------------------ | ------------: | --------------: | ----------------: |
| `timeline.first`         |   5.26 / 7.56 |   32.73 / 36.48 |      2.41 / 70.74 |
| `timeline.cursor`        |   4.78 / 6.39 |   29.32 / 39.16 |      1.86 / 48.05 |
| `versions.first`         |   4.23 / 6.78 |   32.50 / 39.67 |      1.70 / 75.12 |
| `versions.cursor`        |   4.12 / 6.96 |   35.65 / 40.42 |      1.67 / 75.82 |
| `detail.known-update`    |   4.31 / 5.90 |   35.58 / 39.88 |      1.83 / 73.58 |
| `feed.unfiltered.first`  |   2.45 / 4.16 |     3.16 / 4.35 |       1.54 / 4.53 |
| `feed.unfiltered.cursor` |   2.48 / 6.75 |     3.21 / 4.94 |       1.62 / 5.11 |
| `feed.filtered-entity`   |   4.01 / 5.90 |    7.38 / 10.93 |      1.57 / 65.42 |
| `latest.provider/source` | 37.75 / 40.66 | 357.83 / 365.05 | 979.83 / 1,006.57 |
| `latest.all/source`      | 40.13 / 44.38 | 356.10 / 363.42 |   961.48 / 987.66 |

### Reads with an uncommitted writer

The read phase overlaps a held, uncommitted writer transaction. Values are
milliseconds, p50 / p95 from 50 samples.

| Shape                    |  Standard 10k |   Standard 100k |       Standard 200k |
| ------------------------ | ------------: | --------------: | ------------------: |
| `latest.provider/source` | 44.85 / 51.96 | 362.31 / 379.87 |   999.91 / 1,041.07 |
| `latest.all/source`      | 46.35 / 55.89 | 357.65 / 373.99 | 1,048.09 / 1,083.94 |

For the other eight 200k overlap shapes, p50 ranged from 1.51 to 1.85 ms and
p95 ranged from 2.27 to 3.25 ms.
Several later overlap entity-tail samples were faster than earlier quiescent
samples. Ordered phases, cache state, and background activity were not
controlled; no query plans were captured, so these data do not identify a cause
or show that writes improve throughput.

### Seeding and relation size

Seed timings are normal committed public `recordCycle` calls. They include normal
transaction control and commit but exclude fixture generation and mapping. The
cases use different rows per cycle, so their timings are not a single-operation
throughput comparison.

| Case          | Cycles × rows/cycle |  p50 / p95 (ms) |
| ------------- | ------------------: | --------------: |
| Standard 10k  |          10 × 1,000 |   32.39 / 60.78 |
| Standard 100k |         100 × 1,000 |   33.56 / 37.93 |
| Standard 200k |         10 × 20,000 | 642.00 / 659.49 |
| Heavy 10k     |          10 × 1,000 | 149.86 / 168.36 |

The 50 controlled writes use 100 rows each. Their savepoint and outer-commit
metrics are separate in the artifacts. Those timings exclude intentional barrier
dwell and are not normal committed-write acknowledgements.

The following `catalog_history_entities` sizes were captured after the writer
phase. MiB values use 1,048,576 bytes. PostgreSQL's total includes heap, index,
and TOAST storage; do not add the columns together. TOAST total includes its
indexes.

|    Final rows |                      Total |                    Index |                TOAST total |
| ------------: | -------------------------: | -----------------------: | -------------------------: |
|  Standard 15k |   28,581,888 B (27.26 MiB) |   3,973,120 B (3.79 MiB) |         8,192 B (0.01 MiB) |
| Standard 105k | 197,156,864 B (188.02 MiB) | 25,042,944 B (23.88 MiB) |         8,192 B (0.01 MiB) |
| Standard 205k | 385,777,664 B (367.91 MiB) | 49,774,592 B (47.47 MiB) |         8,192 B (0.01 MiB) |
|     Heavy 15k | 150,495,232 B (143.52 MiB) |   3,989,504 B (3.80 MiB) | 140,009,472 B (133.52 MiB) |

## Environment and limits

The four runs used workspace package version 0.2.0, not a published 0.2.0 benchmark
package; `@backstage/backend-test-utils` 1.11.8; Knex 3.2.10; `pg` 8.23.0; and
Node 24.22.1. The recorded host was macOS on arm64 with an Apple M4 Max, 14 host
CPUs, and 38,654,705,664 bytes of host memory (about 36 GiB). Container CPU and
memory quotas were unknown.

PostgreSQL was 16.15 with `shared_buffers = 128MiB`, `work_mem = 4MiB`, and
`synchronous_commit = on`. These local conditions do not represent production
container resources or cold operating-system cache behavior.

The current index baseline is the only layout measured here. Follow-up benchmark
work should measure current-state query and index shapes, including read benefit
against write and storage cost, before any migration decision. These runs do not
set a target service level or show production-scale behavior.

The [latest-state index benchmark](benchmark-latest-indexes.md) records the
isolated PostgreSQL 16 comparison and its decision to defer a migration.

## Read the artifact

Each artifact includes environment and package versions, source SHA and dirty
state, options, expected and actual row and cycle counts, current-etag-map
checks, payload-size bounds, raw duration samples, quantiles, write metrics,
relation sizes, and cleanup observations. It records missing host or container
data as unknown. It omits SQL bindings, fixture payloads, raw errors, database
URLs, SQL text, connection data, and process IDs; failure records include only a
safe error type.

For the separate backend-and-provider measurement, see the
[catalog history baseline diagnostic](benchmark-baseline.md). It has different
scope and historical results.
