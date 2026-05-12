# Catalog History — Backstage Backend Module — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to implement this plan task-by-task.

**Goal:** Build an open-source Backstage backend module that records every catalog `EntityProvider` mutation into a versioned history store, producing a queryable audit trail of every entity change with no impact on Backstage's hot path. Ships with a Postgres backend in v1; designed around a pluggable `HistoryStore` interface so additional backends (Dolt, ClickHouse, etc.) can be added without changes to the wrapper.

**Architecture:** A composition-based wrapper (`HistoryRecordingEntityProvider`) decorates any existing `EntityProvider`, intercepts the `EntityProviderConnection.applyMutation` call, applies the mutation to Backstage's Postgres normally (untouched hot path), then computes the per-row diff against the current history-store state and records the cycle via a `HistoryStore.recordCycle()` call. The default `PostgresHistoryStore` writes to two tables (`catalog_history_cycles` and `catalog_history_entities`) in the Backstage Postgres instance — no new datastore, no new ops surface. A reconciler runs in-process on an hourly schedule via Backstage's built-in `coreServices.scheduler` (with distributed locking across replicas, no external CronJob, no auth token), snapshots the catalog directly via the in-process catalog service, and records any drift — providing a safety net so the wrapper can treat history recording as best-effort.

**Tech Stack:** TypeScript, Backstage backend (`@backstage/backend-defaults` + `@backstage/plugin-catalog-node` + `coreServices.scheduler` for the reconciler), Knex (`pg` dialect for v1), PostgreSQL 14+, Jest for tests, GitHub Actions for CI. v2 may add a Dolt backend (`mysql2` dialect against a Dolt sql-server) — interface is designed to support this without wrapper changes.

---

## Background & Motivation

Backstage's catalog is a snapshot of "what is true about your org and software right now." When entity providers (Okta, GitHub, MS Graph, etc.) run their hourly `full` mutations, they DELETE then INSERT all entities they own — destroying the previous state irrecoverably. This makes it impossible to answer questions like:

- "When did Bob leave the platform team?"
- "What components were owned by the now-defunct Frontend-Infra group?"
- "Who was on-call when the incident fired three weeks ago?"
- "What was the org chart on 2026-03-05?"

This module captures every mutation to a structured history table, giving:

1. **Audit trail** — every change attributed by provider, timestamped, grouped by mutation cycle.
2. **Time-travel queries** — reconstruct catalog state at any past timestamp via `DISTINCT ON` / `LATERAL JOIN`.
3. **Reorg detection** — single SQL query returns joiners / leavers / team transfers for any cycle.
4. **Foundation for automation** — e.g., a Backstage scaffolder template that opens PRs to update `catalog-info.yaml` files when their owners disappear, using the audit history to propose new owners.
5. **Foundation for use-case-specific frontends** — org-chart timeline UI, ownership-change dashboards, on-call attribution lookups — all built on the same history tables.

## Why Postgres in v1 (and Why a Pluggable Backend)

The original sketch for this project used Dolt (a MySQL-compatible relational DB whose storage is a Merkle DAG, giving git-like commits/branches/diffs on table data). Dolt offers genuinely cleaner ergonomics for this workload:

- `SELECT ... FROM entities AS OF '2026-03-05'` instead of LATERAL JOIN gymnastics
- `dolt_diff_entities` instead of self-joins on a history table
- Per-row blame and branching as first-class operations
- Git-like push/clone if you ever want to share the audit log externally

The cost of Dolt is real and not subtle: a new datastore your team has to learn, monitor, back up, and tune; sidecar lifecycle in k8s; S3 push pipeline; clone-on-start init containers; IAM scoping; cross-database joins for any query that wants live + historical data; rare expertise on the skills market.

For most teams — especially small ones — that operational tax outweighs the query ergonomics. **The right move is to ship the wrapper, etag-skip optimization, reconciler, and backend module wiring all on Postgres in v1**, with a `HistoryStore` interface that lets a Dolt backend ship later as opt-in for users who want the AS-OF / branch / push-to-S3 superpowers and have the ops bandwidth.

## Non-Goals (explicitly out of scope for v1)

- **Dolt backend.** Deferred. Interface designed to support it; no implementation in v1.
- **Delta-mutation buffering.** v1 records per `applyMutation` call. For `full` mutations this is naturally one cycle per provider refresh. Providers that emit bursty `delta` mutations (e.g., GitHub webhook-driven) produce a cycle per call in v1; coalescing is v2.
- **Branching / merge workflows.** N/A for Postgres backend; would only matter for Dolt v2.
- **Replacing Backstage's catalog tables.** Backstage's catalog backend continues to use its own tables for all UI-serving reads. History is a parallel shadow.
- **Use-case-specific frontends.** Org-chart timeline UI, ownership dashboards, etc. are downstream consumers built against the history tables; not part of this module.
- **Multi-tenant or cross-cluster federation.** Single-instance deployment.

## Architecture Overview

```
                    ┌────────────────────────────────────────┐
                    │  Backstage backend (catalog plugin)    │
                    │                                        │
   Okta API ───────►│  OktaOrgEntityProvider                 │
                    │      │                                 │
                    │      ▼                                 │
                    │  HistoryRecordingEntityProvider        │
                    │      │                                 │
                    │      ├──► applyMutation ──► PG ◄────── UI / catalog reads
                    │      │                  (catalog tables)
                    │      │                                 │
                    │      └──► HistoryStore.recordCycle() ─┐
                    │                                       │
                    └───────────────────────────────────────┼─
                                                            │
                                  ┌─────────────────────────┘
                                  ▼
                    ┌────────────────────────────────────────┐
                    │  PostgresHistoryStore (v1 default)     │
                    │  → catalog_history_cycles              │
                    │  → catalog_history_entities            │
                    │  (same PG instance as Backstage,       │
                    │   or a separate one — config option)   │
                    └────────────────────────────────────────┘

Reconciler (in-process, hourly via coreServices.scheduler):
  catalog service (in-process call) ──diff──► HistoryStore.recordCycle(drift)
  - Distributed-locked across backend replicas (scheduler handles this)
  - No external CronJob, no Backstage API token to manage
  - Optional external CronJob path documented in Phase 8 for users who want it

Read consumers:
  Metabase / Grafana / scaffolder / future UIs ──► PostgreSQL
  (queries catalog_history_entities + catalog_history_cycles)
```

## Schema Reference (PostgresHistoryStore, v1)

Two tables. The cycles table records the existence of every `applyMutation` call (including no-op heartbeats). The entities table records the per-row changes within each cycle.

```sql
-- One row per applyMutation call, including heartbeats with no row changes.
CREATE TABLE catalog_history_cycles (
  cycle_id      UUID        PRIMARY KEY,
  provider      TEXT        NOT NULL,
  mutation_type TEXT        NOT NULL CHECK (mutation_type IN ('full','delta')),
  started_at    TIMESTAMPTZ NOT NULL,
  finished_at   TIMESTAMPTZ NOT NULL,
  n_added       INTEGER     NOT NULL DEFAULT 0,
  n_modified    INTEGER     NOT NULL DEFAULT 0,
  n_removed     INTEGER     NOT NULL DEFAULT 0,
  n_unchanged   INTEGER     NOT NULL DEFAULT 0
);

CREATE INDEX ON catalog_history_cycles (provider, started_at DESC);
CREATE INDEX ON catalog_history_cycles (started_at DESC);

-- One row per entity change. NULL on insert means "no prior value".
-- Hybrid: high-signal columns broken out for clean queries; full metadata/spec preserved as JSONB for forensics.
CREATE TABLE catalog_history_entities (
  id           BIGSERIAL   PRIMARY KEY,
  cycle_id     UUID        NOT NULL REFERENCES catalog_history_cycles(cycle_id) ON DELETE CASCADE,
  entity_ref   TEXT        NOT NULL,
  kind         TEXT        NOT NULL,
  namespace    TEXT        NOT NULL,
  name         TEXT        NOT NULL,
  provider     TEXT        NOT NULL,
  op           TEXT        NOT NULL CHECK (op IN ('insert','update','delete')),
  etag         TEXT,
  display_name TEXT,
  email        TEXT,
  parent       TEXT,
  member_of    JSONB,
  owner        TEXT,
  metadata     JSONB,
  spec         JSONB,
  changed_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX ON catalog_history_entities (entity_ref, changed_at DESC);
CREATE INDEX ON catalog_history_entities (cycle_id);
CREATE INDEX ON catalog_history_entities (provider, changed_at DESC);
CREATE INDEX ON catalog_history_entities (owner) WHERE op != 'delete';
CREATE INDEX ON catalog_history_entities (parent) WHERE op != 'delete';
CREATE INDEX ON catalog_history_entities USING GIN (member_of);
```

**Why hybrid (structured + JSONB):** Structured columns make change queries readable and the high-signal fields (team membership, ownership, group hierarchy) trivially queryable. JSONB columns preserve everything else losslessly. New entity kinds populate fewer structured columns; their unique fields live in JSONB. Adding new structured columns later is a migration.

**Why a separate cycles table:** Lets you record empty heartbeats (proof that a provider ran and produced no changes — a useful signal) without inserting fake history rows. Also gives you per-cycle aggregates (added/modified/removed counts) computed once at insert time, no need to re-aggregate on read.

## Open Decisions to Confirm Before Starting

These choices were settled in design discussion but should be re-confirmed before code is written, since they shape the scaffolding:

1. **Package name & repo location.** Recommended: `backstage-plugin-catalog-backend-module-history` (matches Backstage naming convention). Repo: start in a private personal repo; flip to public once v1 is usable. Consider PRing into [backstage/community-plugins](https://github.com/backstage/community-plugins) when mature.
2. **License.** Apache-2.0 (matches Backstage ecosystem).
3. **Database deployment.** Default: write to the same Postgres instance as Backstage (a separate schema or distinct tables). Config option: point at a different Postgres instance for isolation. v1 ships both; default is "use the Backstage DB."
4. **Node/Backstage versions.** Target current Backstage LTS (whatever's current at implementation time). Verify against Backstage `examples/backend` integration test.
5. **Etag source.** If the upstream provider sets `metadata.etag`, use it. Otherwise compute a stable hash of canonicalized `metadata + spec`. Decide canonicalization: `json-stable-stringify` is sufficient.
6. **Backend allowlist semantics.** Config option `providers: ['*']` means all providers are wrapped; `providers: ['okta-org']` means only that one. Default to `['*']` or to no providers (opt-in)? Recommend: `[]` (opt-in) to make initial install safe.

## Phases

The plan is organized into 12 phases. Phases 1-7 are TDD with bite-sized steps; phases 8-12 are infrastructure/docs and use checklist-style tasks. **Commit at the end of every task.**

---

### Phase 1: Project Scaffold

**Goal:** Empty buildable TS package with Jest, ESLint, Prettier, GH Actions CI, LICENSE, README skeleton.

#### Task 1.1: Initialize repository

**Files:** `package.json`, `tsconfig.json`, `.gitignore`, `.editorconfig`, `LICENSE`, `README.md`

**Steps:**
1. `mkdir <project> && cd <project> && git init`
2. `npm init -y`, edit `package.json`: set `name`, `description`, `license: "Apache-2.0"`, `main: "dist/index.js"`, `types: "dist/index.d.ts"`, `files: ["dist", "README.md", "LICENSE"]`.
3. Add devDeps: `typescript`, `@types/node`, `jest`, `@types/jest`, `ts-jest`, `eslint`, `@typescript-eslint/{parser,eslint-plugin}`, `prettier`.
4. `tsconfig.json`: target ES2022, module NodeNext, strict, declaration, outDir `dist`, rootDir `src`.
5. `.gitignore`: `dist/`, `node_modules/`, `coverage/`.
6. Apache-2.0 LICENSE text.
7. README skeleton: title, one-paragraph description, "Status: pre-alpha".
8. Commit: `chore: initial project scaffold`.

#### Task 1.2: Wire Jest

**Files:** `jest.config.ts`, `src/index.ts`, `src/__tests__/smoke.test.ts`

**Steps:**
1. `jest.config.ts`: `preset: 'ts-jest'`, `testEnvironment: 'node'`, `roots: ['<rootDir>/src']`.
2. Smoke test: `test('jest is wired', () => expect(1+1).toBe(2));`
3. Run `npx jest`. Expected: 1 passed.
4. Add npm scripts: `build`, `test`, `test:watch`, `lint`, `format`.
5. Run `npm run build`. Expected: clean.
6. Commit: `chore: configure jest and build scripts`.

#### Task 1.3: ESLint + Prettier + CI

**Files:** `.eslintrc.cjs`, `.prettierrc`, `.github/workflows/ci.yml`

**Steps:**
1. Standard eslint config for TS + prettier compatibility.
2. CI workflow: matrix on Node 20.x, run `npm ci`, `npm run lint`, `npm run build`, `npm test`. Add a Postgres service container (`postgres:16` on port 5432).
3. Commit: `ci: lint, build, test on push and PR`.

---

### Phase 2: HistoryStore Interface

**Goal:** Define the abstraction that decouples the wrapper from any specific storage backend. Ship it with full TypeScript types and a no-op test double.

#### Task 2.1: Define the interface

**Files:** `src/store/HistoryStore.ts`, `src/store/types.ts`

**Steps:**
1. `types.ts`: `EntityRow` type (matches the schema's structured columns + jsonb metadata/spec), `CycleInput` type, `MutationType = 'full' | 'delta'`.
2. `HistoryStore.ts`:
   ```ts
   export interface HistoryStore {
     loadCurrentEtags(provider: string): Promise<Map<string, string>>;
     recordCycle(input: CycleInput): Promise<void>;
   }

   export type CycleInput = {
     cycleId: string;          // UUID
     provider: string;
     mutationType: 'full' | 'delta';
     startedAt: Date;
     finishedAt: Date;
     inserts: EntityRow[];     // entities new since last seen
     updates: EntityRow[];     // entities present before with different etag
     deletes: string[];        // entity_refs of entities present before but absent now
     unchangedCount: number;   // for cycle metadata
   };
   ```
3. Commit: `feat(store): HistoryStore interface`.

#### Task 2.2: In-memory test-double store

**Files:** `src/store/__tests__/InMemoryHistoryStore.ts`, `src/store/__tests__/InMemoryHistoryStore.test.ts`

**Steps:**
1. `InMemoryHistoryStore` implements `HistoryStore`. Holds an array of cycles and a Map of current etags. Used by wrapper tests so they don't need a database.
2. Tests verify: `loadCurrentEtags` returns latest non-deleted etags; `recordCycle` updates state correctly across multiple cycles.
3. Run: PASS.
4. Commit: `feat(store): in-memory test double`.

---

### Phase 3: Postgres Schema & Migrations

**Goal:** Code that, given a Postgres connection, ensures the history schema exists at the expected version. Idempotent.

#### Task 3.1: Schema bootstrap test (red)

**Files:** `src/postgres/__tests__/ensureSchema.test.ts`

**Steps:**
1. Test imports `ensureSchema(knex)`, calls it twice against a Postgres test DB, asserts both tables exist with the columns from the Schema Reference.
2. Use a Postgres instance running locally on port 5432 (CI service container, or document `docker run -d -p 5432:5432 -e POSTGRES_PASSWORD=test postgres:16` for local dev).
3. Run: FAIL.
4. Commit: `test: postgres schema bootstrap (failing)`.

#### Task 3.2: Implement `ensureSchema`

**Files:** `src/postgres/ensureSchema.ts`, `src/postgres/migrations/001-initial.sql`

**Steps:**
1. Knex migration approach: use Knex's built-in migrations or roll a thin custom runner. Recommend Knex's: `knex.migrate.latest({ directory })`.
2. `001-initial.sql` (or `001-initial.ts`): the two `CREATE TABLE` statements + indexes from the Schema Reference, all `IF NOT EXISTS` where supported.
3. `ensureSchema(db)` calls `db.migrate.latest()`.
4. Run test: PASS.
5. Commit: `feat(postgres): bootstrap schema via knex migrations`.

---

### Phase 4: PostgresHistoryStore Implementation

**Goal:** Implement `HistoryStore` against Postgres, with the etag bulk-load and cycle-recording logic.

#### Task 4.1: `loadCurrentEtags` test

**Files:** `src/postgres/__tests__/PostgresHistoryStore.test.ts`

**Steps:**
1. Pre-seed `catalog_history_entities` with a few entities across multiple cycles (some inserts, some updates, some deletes for the same entity_ref).
2. Test that `loadCurrentEtags(provider)` returns the etag from the most recent non-`delete` row per `entity_ref`, scoped to the given provider.
3. Run: FAIL.
4. Commit: `test: postgres etag loader (failing)`.

#### Task 4.2: Implement `loadCurrentEtags`

**Files:** `src/postgres/PostgresHistoryStore.ts`

**Steps:**
1. Single SQL query using `DISTINCT ON`:
   ```sql
   SELECT DISTINCT ON (entity_ref) entity_ref, etag
   FROM catalog_history_entities
   WHERE provider = $1 AND op != 'delete'
   ORDER BY entity_ref, changed_at DESC;
   ```
2. Hydrate into a `Map<string, string>`.
3. Run test: PASS.
4. Commit: `feat(postgres): bulk etag loader`.

#### Task 4.3: `recordCycle` test

**Files:** `src/postgres/__tests__/PostgresHistoryStore.test.ts`

**Steps:**
1. Test happy path: a cycle with 2 inserts, 1 update, 1 delete. Assert: 1 row in `catalog_history_cycles` with correct counts; 4 rows in `catalog_history_entities` with correct `op` values.
2. Test heartbeat: a cycle with 0 inserts/updates/deletes and `unchangedCount: 100`. Assert: 1 row in `cycles` (with all change counts at 0), 0 rows in `entities`.
3. Test atomicity: simulate a failure mid-write (e.g., violate a constraint). Assert: nothing partially inserted (transaction rolled back).
4. Run: FAIL.
5. Commit: `test: postgres recordCycle (failing)`.

#### Task 4.4: Implement `recordCycle`

**Files:** `src/postgres/PostgresHistoryStore.ts`

**Steps:**
1. Single transaction:
   - INSERT into `catalog_history_cycles`.
   - For each delete, INSERT into `catalog_history_entities` with `op='delete'` (only entity_ref + cycle_id + provider + kind/namespace/name parsed from ref + changed_at; metadata/spec NULL).
   - Bulk INSERT inserts (`op='insert'`) and updates (`op='update'`).
2. Run tests: PASS.
3. Commit: `feat(postgres): recordCycle implementation`.

---

### Phase 5: Wrapper Core

**Goal:** `HistoryRecordingEntityProvider` class that wraps any `EntityProvider`, intercepts `applyMutation`, computes diffs against the store, and calls `recordCycle`. Full mutations only in v1.

#### Task 5.1: Define entity → row mapping

**Files:** `src/mapping/entityToRow.ts`, `src/mapping/__tests__/entityToRow.test.ts`

**Steps:**
1. Tests: given a Backstage `Entity` of kind User, Group, Component → assert structured columns are populated correctly and `metadata` / `spec` round-trip cleanly. Edge cases: missing optional fields, custom annotations, non-default namespace.
2. Run: FAIL.
3. Implement `entityToRow(entity, provider): EntityRow`. Compute `entity_ref` as `${kind}:${namespace}/${name}` lowercased.
4. Compute `etag`: prefer `entity.metadata.etag`; else `sha256(stableStringify({ metadata, spec }))`.
5. Run: PASS.
6. Commit: `feat(mapping): entity → row transform`.

#### Task 5.2: Wrapper happy-path test

**Files:** `src/provider/__tests__/HistoryRecordingEntityProvider.test.ts`

**Steps:**
1. Build a fake `EntityProvider` that, on `connect`, immediately calls `applyMutation({ type: 'full', entities: [user1, user2, group1] })`.
2. Wrap it with `new HistoryRecordingEntityProvider(fake, new InMemoryHistoryStore(), logger)`.
3. Provide a fake `EntityProviderConnection` whose `applyMutation` is a spy.
4. Call `wrapper.connect(fakeConnection)`, await pending work.
5. Assert: (a) inner connection's `applyMutation` was called with the same payload, (b) store has 1 cycle with 3 inserts, 0 updates, 0 deletes, 0 unchanged.
6. Run: FAIL.
7. Commit: `test: wrapper full-mutation happy path (failing)`.

#### Task 5.3: Implement wrapper — full mutation with etag-skip

**Files:** `src/provider/HistoryRecordingEntityProvider.ts`, `src/index.ts`

**Steps:**
1. Class implements `EntityProvider`. Stores `inner`, `store`, `logger`. `getProviderName()` delegates.
2. `connect(connection)` constructs a wrapped `EntityProviderConnection`:
   - `applyMutation` async function:
     - Always: `await connection.applyMutation(mutation)` first (Backstage's normal write).
     - If `mutation.type !== 'full'`: log warning "delta mutations not recorded in v1", return. (v2 will buffer these.)
     - Else, in a try/catch:
       - `cycleId = randomUUID()`; `startedAt = new Date()`.
       - Map all incoming entities → rows; compute etags.
       - `existing = await store.loadCurrentEtags(this.getProviderName())`.
       - Diff: classify each incoming row as `insert` (not in existing), `update` (in existing, etag differs), or unchanged (in existing, etag same). Compute deletes (in existing, not in incoming).
       - `await store.recordCycle({ cycleId, provider, mutationType: 'full', startedAt, finishedAt: new Date(), inserts, updates, deletes, unchangedCount })`.
   - `refresh: connection.refresh.bind(connection)`.
3. **Best-effort guarantee:** the try/catch around the history block logs + increments a metric counter on any error and never re-throws. Backstage's PG write happens before the try/catch and is unaffected.
4. Run test: PASS.
5. Commit: `feat(provider): wrapper with etag-skip`.

#### Task 5.4: Etag-skip behavioral tests

**Files:** `src/provider/__tests__/HistoryRecordingEntityProvider.test.ts`

**Steps:**
1. Test: two consecutive identical full mutations. Assert: first cycle has 3 inserts; second cycle has 0/0/0 with unchangedCount=3 (heartbeat).
2. Test: second mutation differs in one entity's display_name. Assert: second cycle has 0 inserts, 1 update, 0 deletes, 2 unchanged.
3. Test: second mutation drops one entity, adds a new one. Assert: 1 insert, 0 updates, 1 delete, 2 unchanged.
4. Run: PASS.
5. Commit: `test: etag-skip behavior across cycles`.

#### Task 5.5: Failure-isolation test

**Files:** `src/provider/__tests__/HistoryRecordingEntityProvider.test.ts`

**Steps:**
1. Wire a `HistoryStore` whose `recordCycle` always throws. Assert: (a) inner connection's `applyMutation` STILL called (PG write still happens), (b) wrapper does not throw, (c) logger received an error-level message.
2. Run: should already PASS given Task 5.3's try/catch. If not, fix.
3. Commit: `test: wrapper isolates store failures from postgres path`.

---

### Phase 6: Reconciler

**Goal:** A reconciler function that snapshots Backstage's current catalog state and records any drift via the store, providing a safety net for missed cycles. Designed to be invoked from a scheduled in-process task (Phase 7.3) or, optionally, from an external CronJob via the CLI (Phase 8). The function depends on a minimal `EntityFetcher` interface (`getEntities()`) so both an in-process catalog service and an HTTP catalog client can satisfy it.

#### Task 6.1: Reconciler test

**Files:** `src/reconciler/__tests__/reconcile.test.ts`

**Steps:**
1. Build a fake `EntityFetcher` that returns a fixed entity set.
2. Pre-seed an `InMemoryHistoryStore` with a different entity set (simulating drift).
3. Call `reconcile({ fetcher, store, logger })`.
4. Assert a single drift cycle was recorded with the symmetric diff; mutationType `'full'`; provider `'reconciler'`.
5. Test no-drift case: assert a heartbeat cycle is recorded with no row changes.
6. Run: FAIL.
7. Commit: `test: reconciler (failing)`.

#### Task 6.2: Implement reconciler

**Files:** `src/reconciler/reconcile.ts`, `src/reconciler/EntityFetcher.ts`

**Steps:**
1. Define a minimal `EntityFetcher` interface: `{ getEntities(): AsyncIterable<Entity> }` (or `Promise<Entity[]>` if you prefer non-streaming for v1). Both Backstage's in-process catalog service and the HTTP `CatalogClient` can be adapted to this.
2. `reconcile({ fetcher, store, logger })`:
   - Fetch all entities from the fetcher (paginate if applicable).
   - `loadCurrentEtags('reconciler')` is *not* what we want — the reconciler needs visibility across all providers. Add a method to `HistoryStore`: `loadAllCurrentEtags(): Promise<Map<string, { etag: string; provider: string }>>`. Update `InMemoryHistoryStore` and `PostgresHistoryStore` to implement.
   - Diff against the global current state. If non-empty: record one cycle as provider='reconciler', mutationType='full', with appropriate inserts/updates/deletes.
   - Heartbeat if empty.
3. Run test: PASS.
4. Commit: `feat(reconciler): drift detection and recovery`.

#### Task 6.3: CLI entry point for reconciler (optional path)

**Files:** `src/bin/reconcile.ts`, modify `package.json` (add `bin` field)

**Steps:**
1. **Note:** the default deployment runs the reconciler in-process via the Backstage scheduler (Phase 7.3). This CLI exists for one-shot manual runs (ad-hoc backfills, debugging) and as the entry point for users who want to run the reconciler as an external CronJob (Phase 8). Most users will not run this in production.
2. Standalone Node script that reads config from env (`BACKSTAGE_BASE_URL`, `BACKSTAGE_TOKEN`, `PG_CONNECTION_STRING`), constructs an HTTP `CatalogClient` adapted to `EntityFetcher` and a Postgres knex, calls `reconcile`, exits.
3. Manual smoke test: run against a local Backstage + Postgres.
4. Commit: `feat(reconciler): CLI entry point for manual / external runs`.

---

### Phase 7: Backstage Backend Module

**Goal:** Wire the wrapper into a real Backstage backend via `createBackendModule`. Config-driven allowlist of providers to wrap.

#### Task 7.1: Backend module skeleton test

**Files:** `src/module/__tests__/catalogModuleHistory.test.ts`

**Steps:**
1. Use `@backstage/backend-test-utils` (`startTestBackend`) to construct a test backend with a fake catalog plugin and the `catalogModuleHistory` registered.
2. Register a fake provider; trigger a refresh; assert a cycle was recorded.
3. Run: FAIL.
4. Commit: `test: backend module integration (failing)`.

#### Task 7.2: Implement `catalogModuleHistory`

**Files:** `src/module/catalogModuleHistory.ts`

**Steps:**
1. `createBackendModule({ pluginId: 'catalog', moduleId: 'history', register(reg) { ... } })`.
2. In `register`, depend on `catalogProcessingExtensionPoint`, `coreServices.rootConfig`, `coreServices.logger`, `coreServices.database` (or a separate connection if the user provides one), and `coreServices.scheduler` (for Task 7.3).
3. Read config from `catalog.history`:
   ```yaml
   catalog:
     history:
       enabled: true
       providers: ['*']             # or ['okta-org', 'github-org']
       database:                     # optional; defaults to backstage's DB
         client: pg
         connection: ${HISTORY_PG_URL}
       reconciler:                   # optional; sensible defaults
         enabled: true               # set false to use external CronJob (Phase 8) instead
         frequency: { hours: 1 }
         timeout: { minutes: 10 }
   ```
4. If disabled, no-op return.
5. Build the Postgres knex (either reuse Backstage's `database` service or build a separate one from config); await `ensureSchema(db)`.
6. Construct a `PostgresHistoryStore`.
7. Use `catalogProcessingExtensionPoint.addEntityProvider` (verify the current API at impl time) to wrap each registered provider in `HistoryRecordingEntityProvider` based on the allowlist.
8. Run test: PASS.
9. Commit: `feat(module): backstage backend module wiring`.

#### Task 7.3: Schedule the reconciler in-process

**Files:** modify `src/module/catalogModuleHistory.ts`, add `src/module/__tests__/catalogModuleHistory.scheduler.test.ts`

**Steps:**
1. Test (red): use `startTestBackend` with the module registered and a fake catalog service that returns a known entity set. Pre-seed the store with drift. Trigger the scheduled task (Backstage's test harness exposes a way to fire scheduled tasks immediately — verify current API). Assert: a drift cycle was recorded with provider='reconciler'.
2. Test: with `catalog.history.reconciler.enabled: false`, assert `scheduler.scheduleTask` is NOT called.
3. Implement: in the module's `init`, after constructing the store, build an `EntityFetcher` adapter around the in-process catalog service obtained via DI. Then:
   ```ts
   if (cfg.reconciler.enabled !== false) {
     await scheduler.scheduleTask({
       id: 'catalog-history-reconciler',
       frequency: cfg.reconciler.frequency ?? { hours: 1 },
       timeout: cfg.reconciler.timeout ?? { minutes: 10 },
       scope: 'global',                  // distributed lock across replicas
       fn: async () => {
         await reconcile({ fetcher, store, logger });
       },
     });
   }
   ```
4. Run tests: PASS.
5. Commit: `feat(module): schedule reconciler via coreServices.scheduler`.

#### Task 7.4: Documentation in README

**Files:** `README.md`

**Steps:**
1. Installation: `yarn add backstage-plugin-catalog-backend-module-history`.
2. Wiring snippet: `backend.add(import('backstage-plugin-catalog-backend-module-history'))`.
3. Config example.
4. Sample SQL queries pointing to `docs/USAGE.md`.
5. Commit: `docs: README usage section`.

---

### Phase 8: Optional External Reconciler Deployment

**Goal:** Ship reference materials for the (uncommon) case where a user wants to run the reconciler as an external CronJob instead of in-process. **The default deployment needs none of this** — the in-process scheduler from Task 7.3 covers the standard case with no extra infra.

**When to use this path:**
- You want reconciler runs decoupled from the Backstage backend lifecycle (e.g., reconcile during backend redeploys).
- You want the reconciler on a different node pool / with different resource limits.
- Your security model forbids the backend process from running scheduled work.

For most users, skip this phase. To use this path, set `catalog.history.reconciler.enabled: false` and run the CronJob below.

#### Task 8.1: Dockerfile for the reconciler CLI

**Files:** `examples/docker/Reconciler.Dockerfile`

**Steps:**
1. Multi-stage Node 20 build of the reconciler CLI from Task 6.3.
2. Document required env vars (`BACKSTAGE_BASE_URL`, `BACKSTAGE_TOKEN`, `PG_CONNECTION_STRING`).
3. Commit: `examples(docker): optional external reconciler image`.

#### Task 8.2: K8s CronJob manifest

**Files:** `examples/k8s/optional-external-reconciler-cronjob.yaml`

**Steps:**
1. CronJob: schedule `0 * * * *`, runs the reconciler image.
2. Env from a Secret with `BACKSTAGE_TOKEN` and `PG_CONNECTION_STRING`.
3. Comment header in the manifest reminds the operator: this is the optional path; requires `catalog.history.reconciler.enabled: false` in the Backstage app config.
4. Commit: `examples(k8s): optional external reconciler cronjob`.

---

### Phase 9: Observability

**Goal:** Operator can tell when history recording is healthy or broken.

#### Task 9.1: Metrics

**Files:** `src/metrics/index.ts`, modify wrapper, reconciler.

**Steps:**
1. Use Backstage's built-in metrics (verify current API).
2. Counters: `catalog_history_mutations_total{provider,type,result=success|failure}`, `catalog_history_cycles_total{provider}`, `catalog_history_rows_changed_total{provider,kind=insert|update|delete}`.
3. Gauges: `catalog_history_last_cycle_age_seconds{provider}`.
4. Reconciler counter: `catalog_history_reconciler_drift_rows_total`.
5. Manual smoke test: scrape `/metrics`.
6. Commit: `feat(metrics): wrapper + reconciler instrumentation`.

#### Task 9.2: Health check endpoint

**Files:** `src/health/index.ts`

**Steps:**
1. Endpoint that returns 200 if (a) the history DB is reachable AND (b) the most recent cycle is less than 2× the longest provider's refresh interval old. Else 503.
2. Document for k8s `livenessProbe` / `readinessProbe`.
3. Commit: `feat(health): readiness endpoint`.

---

### Phase 10: Documentation & Examples

**Goal:** Make the project genuinely usable by an outside engineer with zero context.

#### Task 10.1: ARCHITECTURE.md

**Files:** `docs/ARCHITECTURE.md`

**Steps:**
1. Copy/adapt the "Architecture Overview" + "Schema Reference" sections of this plan.
2. Include the data flow diagram.
3. Explain failure modes and how the reconciler recovers.
4. Explain the `HistoryStore` abstraction and why it exists.
5. Commit: `docs: architecture overview`.

#### Task 10.2: USAGE.md — query cookbook

**Files:** `docs/USAGE.md`

**Steps:**
1. Write 8-10 example queries against the Postgres tables:
   - Joiners / leavers in last cycle
   - Team transitions (member_of changes between adjacent cycles for a user)
   - Entities orphaned by group dissolution (drives the scaffolder use case)
   - Org chart as of a past timestamp (`DISTINCT ON` query)
   - Per-entity blame (latest cycle that changed each row)
   - Rate of change per provider over time
   - Heartbeat freshness (last cycle per provider)
2. For each: query, expected output shape, what question it answers.
3. Commit: `docs: query cookbook`.

#### Task 10.3: CONTRIBUTING.md + CODE_OF_CONDUCT.md

**Files:** `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md` (Contributor Covenant 2.1)

**Steps:**
1. CONTRIBUTING: dev setup (`docker run` for Postgres, `npm install`, `npm test`), PR flow, commit message convention, how to add a new HistoryStore backend.
2. Standard Contributor Covenant text.
3. Commit: `docs: contributing guide and code of conduct`.

#### Task 10.4: Example Backstage app integration doc

**Files:** `docs/INTEGRATION.md`

**Steps:**
1. Walkthrough: take a fresh Backstage app, install this module, configure, run, query the history table.
2. Reference the Backstage docs for app scaffolding rather than vendoring an example app.
3. Commit: `docs: integration walkthrough`.

---

### Phase 11: Release Engineering

**Goal:** First publishable version.

#### Task 11.1: Versioning + changelog

**Files:** `CHANGELOG.md`, configure `release-please`

**Steps:**
1. `release-please` GitHub Action.
2. Initial version `0.1.0`.
3. Commit: `chore(release): wire release-please`.

#### Task 11.2: npm publish workflow

**Files:** `.github/workflows/publish.yml`

**Steps:**
1. On release tag: `npm publish --access public`.
2. Document `NPM_TOKEN` secret in CONTRIBUTING.
3. Commit: `ci: npm publish on tag`.

#### Task 11.3: Pre-publish checklist

**Steps (manual):**
1. Verify README renders cleanly on npmjs.com (`npm pack --dry-run`).
2. Verify no internal company references in any committed file (grep for company name, internal hostnames).
3. Verify LICENSE is present in the published tarball.
4. Tag `v0.1.0` and push; let release-please / publish workflow fire.

---

### Phase 12: Acceptance & Sign-Off

**Goal:** Demonstrate the v1 delivers on the use case.

#### Task 12.1: End-to-end test against a real Backstage

**Steps (manual):**
1. Spin up a fresh Backstage app with this module + a fake EntityProvider that emits known fixtures.
2. Run two cycles — assert the SQL queries from `docs/USAGE.md` return the expected results.
3. Kill the history DB connection mid-cycle; assert Backstage keeps working; assert the reconciler catches up on next run.
4. Document any rough edges as v1.1 issues.

---

## Acceptance Criteria

The plan is complete when:

- [ ] A Backstage backend with one fake `EntityProvider` registered + this module enabled produces one cycle row per `applyMutation` call, with rows visible in `catalog_history_entities`.
- [ ] Re-running the same provider with identical input produces a heartbeat cycle (counts all zero, unchangedCount > 0).
- [ ] Re-running with a single changed entity produces a cycle with exactly one `update` row.
- [ ] Killing the history Postgres mid-run does NOT break Backstage's catalog write or crash the backend; the next run resumes recording; the reconciler catches up missed rows.
- [ ] Reconciler runs automatically on schedule via `coreServices.scheduler` with no external infrastructure; multi-replica backends do not run it concurrently (distributed lock works).
- [ ] All structured-column queries from `docs/USAGE.md` execute against a live history DB without errors.
- [ ] CI is green: lint, build, test (with Postgres service container).
- [ ] Module publishes cleanly to npm under chosen name.
- [ ] README walks an outside engineer from zero to "I can see my catalog history in Postgres" in under 30 minutes.

## Future Work (v2+)

These are intentionally deferred:

- **Dolt backend.** A `DoltHistoryStore` implementing the same interface against a Dolt sql-server. Buys AS-OF queries, branch/merge semantics, and git-like push/clone (S3 remote). For users who want those features and have ops bandwidth for a second datastore. Architecture and ergonomics already designed (see appendix).
- **Delta mutation buffering.** A per-provider mutation buffer with a debounce window (recommended: 30s idle / 100 mutations / flush-on-full). Each flush is a single cycle summarizing the burst. Important for providers that emit bursty webhook-driven deltas (e.g., GitHub).
- **Row-level retention / GC policies.** Time-based partition pruning on `catalog_history_entities` past N years, if the table grows beyond comfort.
- **Use-case-specific frontends.** Org-chart timeline UI, ownership-change dashboards, on-call attribution lookups — separate Backstage plugins consuming the history tables.
- **Scaffolder action: orphan remediation.** A Backstage scaffolder action that queries the history for components orphaned by a group dissolution, derives proposed new owners from the membership migration history, and opens PRs against the source repos to update `catalog-info.yaml`.
- **Branch-per-provider experiments.** (Dolt-backend only.) Run providers on dedicated branches, merge to `main` only after CI / human review. Useful for risky org migrations.
- **Consumer SDK.** Typed query builders for the most common audit queries, so consumers don't write raw SQL.

## Appendix: Notes for a Future Dolt Backend

Design notes preserved from earlier discussion in case someone implements `DoltHistoryStore` later:

- Dolt is MySQL wire-compatible — `knex({ client: 'mysql2' })` works.
- The `entities` table in Dolt would be a single rolling snapshot (not history rows); each cycle is a `dolt commit`. The wrapper pattern stays identical — only the store implementation changes.
- Storage on disk is `.dolt/noms/` chunks; deployable as a sidecar container with `emptyDir` + clone-on-start from S3, push-to-S3 on a 1-min cron.
- Use `CALL DOLT_COMMIT('-A', '-m', ?, '--allow-empty', '--author', ?)` from inside a SQL transaction to atomically commit data + version.
- Replace the `catalog_history_entities` query patterns with `dolt_diff_entities`, `dolt_blame_entities`, and `AS OF` queries — see `docs/USAGE.md` adaptations.
- The `loadAllCurrentEtags` method against Dolt is a simple `SELECT entity_ref, etag, provider FROM entities`.
- Pluggable storage means the wrapper, etag-skip, reconciler, backend module, and metrics all stay; only Phase 4 (PostgresHistoryStore) is replaced with a DoltHistoryStore.

## References

- Backstage backend system: https://backstage.io/docs/backend-system/
- Backstage entity providers: https://backstage.io/docs/features/software-catalog/external-integrations
- Backstage community plugins: https://github.com/backstage/community-plugins
- Postgres `DISTINCT ON`: https://www.postgresql.org/docs/current/sql-select.html#SQL-DISTINCT
- Knex migrations: https://knexjs.org/guide/migrations.html
- Dolt docs (for v2 backend): https://docs.dolthub.com/

## Notes for the Executing Engineer

- **Hot path safety is non-negotiable.** Backstage's existing Postgres write must succeed independently of the history store. Every store operation lives inside try/catch; the wrapper swallows store errors with logs + metrics, never re-raises.
- **Best-effort + reconciler is the design, not a bug.** Don't try to make history recording strongly consistent with the catalog write. The reconciler is the safety net.
- **The reconciler runs in-process via `coreServices.scheduler` by default.** This is intentional — it gives free distributed locking across backend replicas, no separate auth, and one less deployment artifact. The CLI + external CronJob path (Phase 8) is optional and only for users with specific lifecycle constraints.
- **Backstage's Backend System APIs evolve.** Verify the current `createBackendModule` / `catalogProcessingExtensionPoint` signatures against the Backstage docs at implementation time — this plan reflects the API as of early 2026.
- **Test against real Postgres, not a mock.** The DISTINCT ON behavior, JSONB handling, and transaction semantics matter. Use a Docker service container for Jest.
- **Keep the HistoryStore interface minimal.** Every method added makes future backends harder. v1 has only `loadCurrentEtags`, `loadAllCurrentEtags`, `recordCycle`. Add more only when a concrete consumer requires it.
- **Commit at every task boundary.** Frequent small commits make execution review tractable.
