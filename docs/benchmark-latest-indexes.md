# Latest-state index benchmark

> The benchmark source and its `bench:latest-*` scripts were removed after
> these decisions. To rerun it, check out commit `850b66e`.

This benchmark compared fixture-only index layouts for the history store's
current-state reads in an owned PostgreSQL 16 Docker database. It calls public
store methods; it does not start a catalog backend, make HTTP calls, or change
production schema.

## Decision

Do not ship a covering-index migration. The public store accepts an opaque
5,000-byte etag, but PostgreSQL rejected construction of the covering index with
SQLSTATE `54000`. The existing index layout accepted that write and exact
read in the fixture. Speed does not justify silently truncating or casting etags, or adding a
new length restriction to public input.

Do not recommend the ordering-only index with the current query either. At
100,000 and 200,000 rows, the planner never chose it in this workload. The
benchmark did not force planner settings or change the query to make it appear
useful.

Keep the current indexes and query unchanged. The [latest-state query candidate
benchmark](benchmark-latest-query.md) reports mixed follow-up results: only its
unscoped ordering-index case improved, while scoped cases regressed.

## Run the benchmark

Docker is required. The harness rejects the presence of
`BACKSTAGE_TEST_DATABASE_POSTGRES16_CONNECTION_STRING`, including an empty
value, before it calls `TestDatabases.create`. It does not use an external
database or change host, global, role, or authentication settings.

```sh
env CI=1 \
  yarn workspace @kunickiaj/backstage-plugin-catalog-backend-module-history bench:latest-indexes
```

The default case has 1,000 references and 100 revisions per reference
(100,000 seed rows). Use 20,000 references and 10 revisions for the wider case:

```sh
env CI=1 HISTORY_INDEX_REFS=20000 HISTORY_INDEX_REVISIONS=10 \
  yarn workspace @kunickiaj/backstage-plugin-catalog-backend-module-history bench:latest-indexes
```

| Variable                  |  Default | Allowed values                        | Purpose                 |
| ------------------------- | -------: | ------------------------------------- | ----------------------- |
| `HISTORY_INDEX_REFS`      |    1,000 | 1–20,000                              | Entity references       |
| `HISTORY_INDEX_REVISIONS` |      100 | 4–100                                 | Revisions per reference |
| `HISTORY_INDEX_VARIANTS`  | all five | Unique comma-separated known variants | Restrict layouts to run |

`HISTORY_INDEX_VARIANTS` accepts `baseline`, `global`, `scoped`, `combined`, and
`ordered`; unknown or duplicate names are rejected. For example, rerun only the
ordering-only layout without repeating the completed covering-index layouts:

```sh
env CI=1 HISTORY_INDEX_VARIANTS=ordered \
  yarn workspace @kunickiaj/backstage-plugin-catalog-backend-module-history bench:latest-indexes
```

The product must not exceed 200,000 seed rows. Each fixture row has the
standard 1,190-byte metadata-plus-spec payload. Revisions use distinct versions
and round-robin across four provider/source combinations, so neither provider
nor source is homogeneous. Seeding writes every reference once per revision.
The write-cost phase updates the first `min(100, refs)` references in each of
30 cycles; the total reference count does not change.

## Query contract

The benchmark measures the public latest-state methods for four scopes:

- provider only;
- provider and source;
- all providers for one source; and
- all providers and sources.

For each scope, the public method must select the narrow projection used for
the current-etag map and choose one row per `entity_ref` with:

```sql
DISTINCT ON (entity_ref)
ORDER BY entity_ref ASC, changed_at DESC, id DESC
```

Provider and source predicates belong inside the latest-row query. The delete
operation filter runs after the latest row is chosen. JavaScript skips a null
etag after query results return; it must not fall back to an older state. The
winning provider is retained in the result.

The harness explains the exact bound SQL issued by each public method. It stores
only a normalized fingerprint and compares that fingerprint with the public
query's captured statement; it does not publish SQL text or bindings. This check
prevents a plan for a similar query from standing in for the public method.

A small semantic fixture independently checks scope, timestamp/id ties, delete
filtering, and null-etag behavior. It inserts one null non-delete row through
SQL only for that compatibility case; such a row is outside the public typed-row
contract and is not used for normal seeding.

## Index layouts

Each layout uses a fresh logical database and keeps every pre-existing index.
The global feed index `(changed_at DESC, id DESC)` already exists. The existing
ascending `(entity_ref, changed_at)` index does not match the mixed ascending and
descending ordering and lacks the `id DESC` tie-breaker.

The fixture creates only `bench_latest_*` indexes. These names and DDL are not a
production migration.

| Variant    | Additional fixture indexes                                                                                                                                              |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `baseline` | None                                                                                                                                                                    |
| `global`   | `(entity_ref ASC, changed_at DESC, id DESC) INCLUDE (provider, source, op, etag)`                                                                                       |
| `scoped`   | `(provider, source, entity_ref ASC, changed_at DESC, id DESC) INCLUDE (op, etag)` and `(source, entity_ref ASC, changed_at DESC, id DESC) INCLUDE (provider, op, etag)` |
| `combined` | All indexes from `global` and `scoped`; not `ordered`                                                                                                                   |
| `ordered`  | `(entity_ref ASC, changed_at DESC, id DESC)`                                                                                                                            |

`INCLUDE` columns do not change index ordering. The scoped indexes can support
their corresponding equality-constrained scopes, but their leading provider or
source keys cannot provide the unscoped `entity_ref` order. A covering index can
still require heap fetches when a page is not all-visible, especially after
writes.

## Measurement protocol

For every variant, scope, and phase, the harness excludes five warmups and keeps
30 successful samples. It reports nearest-rank p50 and p95 from raw samples:
`ceil(p × N) - 1`.

1. Seed and build the candidate indexes with ordinary blocking, non-concurrent
   `CREATE INDEX` in the owned fixture.
2. Record populated index build duration, index size, index definitions, and
   validity.
3. Run `VACUUM (ANALYZE)` equally for every variant, then measure the settled
   read phase.
4. Run 30 normal committed `recordCycle` write probes over
   `min(100, HISTORY_INDEX_REFS)` references. These probes add 3,000 rows in the
   default case and measure candidate write cost after indexes exist; seed timing
   is not used as index-maintenance timing.
5. Without a manual vacuum, measure a fresh-write read phase and record whether
   autovacuum or automatic statistics maintenance occurred.

Public-method latency includes store mapping. `EXPLAIN (ANALYZE, BUFFERS, FORMAT
JSON)` execution time is recorded separately. Sanitized plan records include
allowed plan-node and index names, actual rows and loops, buffers, temporary
spill indicators, sort indicators, and heap fetches before and after fresh
writes. They exclude SQL, bindings, `Index Cond`, `Filter`, and raw plans that
could contain literals.

The protocol records PostgreSQL settings and cache/statistics controls instead
of claiming a cold operating-system cache or a production workload. Its fixed
phase order is for comparable fixture measurements, not a service-level target.

## Completed comparisons

The completed 100,000- and 200,000-row comparisons passed their test suites,
map/count checks, and fixture cleanup. The first four variants and `ordered`
ran separately, so the five-column tables below combine comparable runs rather
than reporting one five-variant large-data command. A final five-variant smoke
run used 100 references × 10 revisions and includes the width probe.

| Run                                | Artifact ID                            | Fixture outcome                                             |
| ---------------------------------- | -------------------------------------- | ----------------------------------------------------------- |
| 100k, first four variants          | `0e402aac-a06e-4cbe-9584-4c2b845dc91d` | 29 tests; 103,000 final rows, 130 cycles/variant, 960 reads |
| 200k, first four variants          | `f06a7ac7-ebdd-4e1a-9db5-0e3da41aaa92` | 29 tests; 203,000 final rows, 40 cycles/variant, 960 reads  |
| 100k, `ordered`                    | `90784375-fba1-4b20-b75f-d2597b31cfb1` | 36 tests; 240 reads                                         |
| 200k, `ordered`                    | `e681e2ed-afca-47ae-9676-e0315774562c` | 36 tests; 240 reads                                         |
| Five-variant smoke and width probe | `53ab0494-7914-422b-b38d-84ec1e80a0ab` | 36 tests; 4,000 final rows, 40 cycles/variant, 1,200 reads  |

All runs used source SHA `7ea2073ebc879beee9b97cef25dc6c2295c75af0`
with uncommitted benchmark work, workspace version 0.2.0 rather than a
published evaluation package, Node 24.22.1, PostgreSQL 16.15, and the settings
shown below. They are local fixture measurements, not production capacity data.

| Setting    | Value                                                                                  |
| ---------- | -------------------------------------------------------------------------------------- |
| Host       | macOS arm64, Apple M4 Max, 14 CPUs, about 36 GiB memory; container quotas unknown      |
| Packages   | `@backstage/backend-test-utils` 1.11.8, Knex 3.2.10, `pg` 8.23.0                       |
| PostgreSQL | `shared_buffers = 128MiB`, `work_mem = 4MiB`, `synchronous_commit = on`, autovacuum on |
| Harness    | 30-second session SQL cap, 35-second acquire cap, 12 connections                       |

Latest-state methods have no plugin read deadline, unlike four other store APIs
whose constructor enables a 10-second read feature. Each variant used
`VACUUM (ANALYZE)`, then 30 normal committed 100-row writes, then the fresh-write
phase without a manual vacuum. The artifact records background autovacuum and
statistics activity. Scope and variant order were fixed; cache state was warm,
not a cold operating-system cache.

### 200,000-row public-method reads

Values are milliseconds, p50 / p95 from 30 samples after five excluded warmups.
They are public-method latency, not pure PostgreSQL execution time.

| Phase and scope            |            Baseline |        Global |          Scoped |      Combined |             Ordered |
| -------------------------- | ------------------: | ------------: | --------------: | ------------: | ------------------: |
| Settled: provider only     |     585.30 / 600.83 | 27.67 / 30.08 | 155.68 / 163.26 | 26.56 / 27.66 |     570.55 / 579.70 |
| Settled: provider + source |     167.19 / 176.05 | 27.85 / 30.07 |   18.36 / 20.00 | 17.47 / 18.73 |     203.74 / 211.39 |
| Settled: all / source      |     528.66 / 538.27 | 27.90 / 30.07 |   21.95 / 22.84 | 21.91 / 22.91 |     524.08 / 536.43 |
| Settled: all               |     934.32 / 962.76 | 27.05 / 33.16 | 291.25 / 296.66 | 25.82 / 26.81 | 1,001.15 / 1,027.97 |
| Fresh: provider only       |     591.10 / 602.62 | 30.67 / 47.66 | 165.01 / 169.09 | 27.52 / 28.68 |     568.43 / 583.85 |
| Fresh: provider + source   |     166.83 / 174.25 | 30.97 / 36.93 |   18.29 / 19.88 | 17.70 / 18.66 |     202.41 / 209.75 |
| Fresh: all / source        |     537.80 / 560.59 | 30.85 / 34.83 |   22.11 / 23.46 | 21.94 / 23.11 |     531.86 / 544.30 |
| Fresh: all                 | 1,000.97 / 1,037.28 | 30.94 / 38.18 | 337.13 / 343.02 | 26.68 / 28.63 |     949.02 / 978.78 |

For the unscoped 100,000-row read, settled to fresh p50 / p95 was: baseline
349.16 / 358.83 to 357.02 / 364.94; global 7.30 / 7.65 to 8.20 / 8.77; scoped
96.60 / 99.29 to 113.80 / 117.61; combined 7.20 / 8.55 to 7.99 / 8.51; and
ordered 339.82 / 348.79 to 351.70 / 357.23.

### Plans and write/storage observations

At 200,000 rows, the baseline all-scope query used a sequential scan, external
merge sort, and `Unique`; sort space was 31,728 kB before writes and 32,208 kB
after writes. It read/wrote 3,966/3,975 temporary blocks before writes and
4,026/4,035 after. The global all-scope plan used
`Index Only Scan` on `bench_latest_global` followed by `Unique`, with no sort or
temporary blocks. Heap fetches were zero after `VACUUM (ANALYZE)` and 3,000 after
the 3,000 writes.

The scoped pair covered provider-and-source and source-only scopes, but retained
the external sort for provider-only and all scopes because of its leading keys.
Combined selected the applicable global or scoped index without a sort. The
planner chose no ordering-only index in any scope or phase at 100,000 or 200,000
rows.

| 200k layout | Added bytes: build → after writes |                    Build time | Committed write p50 / p95 (ms) |
| ----------- | --------------------------------: | ----------------------------: | -----------------------------: |
| Baseline    |                             0 → 0 |                             — |                    5.93 / 7.95 |
| Global      |           39,485,440 → 40,124,416 |                   1,631.00 ms |                    6.81 / 7.42 |
| Scoped      |           80,158,720 → 81,723,392 |          1,843.81 + 667.72 ms |                   8.40 / 10.42 |
| Combined    |         119,644,160 → 121,847,808 | 1,644.29 + 740.89 + 703.19 ms |                    6.96 / 7.65 |
| Ordered     |           17,293,312 → 17,661,952 |                     580.52 ms |                    6.29 / 8.28 |

These are observed fixture costs, not stable percentage overheads or production
build/lock timing. At 200,000 rows, the combined layout added about 80 MB more
than global and made scoped reads about 10 ms faster, but it has the same etag
width risk.

### Etag-width compatibility probe

The final smoke artifact records a passing `index-width-compatibility-probe`:

| Field                                | Result                                |
| ------------------------------------ | ------------------------------------- |
| Etag input                           | 5,000 ASCII bytes                     |
| Baseline public write and exact read | Passed                                |
| Ordering-only build                  | Succeeded                             |
| Covering build                       | Failed with `54000` (`DatabaseError`) |
| Rows / cycles                        | 1 / 1                                 |

The probe identifies a compatibility risk, not a universal etag limit. Other
key-width inputs were not exhausted. It also confirms that the fixture remains
readable and cleans up after the rejected build.

The harness asserted matching normalized public SQL fingerprints and bindings
for 64 plans from the first four layouts and 16 from `ordered`; all assertions
passed. Plan records contain only allowlisted numeric data, node names, and
index names, not query text, predicates, or bindings. Separate index records
include the fixture DDL and installed index definitions.

Artifacts are local ignored files at
`.tmp/latest-state-indexes/<UUID>/report.jsonl`. They record runtime versions,
source SHA and dirty state, PostgreSQL settings, index definitions and sizes,
raw samples and quantiles, sanitized plans, map and count checks, and cleanup.
On a callback failure, the fixture destroys both owned pools and settles writes
before preserving the original failure. A passing final record is written only
after cleanup; SDK container release occurs later in `afterAll`.

## Migration decision limits

Fixture build duration measures a regular blocking index build, not a deployment
procedure. The current `ensureSchema` path wraps migrations in an outer
transaction, so `CREATE INDEX CONCURRENTLY` would need migration architecture
changes before it could be used. An index design must pass the width-compatibility
gate before upgrade locking, disk and write space, and deployment behavior can
be evaluated for a migration.

BRIN on `changed_at` is not in this matrix: these reads have no time predicate,
so it cannot narrow all-history latest-state rows or provide the required B-tree
order. Time partitioning likewise cannot prune old history without a
`changed_at` predicate. Revisit either option if a time-bounded workload becomes
part of the supported query shape.

PostgreSQL 16 documentation describes the relevant behavior for
[index-only scans](https://www.postgresql.org/docs/16/indexes-index-only-scans.html),
[multicolumn indexes](https://www.postgresql.org/docs/16/indexes-multicolumn.html),
[ordered B-tree scans](https://www.postgresql.org/docs/16/indexes-ordering.html),
[`DISTINCT ON`](https://www.postgresql.org/docs/16/sql-select.html), and
[`EXPLAIN`](https://www.postgresql.org/docs/16/sql-explain.html). It does not
predict this fixture's chosen plans or timings.
