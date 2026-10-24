# Catalog history baseline diagnostic

This opt-in diagnostic runs synthetic catalog snapshots against the public
`@backstage/plugin-catalog-backend` 3.9.1 and the history module. It uses
`@backstage/backend-test-utils` 1.11.7 to start the real backend and an owned
PostgreSQL 16 Docker database; it is not a production benchmark or a database
durability sign-off.

The harness starts the public catalog backend and the module's default history
feature. It registers a `HistoryRecordingEntityProvider` around a synthetic
provider through the catalog processing extension point, then runs the same
snapshots with provider recording off and on. Each snapshot is submitted as a
full provider mutation, then the harness waits for the served catalog state to
match an independent expected reference-and-description map.

## Run the diagnostic

The command needs Docker. Use a shell with no
`BACKSTAGE_TEST_DATABASE_POSTGRES16_CONNECTION_STRING`; the harness refuses
that variable even when its value is empty, before the test database SDK is
created. It never connects to a caller-supplied database or changes host
database settings.

Run a one-stage, standard-profile diagnostic:

```sh
env CI=1 HISTORY_BENCH_STAGES=initial HISTORY_BENCH_COUNT=1000 HISTORY_BENCH_PROFILE=standard \
  yarn workspace @kunickiaj/backstage-plugin-catalog-backend-module-history bench:baseline
```

For the full sequence, omit `HISTORY_BENCH_STAGES` and keep the remaining
variables. The default stages are `initial`, `unchanged`, `change-1pct`,
`change-all`, `remove-half`, `restore`, `revision-1`, `revision-2`,
`revision-3`, and `unchanged-after-retention`.

The harness accepts counts from 1 through 20,000. `heavy` is limited to 1,000
entities. A 30-second SQL statement safety cap applies to all SQL using the
fixture pool, including catalog and history queries. This is a harness setting,
not a plugin feature or a whole-request deadline; it limits what this diagnostic
can show about abandoned SQL.

## Read the artifact

Each invocation creates `.tmp/history-baseline/<UUID>/report.jsonl`. The
directory and its fixture JSONL files are new per run, and `report.jsonl` is
opened in no-overwrite mode. `.tmp/` is ignored, so preserve the artifact you
need before cleaning local scratch space; do not reuse an existing output path.

The report records environment and dependency versions, fixture summaries,
startup settings, provider completion, convergence, read samples, expected and
actual history counters, relation sizes, SQL aggregates, cleanup observations,
and a final pass or partial non-pass record. SQL text is hashed; bindings and
raw errors are omitted.

Inspect the report as diagnostic evidence, not a performance claim. The
artifact's SQL timings cover a whole case, including background work. They do
not identify a single HTTP request, pool wait, or pure PostgreSQL execution
time.

## Fixture shape and expected checks

The fixture generator targets compact `metadata` plus `spec` sizes of 1,190
bytes for `standard` and 8,882 bytes for `heavy`. Before submission, the
harness adds the required `backstage.io/managed-by-location` and
`backstage.io/managed-by-origin-location` annotations. A standard fixture is
therefore 1,311 metadata-and-spec bytes at submission, rather than the
generator's 1,190-byte target.

`unchanged-after-retention` retains the fixture payload from `revision-3`; it
does not run retention. With the default 1,000-entity sequence, the expected
recording-on state has 10 cycles and 6,010 history rows. Recording off expects
zero history cycles and rows. These are harness expectations, not a statement
that a particular machine completed a run successfully.

For every stage, the harness checks all served entity references and
descriptions, not only a count. It separately verifies the expected four
history counters (`n_added`, `n_modified`, `n_removed`, and `n_unchanged`),
history rows, and stock catalog count. It then collects six stock reads and six
history reads per stage: the first stock read occurs after convergence and is
not a cold operating-system cache measurement. Only the initial stage's first
history read includes the query service's first schema-readiness path.

## Cleanup and safety signals

After backend stop returns, the harness waits for both the fixture pool and
PostgreSQL to become quiet. Success requires no used or pending pool work, no
ordinary pending observed SQL, no active PostgreSQL client-backend work, and
four consecutive quiet observations.

Knex transaction controls such as `BEGIN`, `COMMIT`, and `ROLLBACK` emit query
events without matching completion events in the installed Knex behavior. The
report lists their emitted counts and marks completion timing unavailable. They
are excluded only from the observer's pending-SQL check; they do not replace
the independent pool and PostgreSQL quiescence requirements.

The test uses mock user headers, default no credentials, and permission allow.
That exercises the harness routes but does not test a production authentication
or authorization policy.

## Limits

This diagnostic does not explain external catalog 4.0.2 timeouts or attribute a
prior timeout to a SQL cause. It measures neither cold operating-system cache
behavior, retention, soak duration, concurrent load, production-scale behavior,
nor durability. It is a runtime 0.2 baseline and does not include a
read-deadline guard or claim that `queryTimeoutMs: 0` is enforced.
