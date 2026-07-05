# Architecture

Catalog history captures three views of the same catalog: origin, processing, and served truth.

```text
source system
  │
  ▼
EntityProvider.applyMutation
  ├─ HistoryRecordingEntityProvider ───────────────► source='provider'
  ▼
processing loop: preProcessEntity → validate → postProcessEntity
  ├─ HistoryRecordingCatalogProcessor ─────────────► source='processing'
  ▼
stitcher: relations + status + orphan + final etag
  ▼
final_entities / public Catalog API
  ├─ scheduled reconciler or CLI ──────────────────► source='reconciler'
  ▼
catalog_history_cycles + catalog_history_entities
```

See [ADR 2026-07-01](adr/2026-07-01-entity-capture-layers.md) for the capture-layer decision and limitations.

## Data flow and cost

### Provider layer (`source='provider'`)

- Hook: `HistoryRecordingEntityProvider` wraps `EntityProviderConnection.applyMutation`.
- Records: both `full` and `delta` mutations; full cycles infer deletes from the provider baseline.
- Cost: one history cycle per provider refresh/mutation. Cheapest layer.
- Best for: identity-shaped entities where provider data is the source of truth.

```ts
new HistoryRecordingEntityProvider({
  inner,
  store,
  logger,
  enabled:
    config.getOptionalBoolean('catalog.history.provider.enabled') ?? true,
});
```

### Processing layer (`source='processing'`)

- Hook: `HistoryRecordingCatalogProcessor.postProcessEntity` when `catalog.history.processing.enabled` is `true`.
- Records: processor-mutated and processor-emitted entities.
- Skips: unchanged entities by comparing `entityRef → etag` seeded from history.
- Batches: flushes at 500 changed rows or 10 seconds by default.
- Cost: runs once per entity per processing cycle. Higher volume than provider capture.
- Limits: cannot observe deletes; registration order across backend modules is not guaranteed.

```yaml
catalog:
  history:
    processing:
      enabled: true
```

### Reconciler layer (`source='reconciler'`)

- Hook: scheduled in-process task when `catalog.history.reconciler.enabled` is `true`, or external CLI.
- Reads: public Catalog API, so it sees stitched `relations`, `status.items`, orphan state, and final etags.
- Records: one `full` cycle per run using provider name `reconciler`.
- Cost: full catalog scan per run. Default schedule is hourly with a 10 minute timeout and 30 second initial delay.
- Role: drift detector and ground-truth backstop for processor ordering gaps and missed provider wiring.

```yaml
catalog:
  history:
    reconciler:
      enabled: true
```

## Schema reference

### `catalog_history_cycles`

| Column          | Type                       | Constraints / notes                                                             |
| --------------- | -------------------------- | ------------------------------------------------------------------------------- |
| `cycle_id`      | `uuid`                     | Primary key                                                                     |
| `provider`      | `text`                     | Not null; provider name, or `processing` / `reconciler` for module-owned cycles |
| `source`        | `text`                     | Not null, default `provider`; check: `provider`, `processing`, `reconciler`     |
| `mutation_type` | `text`                     | Not null; check: `full`, `delta`                                                |
| `started_at`    | `timestamp with time zone` | Not null                                                                        |
| `finished_at`   | `timestamp with time zone` | Not null                                                                        |
| `n_added`       | `integer`                  | Not null, default `0`                                                           |
| `n_modified`    | `integer`                  | Not null, default `0`                                                           |
| `n_removed`     | `integer`                  | Not null, default `0`                                                           |
| `n_unchanged`   | `integer`                  | Not null, default `0`                                                           |

Indexes:

- `(provider, started_at)`
- `started_at`

### `catalog_history_entities`

| Column         | Type                       | Constraints / notes                                                         |
| -------------- | -------------------------- | --------------------------------------------------------------------------- |
| `id`           | `bigserial`                | Primary key                                                                 |
| `cycle_id`     | `uuid`                     | Not null; references `catalog_history_cycles(cycle_id)` with cascade delete |
| `entity_ref`   | `text`                     | Not null; canonical lowercase ref                                           |
| `kind`         | `text`                     | Not null                                                                    |
| `namespace`    | `text`                     | Not null                                                                    |
| `name`         | `text`                     | Not null                                                                    |
| `provider`     | `text`                     | Not null                                                                    |
| `source`       | `text`                     | Not null, default `provider`; check: `provider`, `processing`, `reconciler` |
| `op`           | `text`                     | Not null; check: `insert`, `update`, `delete`                               |
| `etag`         | `text`                     | Preferred from `metadata.etag`; fallback hash uses metadata + spec only     |
| `display_name` | `text`                     | From `spec.profile.displayName`                                             |
| `email`        | `text`                     | From `spec.profile.email`                                                   |
| `parent`       | `text`                     | From `spec.parent`                                                          |
| `member_of`    | `jsonb`                    | From `spec.memberOf`                                                        |
| `owner`        | `text`                     | From `spec.owner`                                                           |
| `metadata`     | `jsonb`                    | Stored entity metadata                                                      |
| `spec`         | `jsonb`                    | Stored entity spec                                                          |
| `relations`    | `jsonb`                    | Stored as sorted `{ type, targetRef }` objects when present                 |
| `status_items` | `jsonb`                    | Stored from `status.items` when present                                     |
| `orphan`       | `boolean`                  | `true` when `backstage.io/orphan` annotation is `true`; otherwise null      |
| `changed_at`   | `timestamp with time zone` | Not null, defaults to `now()`                                               |

Indexes:

- `(entity_ref, changed_at)`
- `cycle_id`
- `(provider, changed_at)`
- `(source, changed_at)`
- Partial `(owner)` where `op <> 'delete'`
- Partial `(parent)` where `op <> 'delete'`
- GIN on `member_of`

## Attribution model

| Source       | Answers                                                                      |
| ------------ | ---------------------------------------------------------------------------- |
| `provider`   | What did the source system/provider emit?                                    |
| `processing` | What did catalog processors produce after processor mutations and emissions? |
| `reconciler` | What did the public Catalog API serve after stitching?                       |

Use `source` when comparing layers for the same `entity_ref`:

```sql
SELECT DISTINCT ON (source)
  source, entity_ref, etag, relations, status_items, orphan, changed_at
FROM catalog_history_entities
WHERE entity_ref = 'component:default/example'
ORDER BY source, changed_at DESC;
```

## Known limitations

- **Processor deletes**: processors only see entities being processed; absence is not a delete signal.
- **Processor ordering**: modules can add processors independently, so this processor may not be last.
- **Stitch hook**: Backstage does not expose a public stitch-time hook. Reconciler capture through the public Catalog API is the supported substitute.
- **Fallback etags**: when `metadata.etag` is missing, hashes intentionally use only metadata + spec. Provider-layer entities do not include stitched fields; adding them to the fallback hash would create false modification waves.

## Drift and backstop

Provider and processing capture are event-adjacent and cheap enough to run continuously, but each can miss a class of truth: provider capture misses downstream mutations, and processing capture cannot prove deletes or final stitch output.

The reconciler is the backstop. It scans the served catalog, compares against current history etags, and records inserts, updates, deletes, or a heartbeat cycle. Run it scheduled in-process by default; use the CLI when you want process isolation.
