# Latest-state query candidate benchmark

This fixture-only benchmark compares the current public history-store method
with an executor-harness candidate in an owned PostgreSQL 16 Docker database.
Public store methods and migrations are unchanged; index variants exist only
in the fixture. No catalog backend runs in this benchmark.

## Decision

Do not replace the public query or add a production index migration. The
late-join candidate with the ordering-only index wins only for unscoped reads.
It regresses scoped reads, especially source-only reads. The candidate on the
existing indexes has no general benefit.

Keep the production methods and indexes unchanged. A narrower scope-aware query
candidate using existing indexes is planned but has not been measured. It is not
a migration proposal.

## Candidate query

The candidate selects the latest row IDs before reading payload columns:

```sql
WITH latest AS (
  SELECT DISTINCT ON (entity_ref) id
  FROM catalog_history_entities
  -- provider and source predicates are applied here when applicable
  ORDER BY entity_ref ASC, changed_at DESC, id DESC
)
SELECT e.entity_ref, e.etag, e.provider
FROM catalog_history_entities AS e
JOIN latest ON e.id = latest.id
WHERE e.op != 'delete';
```

For scopes that do not return providers, the executor uses the matching narrow
projection. Provider and source predicates stay in the `latest` CTE. The
delete filter runs after latest-row selection, and JavaScript skips a `null` or
`undefined` etag after that selection. It must not replace it with an older
row.

This is one SQL statement, so the ID selection and payload lookup share a
database snapshot. The candidate does not use two calls, `MAX(id)`, an early
delete filter, late scope filtering, truncated etags, a new etag length limit,
or a new state table.

The ordering expression and `entity_ref` grouping match the current query.
That preserves the database collation behavior for the expression, but
collation equivalence beyond the fixture data has not been tested.

## What is compared

The benchmark has two distinct query modes:

| Mode                  | Timed operation                                              | Interpretation                                           |
| --------------------- | ------------------------------------------------------------ | -------------------------------------------------------- |
| `public`              | Current public latest-state method, including map conversion | Current API behavior                                     |
| `late-join-candidate` | Executor-harness candidate SQL and map conversion            | Candidate-only measurement; not released API performance |

Each mode is checked against an independent oracle before timings are kept.
The semantic fixtures cover provenance, provider/source scopes, timestamp and
ID ties, deletes, reinserts, and null etags. The width probe writes and reads a
valid opaque 5,000-byte etag through the baseline before and after both index
attempts. It expects the covering-index attempt to fail with the prior width
error.

The public and candidate paths must produce the same expected map and count for
every transition. A candidate does not pass because it resembles the current
SQL or because an `EXPLAIN` plan looks favorable.

## Index matrix

`bench:latest-query` runs these three cases:

| Case                 | Query mode            | Timed index layout                                                          |
| -------------------- | --------------------- | --------------------------------------------------------------------------- |
| `baseline`           | `public`              | Current installed indexes; no additional candidate DDL                      |
| `late-join-existing` | `late-join-candidate` | Current installed indexes; no additional candidate DDL                      |
| `late-join-ordered`  | `late-join-candidate` | Current installed indexes plus `(entity_ref ASC, changed_at DESC, id DESC)` |

The ordering-only candidate has no `INCLUDE` columns. It adds a `bigint` ID to
each index entry, which can create an index tuple-width risk for near-limit
`entity_ref` values even when the 5,000-byte etag probe passes. This protocol
does not claim that the index accepts every supported input. The query-only
candidate adds no index-entry width constraint.

`bench:latest-query` forces this matrix; inherited `HISTORY_INDEX_VARIANTS`
does not override it. `bench:latest-indexes` retains five historical defaults;
use it with `HISTORY_INDEX_VARIANTS=late-join-ordered` for a custom subset.

## Run the benchmark

Docker is required. Before `TestDatabases.create`, the harness rejects the
presence of `BACKSTAGE_TEST_DATABASE_POSTGRES16_CONNECTION_STRING`, including
an empty value. It creates an owned PostgreSQL 16 fixture and does not use an
external database or change host configuration.

Run the small case first:

```sh
env CI=1 HISTORY_INDEX_REFS=100 HISTORY_INDEX_REVISIONS=10 yarn workspace @kunickiaj/backstage-plugin-catalog-backend-module-history bench:latest-query
```

The default is 1,000 references by 100 revisions (100,000 seed rows). The
wider case is 20,000 references by 10 revisions (200,000 seed rows):

```sh
env CI=1 HISTORY_INDEX_REFS=20000 HISTORY_INDEX_REVISIONS=10 yarn workspace @kunickiaj/backstage-plugin-catalog-backend-module-history bench:latest-query
```

| Variable                  | Default | Allowed values |
| ------------------------- | ------: | -------------- |
| `HISTORY_INDEX_REFS`      |   1,000 | 1–20,000       |
| `HISTORY_INDEX_REVISIONS` |     100 | 4–100          |

The product must not exceed 200,000. Rows use a 1,190-byte payload and rotate
across four provider/source combinations; the fixture uses neither catalog tests
nor HTTP.

## Measurement protocol

For every case, scope, and phase, exclude five warmups and retain 30 successful
samples. Report nearest-rank p50 and p95 from the raw samples with
`ceil(p × N) - 1`.

1. Seed the fixture and run the semantic and etag-width checks.
2. Build the ordering-only index where selected. Record build duration, index
   definition, validity, size, and a build failure when it occurs.
3. Run `VACUUM (ANALYZE)` for each case, then measure settled reads.
4. Run 30 committed write probes, each updating 100 references or all available
   references when fewer than 100 exist. Record write cost and added index size.
5. Without a manual vacuum, measure fresh-write reads and record observed
   automatic statistics or autovacuum activity.

## Artifact requirements

Write an ignored artifact at:

```text
.tmp/latest-state-indexes/<UUID>/report.jsonl
```

Measurement records identify `queryMode`. Plan records use
`matchedPublicSqlAndBindings: true` for `public` and
`matchedExecutedSqlAndBindings: true` for `late-join-candidate`; they never
claim that candidate SQL matches the public query. The harness compares the
executed statement and bindings in memory and emits only a match flag and
statement fingerprint, not query text or binding values. Not every artifact
record has a match flag.

For `public`, label timing as public-method time by scope. For
`late-join-candidate`, label it as executor-harness SQL plus map conversion.
Never label candidate timing as public API performance.

Record partial negative cases and failures with a safe `errorType`; do not drop
them from the report. On any failure, attempt to destroy every owned pool. Write
a final pass only after fixture cleanup succeeds; the SDK container can be
released later by `afterAll`.

## Completed runs

All three profiles passed 45 tests. An independent artifact parse recomputed
quantiles from raw samples and checked 720 reads, 90 writes, and 24 plans per
profile across three variants, 30 samples, four scopes, and two phases. Every
variant finished with the expected maps, row and cycle counts, semantic checks,
5,000-byte opaque-etag checks, and fixture cleanup.

| Profile | Artifact ID                            | Seed / final rows     | Final cycles per variant |
| ------- | -------------------------------------- | --------------------- | -----------------------: |
| Smoke   | `98ba4938-8f57-4ac6-bd76-f98dc9f9b444` | 100 × 10 / 4,000      |                       40 |
| 100k    | `520b05e6-c4ce-403a-b22f-f032bde2b464` | 1,000 × 100 / 103,000 |                      130 |
| 200k    | `b3c6af4c-0489-4604-aaed-beb63d7aa0cf` | 20,000 × 10 / 203,000 |                       40 |

Artifacts are ignored local files at
`.tmp/latest-state-indexes/<artifact-id>/report.jsonl`. These runs used source
`fee3d6b` plus dirty benchmark work, workspace version 0.2.0 rather than a
published evaluation package.

### Read timings

Values are milliseconds, p50 / p95 from 30 samples after five warmups. The
baseline column is the public method. Both late-join columns are executor SQL
plus map conversion, not released API performance.

| 100k phase and scope       | Public baseline | Late join, existing | Late join, ordered |
| -------------------------- | --------------: | ------------------: | -----------------: |
| Settled: provider only     | 177.14 / 187.93 |     185.90 / 190.76 |    196.66 / 200.36 |
| Settled: provider + source | 103.33 / 110.36 |     100.54 / 102.31 |     99.81 / 102.07 |
| Settled: all / source      |   82.32 / 86.88 |     189.07 / 194.16 |    188.65 / 193.19 |
| Settled: all               | 336.25 / 344.65 |     356.49 / 360.01 |        6.52 / 6.77 |
| Fresh: provider only       | 185.06 / 191.97 |     191.69 / 199.98 |    201.66 / 207.10 |
| Fresh: provider + source   | 107.44 / 110.20 |     103.44 / 105.85 |    103.03 / 105.59 |
| Fresh: all / source        |   83.39 / 88.31 |     194.15 / 202.97 |    193.60 / 196.18 |
| Fresh: all                 | 344.59 / 353.27 |     373.28 / 384.40 |        7.28 / 7.86 |

| 200k phase and scope       |     Public baseline | Late join, existing | Late join, ordered |
| -------------------------- | ------------------: | ------------------: | -----------------: |
| Settled: provider only     |     571.88 / 602.08 |     691.52 / 699.74 |    690.88 / 701.32 |
| Settled: provider + source |     164.69 / 168.87 |     410.89 / 417.76 |    411.69 / 419.35 |
| Settled: all / source      |     535.16 / 547.42 |     614.57 / 622.71 |    614.26 / 625.75 |
| Settled: all               | 1,021.74 / 1,036.50 | 1,061.10 / 1,076.43 |      84.71 / 87.39 |
| Fresh: provider only       |     572.80 / 605.20 |     747.30 / 757.11 |    742.40 / 762.59 |
| Fresh: provider + source   |     165.19 / 170.42 |     415.27 / 428.98 |    415.18 / 430.04 |
| Fresh: all / source        |     519.62 / 552.24 |     654.74 / 671.22 |    656.05 / 675.11 |
| Fresh: all                 |   982.69 / 1,052.29 | 1,147.87 / 1,160.49 |      85.59 / 89.74 |

The ordering-only index improves only the unscoped shape. The source-only
regression is large at both sizes, and provider-scoped reads also regress. The
existing-index candidate is slower for the unscoped and source-only cases, so a
smaller sort alone is not a performance win.

### Plans

At 100k rows, the ordered unscoped candidate used `Index Only Scan` on
`bench_latest_ordered`, `Unique` for 1,000 IDs, then a nested loop with 1,000
primary-key lookups. It needed no sort. Heap fetches were zero after vacuum and
3,000 after fresh writes. Its separate `EXPLAIN` execution time was 5.761 ms
settled and 6.395 ms fresh; those values are not the method medians above.

For scoped candidate reads at 100k, PostgreSQL used a sequential scan and sort,
then 1,000 primary-key lookups. Provider-only and source-only each sorted
50,000 records with a 3,624 kB external sort. Provider-plus-source sorted
25,000 records in memory with quicksort using 2,917 kB. The public baseline
used a parallel `Gather Merge` for all/source.

At 200k rows, the ordered unscoped plan used `Index Only Scan` over 200,000
rows, `Unique` for 20,000 IDs, a 769 kB in-memory quicksort of result IDs, and
a merge join with a primary-key index scan over 200,000 rows. It was not 20,000
primary-key probes. `EXPLAIN` execution was 80.233 ms settled and 80.790 ms
fresh. After writes, the primary-key scan read 203,000 rows and the ordered
index had 3,000 heap fetches.

The 200k ordered unscoped plan did not spill temporary data. Provider and source
candidate plans retained external sorts and merge-join payload scans of up to
200,000 or 203,000 rows; the narrower sort could not pay for the join cost.
For comparison, the 200k baseline unscoped plan used an external merge sort of
31,728 kB and 3,966 / 3,975 temporary blocks settled, then 32,208 kB and
4,026 / 4,035 blocks fresh. The existing-index candidate still sorted 14,504 kB
and added a primary-key scan, which was slower overall.

### Index and write observations

Write values are milliseconds, p50 / p95 for 30 normal committed 100-row
`recordCycle` probes. Each ordering-index case used a separate fresh database
run, so the numbers do not show that writes are faster or define a percentage
overhead.

| Profile | Variant             | Write p50 / p95 |       Added index bytes | Build time |
| ------- | ------------------- | --------------: | ----------------------: | ---------: |
| 100k    | Baseline            |     7.01 / 8.93 |                       0 |          — |
| 100k    | Late join, existing |     7.89 / 9.75 |                       0 |          — |
| 100k    | Late join, ordered  |    6.71 / 10.38 |   8,658,944 → 9,486,336 |  329.49 ms |
| 200k    | Baseline            |     6.43 / 8.08 |                       0 |          — |
| 200k    | Late join, existing |     6.15 / 8.76 |                       0 |          — |
| 200k    | Late join, ordered  |     5.91 / 6.92 | 17,293,312 → 17,661,952 |  600.25 ms |

The ordering key has no `INCLUDE` payload columns. The valid 5,000-byte opaque
etag passed before and after both index attempts; the deliberately invalid
covering-index layout failed with SQLSTATE `54000`. That layout was not applied
to production. Adding the eight-byte ID key can still affect physical tuple
width for near-limit `entity_ref` values, which this probe did not test. The
query-only candidate adds no index-entry constraint, but its existing-index
measurements are slower for several scopes.

### Environment and scope

| Setting        | Value                                                                                  |
| -------------- | -------------------------------------------------------------------------------------- |
| Host           | macOS arm64, Apple M4 Max, 14 CPUs, about 36 GiB memory; container quotas unknown      |
| Runtime        | Node 24.22.1; PostgreSQL 16.15                                                         |
| Packages       | Knex 3.2.10; `pg` 8.23.0; `@backstage/backend-test-utils` 1.11.8                       |
| PostgreSQL     | `shared_buffers = 128MiB`, `work_mem = 4MiB`, `synchronous_commit = on`, autovacuum on |
| Fixture limits | 30-second SQL cap, 35-second acquire cap, 12 connections                               |

The public latest-state method has no plugin read limit. The candidate fixture
SQL cap is not a production feature. Fixed phase ordering, a warm cache, and
the host details above describe this fixture only; they do not describe
production I/O, operating-system cache state, capacity, or service objectives.
