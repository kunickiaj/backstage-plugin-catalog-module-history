# Entity discovery evaluation

This evaluation examines a future entity-name prefix picker and Kind dropdown
backed by retained catalog history. It records a query and index candidate; it
does not add an API, UI, schema migration, or production index.

## Decision

Use retained history, rather than the live Catalog API, when the picker must
include identities whose latest retained event is a delete tombstone. History
stores `name`, `kind`, `namespace`, and `entity_ref` on those rows. It has no
current/deleted-state inference in this query, so choices describe retained
history, not live catalog membership.

The next API implementation can use a literal, case-insensitive name prefix
and an optional Kind filter. A separate Kind query can list retained kinds for
the same scope. This is not a fuzzy, substring, accent-insensitive, or full
entity-reference search, and it is not a facet feature.

For selective prefixes, evaluate this bounded expression index before adopting
the endpoint:

```sql
CREATE INDEX history_discovery_name128_idx
  ON catalog_history_entities
  ((left(lower(name), 128) COLLATE "C") text_pattern_ops);
```

This DDL is a benchmark candidate, not an authorized migration command.

## Query semantics for a future endpoint

Apply `prefix`, `source`, `provider`, `kind`, `op`, and time filters before
choosing the latest matching row per canonical entity reference. Return all
display fields from that same row:

```sql
SELECT DISTINCT ON (entity_ref COLLATE "C")
  name, kind, namespace, entity_ref, lower(name) AS folded_name
FROM catalog_history_entities
WHERE -- scoped filters and literal-prefix predicates
ORDER BY entity_ref COLLATE "C", changed_at DESC, id DESC;
```

Then order choices by `(folded_name COLLATE "C", entity_ref COLLATE "C")`.
A page of 25 choices needs 26 returned rows for lookahead; this limit does not
limit scan work. Apply a cursor after deduplication with that same ordering.
Pages are live, not snapshots.

An opaque cursor should bind the prefix, scope filters, and an ordering-version
value, but not the page limit. No HTTP route or cursor format exists yet.

### Prefix safety and correctness

The primary predicate must compare the complete folded name using `LIKE` with
`%`, `_`, and backslash escaped as literals. The bounded predicate below only
narrows candidates for the index; it cannot replace the full predicate:

```sql
lower(name) COLLATE "C" LIKE :escapedFullPrefix || '%' ESCAPE chr(92)
AND left(lower(name), 128) COLLATE "C"
    LIKE :escapedShortPrefix || '%' ESCAPE chr(92)
```

Compute the folded prefix in PostgreSQL first. Escape the complete folded value
for `escapedFullPrefix`. For `escapedShortPrefix`, take its first 128 characters
and then escape that value. Truncating an already escaped string can split an
escape pair or shorten the search incorrectly.

The recheck prevents false matches when names share their first 128 characters
or when a prefix is longer than 128 characters. `left` limits only the index
predicate, not the reader's input or the stored name. `COLLATE "C"` sits outside
`lower` so PostgreSQL retains the database locale's case folding. The benchmark
covered literal `%`, `_`, backslash, a quote, Unicode (`É`), and a prefix beyond
128 characters.

Do not add a width limit to names or include unbounded `entity_ref`, `kind`,
`namespace`, or full `name` in this B-tree index. A 128-character UTF-8 prefix
uses at most 512 bytes. The existing public row accepts an unbounded `TEXT`
`name` that can differ from its short canonical reference: a 6,890-byte name
was accepted before indexing, while an unbounded `lower(name)` index failed
with SQLSTATE `54000`. The bounded index accepted a later 12,000-byte name.

## Measured PostgreSQL 16 result

The original run used PostgreSQL 16.15 with `en_US.utf8`, 100,046 retained rows,
10,045 distinct entities, warm shared buffers, one serial client, and five
`EXPLAIN ANALYZE` samples per query. It used normal planner settings. Values are
median execution milliseconds after `ANALYZE`.

| Query shape             | No candidate index | Bounded index |
| ----------------------- | -----------------: | ------------: |
| Rare prefix, 25 results |             21.828 |         0.234 |
| Missing prefix          |             21.617 |         0.010 |
| Empty prefix            |             70.953 |        72.924 |
| Common prefix           |             70.206 |        44.361 |
| Late cursor page        |             71.440 |        71.332 |
| Retained kinds          |             27.316 |        27.092 |

The planner selected the candidate index for selective literal and Unicode
prefixes. It did not improve every shape: without statistics, the indexed common
prefix measured 98.045 ms, slower than the unindexed case. Empty-prefix,
late-cursor, and Kind queries do not use this name-prefix index as a general
solution.

These are fixture measurements, not a production SLO, capacity result, or
large-tenant prediction. PostgreSQL 16 is the tested version; the repository
does not declare a minimum PostgreSQL version, and this run does not certify
other versions. No `pg_trgm`, fuzzy search, substring search, or
materialized variant was evaluated.

## Storage, writes, and upgrade limits

At 100,046 retained rows, the candidate index built in 34.807 ms and occupied
851,968 bytes. One 1,000-row write probe changed `EXPLAIN` execution time from
9.671 to 10.309 ms and WAL from 1,003,089 to 1,108,492 bytes. One probe cannot
estimate a production write-overhead percentage.

The fixture's regular `CREATE INDEX` held a `ShareLock`: reads continued, but a
write with a 100 ms lock timeout failed with `55P03` until commit, including
after the index statement returned. Existing migrations run in a regular
transaction, so an index build would block history recording until that
transaction commits. If the candidate becomes a migration, plan its installation
and upgrade behavior separately. Run `ANALYZE` after the build so the planner
has statistics; its read-history and migration-startup cost also need separate
evaluation.

## Reproduce the fixture

Docker is required. The benchmark creates a new randomly credentialed PostgreSQL
16 container on loopback, applies the three baseline migrations, seeds its own
data, and removes its pool and container in `finally`. It accepts no user
database connection.

```sh
node packages/catalog-history-backend/src/benchmarks/entityDiscovery.benchmark.mjs
```

The command writes SQL, plans, measurements, and assertions to ignored
`.tmp/entity-discovery/evidence.json`; a rerun replaces that file. The table
above records the original run. The fixture covers 10,046 and 100,046 retained rows, mixed
kind/namespace/provider/source/operation/time values, wide names, delete-only
custom kinds, and 39 normalized retained kinds.
