# Latest-state lateral candidate benchmark

This fixture-only benchmark compares the current public history-store method
with scope-aware SQL candidates in an owned PostgreSQL 16 Docker database. It
measures store-level behavior only: no catalog backend, providers, processors,
HTTP, or network proxy runs.

## Decision

Do not replace the public query. The raw lateral candidate was fast at 100,000
rows but did not complete at 200,000 rows when statistics were absent. The
materialized candidate completes that case, but regresses filtered reads.

Keep the public method and current indexes. The materialized candidate is a
possible unscoped-only follow-up, subject to an adoption and compatibility
decision. This benchmark changes no production query, schema, index, migration,
input contract, or PostgreSQL version requirement.
The materialized SQL relies on `MATERIALIZED`, which requires PostgreSQL 12 or
newer. Only PostgreSQL 16 was tested. A future adoption decision must assess
supported PostgreSQL versions; this work does not raise a minimum version.

## Materialized candidate query

The benchmarked candidate enumerates distinct references within the requested
provider/source scope. For each reference, it materializes that reference's
history, applies scope predicates, then chooses the latest row:

```sql
SELECT recent.entity_ref, recent.etag, recent.provider
FROM (
  SELECT DISTINCT entity_ref
  FROM catalog_history_entities
  -- provider/source predicates for this scope
) AS refs
CROSS JOIN LATERAL (
  WITH ref_history AS MATERIALIZED (
    SELECT entity_ref, etag, provider, source, op, changed_at, id
    FROM catalog_history_entities
    WHERE entity_ref = refs.entity_ref
  )
  SELECT entity_ref, etag, provider, op
  FROM ref_history
  -- provider/source predicates for this scope
  ORDER BY changed_at DESC, id DESC
  LIMIT 1
) AS recent
WHERE recent.op != 'delete';
```

The actual SQL uses the narrow projection required by each scope. It returns
`recent.entity_ref`, not the enumerated reference, preserving the winning row
under ordinary database equality and collation behavior.

This is one SQL statement, so enumeration and lookup share one database
snapshot. It is not an application loop or a round trip per entity. An older row
with a higher ID does not win.

A delete row is filtered after it wins, and JavaScript skips a null or undefined
etag after selection. Neither case may resurrect an older history row.

The candidate adds no index, payload column, key, or input-length restriction.
It uses the existing `(entity_ref ASC, changed_at ASC)` index. The materialized
reference-only read avoids the raw candidate's provider bitmap-and plan, but it
reads the whole reference history across scopes before filtering.

Do not assume an incremental sort, constant rows per reference, or that lateral
lookup count equals the number of rows PostgreSQL inspects.

### Raw lateral comparison

The exploratory `lateral-existing` mode enumerates references and applies
provider/source predicates directly in every parameterized scan. It has the
same selection semantics but was plan-sensitive when statistics were missing.
Raw mode is not in the normal preset. It remains available only for manual
reproduction through `bench:latest-indexes`.

## Modes and index layouts

`bench:latest-lateral` forces exactly these fixture cases:

| Case                            | Query mode                       | Timed index layout        |
| ------------------------------- | -------------------------------- | ------------------------- |
| `baseline`                      | `public`                         | Current installed indexes |
| `lateral-materialized-existing` | `lateral-materialized-candidate` | Current installed indexes |

Run the normal paired matrix with:

```sh
env CI=1 \
  yarn workspace @kunickiaj/backstage-plugin-catalog-backend-module-history bench:latest-lateral
```

Reproduce raw mode manually, including its known 200,000-row non-pass risk:

```sh
env CI=1 HISTORY_INDEX_REFS=20000 HISTORY_INDEX_REVISIONS=10 HISTORY_INDEX_VARIANTS=lateral-existing \
  yarn workspace @kunickiaj/backstage-plugin-catalog-backend-module-history bench:latest-indexes
```

`bench:latest-query`, the older five-variant default, and existing late-join
presets retain their prior selections and defaults.

`baseline` includes pool work, SQL, and map conversion.
`lateral-materialized-candidate` is harness SQL plus map conversion. Both exclude
harness assertions, hashing, and artifact writes. Candidate timing is not public
API performance.

The new preset's timing and semantic databases include only the existing index inventory.
The harness bootstraps normal history schema through `store.ensureReady`; normal
schema bootstrap still runs DDL. The preset runs no additional candidate-index
DDL, including its mini-semantic and timing databases.

## Fixture shape and limits

Every reference has fully overlapping history across four provider/source
combinations. This makes each requested scope meaningful, but may not match
production provider sparsity, cardinality, or time-history distributions.

| Variable                  | Default | Allowed values |
| ------------------------- | ------: | -------------- |
| `HISTORY_INDEX_REFS`      |   1,000 | 1–20,000       |
| `HISTORY_INDEX_REVISIONS` |     100 | 4–100          |

The references-by-revisions product must not exceed 200,000. Rows use the
standard 1,190-byte payload. The smoke case is 100 × 10, default 1,000 × 100,
and wider case 20,000 × 10.

```sh
# Smoke
env CI=1 HISTORY_INDEX_REFS=100 HISTORY_INDEX_REVISIONS=10 \
  yarn workspace @kunickiaj/backstage-plugin-catalog-backend-module-history bench:latest-lateral

# Wider; run only after the default case passes
env CI=1 HISTORY_INDEX_REFS=20000 HISTORY_INDEX_REVISIONS=10 \
  yarn workspace @kunickiaj/backstage-plugin-catalog-backend-module-history bench:latest-lateral
```

The opaque 5,000-byte probe uses existing indexes only and records exact public
and candidate maps. It makes no covering-index or index-width claim.

## Semantic and safety checks

An independent oracle checks public, late-join, raw lateral, and materialized
lateral modes for every transition. Large fixtures validate only the selected
candidate, so an unrelated raw timeout cannot contaminate a baseline run.

The semantic data covers:

- provider-only, provider-and-source, source-only, and unscoped reads;
- timestamp ties, older rows with higher IDs, and provider/source provenance;
- deletes, null etags, reinserts, and delete-only or null-only references;
- multiple active references and nonmatching provider scopes returning no rows;
- map entries compared independently of insertion order; and
- the winning row's reference and provenance.

Delete-only and null-only references are excluded after their winning row is
selected. The oracle rejects a candidate that substitutes a historical row. No
unusual-collation fixture exists, so this benchmark makes no stronger collation
claim than its ordinary fixture equality.

Before `TestDatabases.create`, the harness rejects the presence of
`BACKSTAGE_TEST_DATABASE_POSTGRES16_CONNECTION_STRING`, including an empty
value. It uses an owned Docker PostgreSQL 16 database and changes no user
database, global settings, roles, or authentication settings.

## Measurement protocol

Each case, scope, and phase excludes five warmups and retains 30 successful
samples. Raw samples produce nearest-rank p50 and p95 using `ceil(p × N) - 1`.

1. Seed the normal history schema and run semantic and opaque-etag checks.
2. Complete first-validation checks before maintenance.
3. Run `VACUUM (ANALYZE)` before timed samples.
4. Measure settled reads for all four provider/source scopes.
5. Run 30 normal committed writes of 100 references, or all available references
   when fewer than 100 exist.
6. Without another manual vacuum, measure fresh-write reads and record observed
   autovacuum or automatic statistics activity.

The fixture uses a 30-second SQL cap, 35-second acquire cap, 12 pooled
connections, and a 900-second test deadline. Latest-state methods have no plugin
read limit. The raw failure did not increase any deadline or force planner
settings, and no query was retried after diagnosis-only `ANALYZE`.

## Raw exploratory result and non-pass

The 100,000-row raw run passed 56 tests. Its artifact is
`7d5e0ad5-2781-4bfd-a696-ec3f18923288`.

| Scope             | Public vacuum p95 | Raw vacuum p95 | Public fresh p95 | Raw fresh p95 |
| ----------------- | ----------------: | -------------: | ---------------: | ------------: |
| Provider          |            184.95 |          29.53 |           192.05 |         30.37 |
| Provider + source |            107.62 |          32.46 |           111.32 |         33.33 |
| All / source      |             86.95 |          32.24 |            89.43 |         33.98 |
| All               |            345.79 |          11.87 |           356.66 |         12.91 |

Values are milliseconds, p95 from 30 samples after five warmups. They are raw
candidate evidence, not an adoption result.

The 200,000-row raw run did not pass. Artifact
`ba7c6bd2-708e-4be9-9c1c-297b440ee018` failed during a pre-maintenance
correctness check. Its diagnostic reproduction,
`e5327ccf-ea3c-4881-b34f-8fd0d2f1c2fd`, had 61 pure checks pass and one
benchmark failure.

The contamination bug was that an unselected candidate was cross-validated
during a public baseline variant. It is fixed by selected-candidate validation.
The public provider map and late-join map passed; raw provider lookup failed with
SQLSTATE `57014` after 30,009.52 ms.

At failure, PostgreSQL column statistics were absent, `reltuples` was `-1`, and
the analyze count was zero. The plan estimated 200 references but had 20,000.
For each lookup, it chose a provider/time and entity-ref/time `BitmapAnd` plus a
sort. These are estimated plans captured before execution, not runtime counters
for the work completed before cancellation.

After a diagnosis-only `ANALYZE` saw 200,000 rows and about 19,988 distinct
references, the estimated plan changed to a backward entity-reference scan plus
incremental sort. No query was rerun. The original error was rethrown, the result
stayed non-pass, and owned pools were destroyed and idle.

The earlier ordered-provider-index hypothesis was discarded. The retained
evidence points to the missing-statistics `BitmapAnd` plan; it does not quantify
work completed before cancellation.

## Completed materialized comparisons

All artifacts below are ignored local files at
`.tmp/latest-state-indexes/<ID>/report.jsonl`. They used source `09146c1` with
dirty uncommitted benchmark changes, workspace version 0.2.0, not a published
performance package.

| Run                                 | Artifact ID                            | Outcome                                        |
| ----------------------------------- | -------------------------------------- | ---------------------------------------------- |
| Smoke, 100 × 10                     | `ccc3eadf-7851-4899-b8c4-352884066ed9` | 75 tests; 4,000 rows; 40 cycles per variant    |
| Paired 100k, 1,000 × 100            | `c9ed59db-b7c2-4827-9ac3-6678d5ffc070` | 75 tests; 103,000 rows; 130 cycles per variant |
| Materialized-only 200k, 20,000 × 10 | `1fd3d6b9-e739-4d23-938e-7694efbcb6a3` | 75 tests; 203,000 rows; 40 cycles              |
| Full paired 200k, 20,000 × 10       | `9166eecb-f261-4cb7-b657-6d69cd012ceb` | 75 tests; 203,000 rows; 40 cycles per variant  |

The materialized-only 200,000-row candidate passed all four scopes before
maintenance with no statistics, `reltuples = -1`, and no bitmap-and plan. Do not
cross-compare its candidate measurements with a baseline from another run. Use
the full paired 200,000-row table below.

For each paired 100,000- and 200,000-row run, artifacts contain 480 reads,
60 writes, and 16 runtime plans: 30 samples, four scopes, and two phases. The
separate pre-statistics estimated plans are not runtime `EXPLAIN` records.

Root review independently recomputed quantiles from raw samples and checked
cleanup and result flags. Both variants recorded zero added-index bytes.

### 100,000-row paired reads

Values are milliseconds, p50 / p95 from 30 samples after five warmups. Public
values are public-method time; materialized values are harness SQL plus map
conversion.

| Phase and scope            |          Public |    Materialized |
| -------------------------- | --------------: | --------------: |
| Settled: provider          | 173.82 / 180.08 | 122.53 / 127.85 |
| Settled: provider + source | 100.67 / 103.83 | 126.92 / 130.95 |
| Settled: all / source      |   84.12 / 86.94 | 131.27 / 135.88 |
| Settled: all               | 326.85 / 335.44 |   78.42 / 79.81 |
| Fresh: provider            | 179.27 / 182.77 | 129.16 / 134.02 |
| Fresh: provider + source   | 104.03 / 106.17 | 133.59 / 140.02 |
| Fresh: all / source        |   84.63 / 87.23 | 138.15 / 152.20 |
| Fresh: all                 | 336.66 / 340.04 |   81.98 / 82.69 |

### 200,000-row full paired reads

Values use the same method and candidate timing boundaries as the 100,000-row
table. This is the paired result for the 200,000-row comparison.

| Phase and scope            |            Public |    Materialized |
| -------------------------- | ----------------: | --------------: |
| Settled: provider          |   558.95 / 573.65 | 497.05 / 505.38 |
| Settled: provider + source |   158.77 / 168.10 | 504.89 / 516.71 |
| Settled: all / source      |   513.74 / 523.38 | 519.23 / 535.42 |
| Settled: all               |  993.25 / 1013.74 | 313.78 / 319.45 |
| Fresh: provider            |   561.65 / 567.89 | 507.79 / 537.47 |
| Fresh: provider + source   |   163.33 / 170.93 | 511.91 / 552.86 |
| Fresh: all / source        |   527.38 / 538.27 | 528.20 / 553.06 |
| Fresh: all                 | 1027.65 / 1039.01 | 316.13 / 320.02 |

Unscoped materialized p50 was consistently about three to four times lower in
this fixture. It is not a generic filtered-read improvement and does not set a
service-level objective or production capacity claim.

## Plans, writes, and environment

At 100,000 rows, each materialized lookup fetched about 100 history rows through
the existing entity-reference index before provider/source filtering and top-one
selection.

At 200,000 unscoped rows, enumeration used an index-only scan of the existing
entity-reference index over 200,000 rows, then `Unique` for 20,000 references.
It had zero heap fetches after vacuum and 3,000 after writes. A nested loop then
ran 20,000 materialized reference lookups, each reading about 10 rows. It did
not read only 20,000 total history rows.

All scopes ran 20,000 reference-history loops. Scoped enumeration used a
sequential scan or bitmap heap scan plus hash aggregate before those loops, which
accounts for its added cost. The recorded 200,000-row unscoped plan had no temp
blocks. Separate `EXPLAIN` execution was 301.344 ms settled and 303.154 ms
fresh; these values differ from the 313.78 / 316.13 ms method measurements.

The public baseline's full sort and the candidate's narrower reference
enumeration explain the observed unscoped plan difference. They do not prove an
application objective or a production response-time target.

| Profile | Public write p50 / p95 | Materialized write p50 / p95 |
| ------- | ---------------------: | ---------------------------: |
| 100k    |            6.10 / 8.09 |                  5.89 / 8.48 |
| 200k    |            6.76 / 8.56 |                  7.55 / 8.65 |

Write values are milliseconds for 30 normal committed 100-row `recordCycle`
probes. Both variants had zero added index bytes and identical normal
production-defined index inventories. Sequential run noise means these figures
do not show a causal percentage write overhead.

The completed runs used PostgreSQL 16.15, Node 24.22.1,
`@backstage/backend-test-utils` 1.11.8, Knex 3.2.10, and `pg` 8.23.0 on macOS
arm64 with an Apple M4 Max, 14 host CPUs, and about 36 GiB host memory. Container
CPU and memory quotas were unknown.

PostgreSQL used `shared_buffers = 128MiB`, `work_mem = 4MiB`,
`synchronous_commit = on`, and autovacuum enabled. These fixture conditions and
warm phase order do not represent production I/O, cache state, or capacity.

## Plans and artifacts

Read-only `EXPLAIN` records capture plan nodes, actual rows and loops, buffers,
sort activity, exposed internal scan direction, and allowed index names. They
exclude SQL, bindings, and scope predicate values.

Each executor-mode plan record verifies its own executed SQL and bindings in
memory. `public` uses `matchedPublicSqlAndBindings: true`; candidate modes use
`matchedExecutedSqlAndBindings: true`. These flags do not claim candidate SQL is
identical to public SQL.

Artifacts record source SHA, dirty state, exact package versions, selected modes,
actual seed and final counts, samples, quantiles, plans, write cost, index
inventory, cleanup, and final result. Every owned pool was idle and destroyed on
completed runs; no Docker container cleanup is claimed before SDK `afterAll`.

## Interpreting results

Use the full paired 200,000-row comparison for the main decision. Compare each
scope and phase separately; do not average four scopes into one result.

The [prior latest-state query candidate benchmark](benchmark-latest-query.md)
records older negative and partial experiments with different candidates and
indexes. Its results do not measure this materialized lateral candidate.
