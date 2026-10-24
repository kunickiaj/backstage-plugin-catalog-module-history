# Catalog history benchmark fixtures

`scripts/catalog-history-fixtures.mjs` generates deterministic Backstage `Component`
entities as JSON Lines (JSONL). Use it to prepare fixture data for a separately
authorized benchmark; it does not call providers, write to a database, run retention,
or measure performance.

The generator uses Node.js built-ins and supports Node 22 and 24. It emits static,
valid entity-shaped JSON with `apiVersion: backstage.io/v1alpha1`, namespace
`benchmark`, `spec.type: service`, `spec.lifecycle: experimental`, and owner
`group:default/benchmark-team`. It contains no real user identifiers, timestamps, or other
personal data.

## Generate fixture files

Create a new output directory and use a fresh file name for every command. `--output`
opens files in no-overwrite mode; if the path already exists, the command fails rather
than replacing it.

```sh
mkdir -p .tmp/history-fixtures

node scripts/catalog-history-fixtures.mjs \
  --count 1000 \
  --profile standard \
  --stage initial \
  --output .tmp/history-fixtures/standard-initial.jsonl

node scripts/catalog-history-fixtures.mjs \
  --count 1000 \
  --profile standard \
  --stage change-1pct \
  --output .tmp/history-fixtures/standard-change-1pct.jsonl

node scripts/catalog-history-fixtures.mjs \
  --count 1000 \
  --profile heavy \
  --stage initial \
  --output .tmp/history-fixtures/heavy-initial.jsonl
```

Keep generated data out of version control; these examples use the ignored
`.tmp/history-fixtures` folder in the persistent workspace. Select another unused output path after a failed or completed run;
do not delete or overwrite an existing fixture file to rerun it.

Without `--output`, the command writes JSONL to standard output and one JSON summary to
standard error after generation completes:

```sh
node scripts/catalog-history-fixtures.mjs --count 3 --profile standard --stage initial
```

Use `--output` when saving a file. Shell redirection bypasses the generator's
no-overwrite check.

Invalid, missing, duplicate, and unknown options are rejected before the generator
opens an output file. Flags use the space form, such as `--count 1000`; the count must
be an integer from `0` through `1000000`. An output failure returns a nonzero status,
and any partial output must not be treated as a usable fixture.

## Choose a profile

| Profile    | Target bytes | Use                      |
| ---------- | -----------: | ------------------------ |
| `standard` |        1,190 | Typical fixture entities |
| `heavy`    |        8,882 | Larger fixture entities  |

The target is the compact UTF-8 byte sum of `JSON.stringify(metadata)` and
`JSON.stringify(spec)`. It is not the raw padding input, the whole entity envelope,
the JSONL line, PostgreSQL JSONB storage, or on-disk storage.

The padding is a deterministic SHA-256 value based on the seed, entity ID, and block
number. Entity names follow `benchmark-project-0000001`; IDs are one-based and padded
to seven digits. Only the description revision changes between stages. The built-in seed
is `catalog-history-benchmark-v1`; use `--seed TEXT` when a distinct, repeatable fixture
set is needed. These are synthetic adapted-size profiles, not bit-identical copies
of an external adapter or proof of performance.

## Run snapshot stages

Run the paired sequence with the same `--count`, `--profile`, and `--seed` each time.
The stages describe fixture contents only; applying those contents to a catalog is work
for a separate harness.

| Stage                       |                 Emitted entities | Description revision                                                  |
| --------------------------- | -------------------------------: | --------------------------------------------------------------------- |
| `initial`                   |           all requested entities | `0`                                                                   |
| `unchanged`                 |           all requested entities | `0`                                                                   |
| `change-1pct`               |           all requested entities | every 100th ID is `1`; all others are `0`                             |
| `change-all`                |           all requested entities | `2`                                                                   |
| `remove-half`               | first `ceil(count / 2)` entities | `2`                                                                   |
| `restore`                   |           all requested entities | `2`                                                                   |
| `revision-1`                |           all requested entities | `3`                                                                   |
| `revision-2`                |           all requested entities | `4`                                                                   |
| `revision-3`                |           all requested entities | `5`                                                                   |
| `unchanged-after-retention` |           all requested entities | `5`, byte-identical to `revision-3`                                   |
| `remove-all`                |                             none | no entities; optional branch, not part of the default paired sequence |

For `--count 1000`, `change-1pct` contains 10 entities at revision `1` and 990 at
revision `0`. `remove-half` emits 500 entities. `revision-1`, `revision-2`, and
`revision-3` are three additional full revisions after the revision-2 state, producing
description revisions 3, 4, and 5.

`unchanged-after-retention` does not perform retention. Its payload is intentionally
the same as `revision-3` so a future harness can compare capture-off and capture-on
paths while holding the fixture payload constant.

## Read the summary

The summary is a JSON object with these fields:

| Field                       | Meaning                                                                        |
| --------------------------- | ------------------------------------------------------------------------------ |
| `requestedCount`            | The requested `--count`, including entities omitted by removal stages          |
| `emittedCount`              | JSONL entities actually emitted                                                |
| `profile`, `stage`, `seed`  | Inputs used for this snapshot                                                  |
| `metadataSpecJsonBytes`     | Profile target plus minimum and maximum compact metadata-plus-spec byte counts |
| `entityJsonBytes`           | Minimum and maximum whole-entity JSON byte counts, excluding the JSONL newline |
| `descriptionRevisionCounts` | Counts for every description revision key from `0` through `5`                 |

`descriptionRevisionCounts` always includes keys `0` through `5`, even when a count is
zero. Check the complete description-revision distribution and emitted entity count, not
only a task status or a single summary field. In removal stages, `requestedCount` and
`emittedCount` differ by design.

An empty snapshot reports `null` for the minimum and maximum byte counts.

The metadata-and-spec measurements verify fixture shape. Do not use them as a linear
estimate of database storage, retention cost, or runtime performance.

## Use fixtures safely in a future harness

Keep `seed`, `profile`, and `count` the same for capture-off and capture-on pairs. Run
the pairs against isolated, authorized test backends only; do not apply these fixtures
to a live catalog.

This generator does not implement provider calls, database writes, retention, current
state comparison, cleanup, or benchmark diagnostics. It also does not claim a 20,000-
entity scale pass, soak behavior, concurrency behavior, webhook behavior, cold-query
behavior, or a SQL performance cause. Add larger data sets and benchmark diagnostics
only after the baseline fixture flow and cleanup plan are in place.

## Verify the generator

Run the focused test suite without a database:

```sh
node --test scripts/catalog-history-fixtures.test.mjs
```

After the workspace scripts are available, the equivalent command is:

```sh
yarn test:fixtures
```
