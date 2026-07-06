# Catalog History Productization Roadmap

**Date:** 2026-07-05  
**Status:** planned; follow-up work should be split into beads before implementation  
**Related docs:** [Architecture](../ARCHITECTURE.md), [ADR 2026-07-01](../adr/2026-07-01-entity-capture-layers.md), [original backend module plan](2026-05-11-catalog-history-backstage-module.md), [package split plan](2026-05-12-package-split.md)

## Goal

Turn `backstage-plugin-catalog-backend-module-history` from a backend recording foundation into a usable Backstage history product:

- backend write path for provider, processing, and reconciler capture;
- stable query API for entity history, cycles, versions, and diffs;
- frontend plugin for catalog entity timelines and change inspection;
- operational controls for retention, compaction, observability, and scale;
- package/workspace structure that lets backend, frontend, and shared contracts evolve independently.

The current code already captures catalog history and stores it in Postgres. The next product step is not more hidden tables; it is an API and UI that make history safe, discoverable, permission-aware, and supportable in real Backstage installations.

## Current product state

### What works now

- Provider-layer recording via `HistoryRecordingEntityProvider` (`source='provider'`).
- Processor-layer recording via opt-in `HistoryRecordingCatalogProcessor` (`source='processing'`).
- Scheduled or CLI reconciliation against served catalog truth (`source='reconciler'`).
- Postgres history schema with:
  - `catalog_history_cycles`, one row per recording cycle;
  - `catalog_history_entities`, one row per entity change;
  - structured query columns for common catalog fields;
  - JSONB storage for `metadata`, `spec`, `relations`, and `status_items`.
- SQL examples in the README for point-in-time and relation-change queries.

### What is missing

- No public Backstage backend API for querying history.
- No frontend plugin or entity page tab.
- No typed client shared between backend and frontend.
- No permission/RBAC integration for history reads.
- No retention or compaction policy.
- No scale benchmarks or sizing guidance.
- No operational metrics, health checks, or runbooks.
- No package structure that cleanly separates backend storage, catalog capture module, shared types, and frontend UI.

## Product promise

The finished plugin should let Backstage users answer these questions without writing raw SQL:

- What changed for this entity, and when?
- Which source observed the change: provider, processor, or reconciler?
- What did the catalog serve at a specific point in time?
- Which relations, status items, owner fields, group memberships, or orphan markers changed?
- Which provider caused a burst of changes?
- Did provider-origin truth diverge from served catalog truth?
- How much history are we retaining, and what does it cost?

## Target users

| User | Needs |
| ---- | ----- |
| Backstage operators | Know whether ingestion is healthy, detect provider drift, understand catalog churn, configure retention. |
| Service owners | See why ownership, relations, or orphan state changed for their entities. |
| Platform engineers | Debug processors/providers without direct DB access. |
| Security/compliance teams | Audit entity lifecycle changes and prove historical ownership or membership. |
| Plugin developers | Consume typed APIs for dashboards, automation, and custom views. |

## Workspace recommendation

Yes: the repository should become a Yarn workspace monorepo before adding a frontend plugin.

Backstage conventions expect a plugin family to be multiple packages. The current single package is overloaded: it owns storage, migrations, capture wrappers, a reconciler, config schema, and future API/UI responsibilities. Adding a frontend package without a workspace would either force frontend code into a backend module package or create a second repository too early.

Backstage documentation uses workspace roots with package globs such as:

```json
"workspaces": ["packages/*", "plugins/*"]
```

For this repository, use a narrower structure unless there is a reason to mirror Backstage core exactly:

```text
backstage-plugin-catalog-module-history/
  package.json                         private workspace root
  yarn.lock
  .yarnrc.yml
  config.d.ts                          root-level aggregate schema only if needed
  docs/
  packages/
    catalog-history-common/            frontend/backend-safe types and API contracts
    catalog-history-node/              backend-only shared service refs and store contracts
    catalog-history-backend/           backend plugin: DB, migrations, query API, services
    catalog-backend-module-history/    catalog backend module: provider/processor/reconciler capture
    catalog-history/                   frontend plugin: entity history tab and timeline UI
```

### Package responsibilities

#### `@kunickiaj/catalog-history-common`

Frontend/backend-safe package.

Owns:

- API DTOs for history queries;
- source/op enums;
- pagination contracts;
- diff response shapes;
- lightweight validation helpers if needed.

Must not depend on backend-only Backstage packages, Knex, Node-only APIs, or database code.

#### `@kunickiaj/catalog-history-node`

Backend-only shared package.

Owns:

- `HistoryStore` interface;
- `HistoryQueryService` interface;
- service refs such as `historyStoreServiceRef` and `historyQueryServiceRef`;
- backend-only utility types;
- test utilities such as `InMemoryHistoryStore` if exported intentionally.

This avoids frontend bundles accidentally importing backend code.

#### `@kunickiaj/catalog-history-backend`

Backstage backend plugin.

Owns:

- Postgres migrations and schema bootstrap;
- `PostgresHistoryStore` write implementation;
- `PostgresHistoryQueryService` read implementation;
- HTTP router under the plugin backend path;
- permission integration for history reads;
- metrics/health checks;
- retention/compaction jobs.

This is the package most Backstage apps add to enable the history product.

#### `backstage-plugin-catalog-backend-module-history`

Backstage catalog backend module.

Owns:

- `HistoryRecordingEntityProvider`;
- `HistoryRecordingCatalogProcessor`;
- reconciler registration against the catalog plugin;
- capture-layer config;
- mapping from Backstage `Entity` to history rows.

It should depend on the backend plugin's service refs rather than constructing its own store/database client.

#### `@kunickiaj/catalog-history`

Backstage frontend plugin built for the Backstage New Frontend System (NFS) and Backstage UI (BUI).

Owns:

- API client for the backend query API;
- NFS extension exports for adding history to catalog entity pages;
- BUI-based entity page history content;
- BUI timeline/diff components;
- cycle browser components;
- route refs and plugin exports.

This package should be frontend-only and consume `catalog-history-common` contracts. It should not ship a legacy Backstage plugin-system integration path and should not use Material UI as the primary component system.

## Target architecture

```text
Provider / processors / reconciler
  │
  ▼
catalog-backend-module-history
  │ writes through service ref
  ▼
catalog-history-backend
  ├─ HistoryStore.recordCycle()
  ├─ HistoryQueryService
  ├─ /api/catalog-history/*
  ├─ retention jobs
  └─ metrics / health
  │
  ▼
Postgres history tables
  ▲
  │ query API
  │
catalog-history frontend plugin
  ├─ Entity history tab
  ├─ Timeline
  ├─ Diff viewer
  └─ Cycle/source filters
```

## Product phases

### Phase 1 — Workspace and package boundary refactor

**Goal:** Split the repo before feature growth makes the package boundary harder to untangle.

#### Scope

- Convert root `package.json` into a private Yarn workspace root. Completed first so root tooling can orchestrate package workspaces.
- Move current backend module code into `packages/catalog-backend-module-history`. Completed as an initial physical move; the module still owns storage until later extraction beads move backend services and contracts into their own packages.
- Extract shared contracts into `packages/catalog-history-node` and `packages/catalog-history-common`.
- Create `packages/catalog-history-backend` as the owner of storage, migrations, services, and future query API.
- Keep the frontend package as a scaffold or defer it to Phase 3, but reserve the name and layout now.

#### Acceptance criteria

- `yarn install`, `yarn tsc`, `yarn lint`, `yarn test`, and `yarn build` work from the workspace root.
- Existing public exports remain available or have a documented migration path.
- The catalog module no longer constructs database clients directly when a service ref is available.
- Migrations live with the backend package that owns the tables.
- README installation examples reflect the workspace package names.

#### Risks

- Backstage package roles must be correct per package.
- Existing package consumers may need a temporary compatibility export.
- Dependabot and CI paths need updates.

### Phase 2 — Backend query API

**Goal:** Provide a stable, permission-aware API so users and frontend code do not query Postgres directly.

#### API surface

Proposed base path: `/api/catalog-history`.

Endpoints:

| Endpoint | Purpose |
| -------- | ------- |
| `GET /entities/:kind/:namespace/:name/history` | Paginated timeline for one entity. |
| `GET /entities/:kind/:namespace/:name/versions` | Distinct historical versions for one entity. |
| `GET /entities/:kind/:namespace/:name/diff?from=&to=` | Structured diff between two versions/cycles/timestamps. |
| `GET /entities/:kind/:namespace/:name/as-of?timestamp=` | Entity state as of a timestamp. |
| `GET /cycles` | Paginated cycle list with provider/source/op/time filters. |
| `GET /cycles/:cycleId` | Cycle metadata plus changed entities. |
| `GET /changes` | Cross-entity change feed for dashboards and audits. |
| `GET /facets` | Providers, sources, kinds, and operation counts for filters. |
| `GET /stats` | Churn summaries for operations and product metrics. |

#### Query options

- `source=provider|processing|reconciler`
- `provider=<provider-name>`
- `op=insert|update|delete`
- `kind=<kind>`
- `owner=<entity-ref>`
- `changedAfter=<iso>`
- `changedBefore=<iso>`
- `limit=<n>` with server-side maximum
- cursor pagination, not offset pagination for large datasets

#### Response contracts

Contracts should live in `catalog-history-common`:

```ts
type HistorySource = 'provider' | 'processing' | 'reconciler';
type HistoryOperation = 'insert' | 'update' | 'delete';

type HistoryTimelineItem = {
  id: string;
  cycleId: string;
  entityRef: string;
  source: HistorySource;
  provider: string;
  op: HistoryOperation;
  changedAt: string;
  etag?: string;
  summary: {
    ownerChanged?: boolean;
    relationsChanged?: boolean;
    statusChanged?: boolean;
    orphanChanged?: boolean;
  };
};
```

#### Permission model

- Add a read permission such as `catalogHistoryReadPermission`.
- Use Backstage permission integration so installations can restrict history access.
- Decide whether entity history reads should also respect catalog entity visibility rules.
- Default should be conservative: if permissions are enabled, history reads require explicit allow.

#### Acceptance criteria

- Backend exposes query endpoints with typed responses.
- Query service has unit tests against `InMemoryHistoryStore` or test fixtures.
- Postgres query service has integration tests for pagination, filters, as-of queries, and diffs.
- API rejects unbounded requests and enforces maximum page size.
- README documents endpoint examples and permission behavior.

### Phase 3 — Frontend plugin

**Goal:** Make history visible where Backstage users already look: the catalog entity page.

#### Frontend platform decision

The frontend plugin should target **Backstage New Frontend System (NFS)** and **Backstage UI (BUI)** only.

Implications:

- scaffold the package around NFS extension/route contributions, not the legacy plugin-system API;
- build UI with BUI components and tokens, not Material UI components;
- keep the backend client and DTOs independent of the UI layer so the API remains reusable;
- document NFS/BUI installation and entity-page registration examples only;
- verify exact NFS and BUI APIs against current Backstage docs during Phase 3 implementation.

Non-goals:

- legacy `EntityLayout.Route` integration examples;
- Material UI component variants;
- compatibility wrappers for pre-NFS Backstage apps.

#### First UI surface

Entity page tab:

```tsx
// Pseudocode only. Use current Backstage NFS extension APIs when implementing.
import { catalogHistoryPlugin } from '@kunickiaj/catalog-history';

// Register the catalog history entity-content extension in the app's NFS setup.
export default [catalogHistoryPlugin];
```

The first UI surface is an NFS entity-content contribution that appears as a History tab or equivalent catalog entity page section in apps using the New Frontend System.

#### UI capabilities

- Timeline of changes for the current entity.
- Filters for source, provider, operation, and time range.
- Version detail drawer.
- Diff between two selected versions.
- Badges for owner/relation/status/orphan changes.
- Link from a cycle to all entities changed in that cycle.
- Empty states for entities with no history.
- Error states for missing backend plugin, permission denial, and query failures.

#### Diff model

Start with pragmatic structured diffs:

- metadata diff;
- spec diff;
- relations added/removed;
- status items added/removed/changed;
- owner/memberOf/parent/orphan summary fields.

Do not build a perfect semantic diff engine first. The UI should make common catalog changes obvious and leave raw JSON available for forensics.

#### Acceptance criteria

- Frontend plugin exports NFS-compatible plugin/extension definitions, API ref, route refs where needed, and entity page history content.
- Entity page tab renders timeline from the backend API.
- Users can compare two versions.
- Loading, empty, error, and permission-denied states are implemented.
- UI uses Backstage UI components/tokens rather than Material UI.
- Docs cover NFS/BUI setup and intentionally omit legacy/MUI examples.
- Components have tests for data mapping and key UI states.
- README includes installation and entity page integration examples.

### Phase 4 — Retention and compaction

**Goal:** Let operators control storage growth without manually deleting audit data.

#### Config

```yaml
catalog:
  history:
    retention:
      enabled: true
      defaultTtl: { days: 365 }
      sources:
        provider: { days: 730 }
        processing: { days: 90 }
        reconciler: { days: 365 }
      compact:
        enabled: true
        keepDailySnapshotsFor: { days: 365 }
        keepRawChangesFor: { days: 90 }
```

#### Retention semantics

- Never delete the newest known row per `entity_ref` and `source` unless explicitly configured.
- Preserve delete tombstones long enough to reconstruct removals.
- Let installations choose different TTLs per source because processor capture is much higher volume.
- Record retention cycles or audit logs so deletions are explainable.

#### Compaction modes

- **Raw retention:** delete rows older than TTL.
- **Snapshot retention:** keep one representative row per entity/source/day or week.
- **Cycle compaction:** preserve cycle aggregates while dropping entity rows after TTL.

#### Acceptance criteria

- Retention job can run scheduled and manually.
- Dry-run mode reports rows/cycles that would be deleted.
- Tests prove newest state and required tombstones are preserved.
- README documents data-loss implications clearly.

### Phase 5 — Scale and performance hardening

**Goal:** Prove the plugin's operating envelope and avoid surprise table-growth pain.

#### Benchmark targets

Run repeatable benchmarks for:

- 10k entities;
- 100k entities;
- 1M entities if local/CI resources permit;
- provider full mutation cycles;
- processor capture cycles;
- reconciler full scans;
- common query API calls.

#### Metrics to capture

- write duration per cycle;
- rows written per second;
- reconciler scan duration;
- query p50/p95 latency;
- DB size growth per 10k changes;
- index size;
- memory use for reconciler and processor batching.

#### Database improvements to evaluate

- additional indexes for query API filters;
- composite indexes such as `(entity_ref, source, changed_at desc)`;
- BRIN indexes for time-series scans;
- optional table partitioning by `changed_at`;
- cursor pagination primitives;
- streaming reconciler diff to avoid holding the full catalog in memory.

#### Acceptance criteria

- Benchmark harness is checked in and documented.
- Results are published in docs with recommended defaults.
- Query API has explicit maximum page sizes.
- Reconciler memory usage is bounded or documented honestly.

### Phase 6 — Observability and operations

**Goal:** Make the plugin safe to operate without tailing logs and guessing.

#### Metrics

Expose or log metrics for:

- cycles recorded by source/provider/op;
- rows inserted per cycle;
- recordCycle duration;
- flush failures;
- processor dropped batches;
- reconciler duration and result counts;
- retention deleted/compacted rows;
- query API request counts and latency.

#### Health and diagnostics

- Health check that verifies schema availability.
- Diagnostic endpoint or log summary for current config.
- Startup log with enabled capture layers.
- Clear warning when no capture layers are enabled.

#### Runbooks

Document:

- history table growth;
- failed migrations;
- reconciler timeouts;
- query latency;
- retention mistakes;
- permission-denied reports;
- how to disable a layer safely.

#### Acceptance criteria

- Operational docs exist under `docs/operations/`.
- Metrics are documented with names, labels, and expected ranges.
- Tests cover failure logging where practical.

### Phase 7 — Backfill and migration tooling

**Goal:** Help adopters populate useful history at install time and migrate through package restructuring.

#### Backfill modes

- Reconciler one-shot baseline.
- Provider baseline on next provider run.
- Optional import from existing catalog table snapshots if available.

#### Migration concerns

- Existing single-package users need a package-name migration guide.
- Config keys should remain stable where possible.
- Database migrations must be idempotent and tested across old/current schemas.

#### Acceptance criteria

- Upgrade guide exists.
- Backfill command is documented.
- Migration tests cover a representative pre-workspace schema.

## Query API design notes

### As-of queries

As-of queries should operate per source unless the caller explicitly asks to combine sources. Cross-source etags are not comparable because each capture layer sees a different entity shape.

Default behavior:

- entity page UI should default to `source='reconciler'` when available;
- provider/processing rows should be visible as alternate layers;
- API should require an explicit `source` or default to `reconciler,provider,processing` precedence documented in the response.

### Diff queries

Diff input options:

- `fromId` / `toId` history row IDs;
- `fromCycleId` / `toCycleId`;
- `fromTimestamp` / `toTimestamp` with source/provider filters.

Diff output should include:

- high-level summary flags;
- structured field changes for common fields;
- JSON patch-style details for metadata/spec/status/relations;
- raw before/after payloads behind an opt-in flag.

### Pagination

Use cursor pagination for all list endpoints. Offset pagination will become painful once the history table grows.

Cursor shape can be opaque and based on `(changed_at, id)`.

## Frontend UX notes

### Entity history tab layout

```text
┌────────────────────────────────────────────────────────────┐
│ History                                                    │
│ Source: [Reconciler ▼] Provider: [All ▼] Time: [30d ▼]     │
├────────────────────────────────────────────────────────────┤
│ Timeline                                                   │
│ 2026-07-05  update  owner changed      reconciler          │
│ 2026-07-04  update  relations changed  processing          │
│ 2026-07-01  insert  first seen          provider/okta       │
├────────────────────────────────────────────────────────────┤
│ Selected version / diff drawer                             │
└────────────────────────────────────────────────────────────┘
```

### First useful UI release

Keep the first UI narrow:

1. entity timeline;
2. version detail;
3. compare two versions;
4. source/provider filters.

Do not start with global dashboards, org-chart replay, or fancy graph visualizations. Those are compelling follow-ups, not MVP requirements.

## Security and permissions

History can expose sensitive organizational data: former owners, deleted users, group membership, emails, and old annotations. Treat history reads as at least as sensitive as catalog reads.

Requirements:

- permission-aware backend API;
- no direct frontend access to database details;
- avoid exposing secret config or raw annotations by default if installations consider them sensitive;
- document that history may retain deleted user metadata beyond live catalog retention;
- make retention configuration visible in docs before calling the product production-ready.

Open decision: should history visibility exactly mirror catalog entity visibility, or should it require a stronger dedicated permission? Recommended default: dedicated history-read permission, with an option to additionally enforce catalog entity visibility.

## Scalability position

Honest product statement:

> Provider capture is incremental and should be the default low-cost path. Processor capture is useful but higher volume. Reconciler capture provides final-state correctness and drift detection, but it is a scheduled full-catalog scan and should be sized accordingly.

Before GA, publish numbers for:

- maximum tested catalog size;
- recommended reconciler frequency by catalog size;
- expected storage growth;
- query latency with default indexes;
- recommended retention defaults.

## Non-goals for the next product milestone

- Replacing Backstage catalog storage.
- Real-time UI updates over websockets.
- Full graph replay visualization.
- Dolt/ClickHouse backend implementation.
- Perfect semantic diffing for every entity kind.
- Cross-instance/federated history aggregation.

These may become future work, but they should not block the API/UI product milestone.

## Open decisions

1. **Package naming:** use scoped `@kunickiaj/*` packages now, or keep unscoped compatibility until npm publish?
2. **Workspace layout:** `packages/*` only, or `plugins/*` for Backstage-style frontend/backend plugin packages?
3. **Permission default:** dedicated history permission only, or also enforce catalog entity visibility?
4. **Frontend default source:** show reconciler truth first, or show a combined timeline across all sources?
5. **Retention default:** disabled by default for safety, or enabled with conservative TTLs?
6. **API stability:** mark endpoints experimental until frontend dogfoods them?
7. **Compatibility:** should the existing single package remain as a wrapper/meta-package for one release?

Settled frontend platform decision: `catalog-history` targets NFS and BUI only. Do not build legacy plugin-system or Material UI integration paths.

## Bead-ready breakdown

These are intentionally phrased as follow-up beads rather than implementation steps in this document.

### Epic: Productize catalog history plugin

Outcome: users can install backend + frontend packages, browse history in Backstage, query history through a supported API, and operate the plugin safely.

#### Workspace foundation

1. Convert repo to Yarn workspace root.
2. Move current package into `packages/catalog-backend-module-history`.
3. Extract `catalog-history-common` contracts.
4. Extract `catalog-history-node` backend service/store contracts.
5. Create `catalog-history-backend` package for storage, migrations, and services.
6. Update CI, Dependabot, README, and package exports for the workspace.

#### Backend query API

1. Define API DTOs and pagination contracts.
2. Implement `HistoryQueryService` interface.
3. Implement Postgres-backed entity timeline queries.
4. Implement cycle list/detail queries.
5. Implement as-of entity query.
6. Implement structured diff query.
7. Add backend router and input validation.
8. Add permission integration.
9. Document API examples.

#### Frontend plugin

1. Scaffold `catalog-history` frontend plugin package.
2. Add typed API client and API ref.
3. Build entity history timeline tab.
4. Build version detail view.
5. Build compare/diff view.
6. Add source/provider/time filters.
7. Add loading, empty, error, and permission-denied states.
8. Document entity page integration.

#### Retention and operations

1. Add retention config schema.
2. Implement retention dry-run query.
3. Implement retention scheduled job.
4. Add compaction strategy for old high-volume rows.
5. Add metrics for capture, queries, reconciler, and retention.
6. Add health/diagnostic endpoint.
7. Write operations runbook.

#### Scale validation

1. Build synthetic catalog history data generator.
2. Benchmark provider write cycles.
3. Benchmark processor batching.
4. Benchmark reconciler scans.
5. Benchmark query API latency.
6. Evaluate indexes/partitioning.
7. Publish sizing guidance.

#### Migration and release

1. Write single-package to workspace migration guide.
2. Preserve or intentionally break current exports with clear release notes.
3. Add prepack/publish validation for all packages.
4. Add example Backstage app wiring.
5. Prepare npm publish checklist.

## Suggested milestone order

1. Workspace split.
2. Backend query API.
3. Frontend entity history tab.
4. Retention and operations.
5. Scale benchmarks and tuning.
6. Release hardening.

Do not build the frontend before the query API exists. Do not build retention before the query API/UX clarifies which data users depend on. Do not claim scale readiness before benchmarks exist.
