# 2026-07-01. Capture Layer Scope: Provider-Origin Today, Processor-Layer and Reconciler-as-Ground-Truth Planned

**Status**: Accepted — scope framing agreed. The planned processor-layer capture, reconciler elevation, attribution model, and independent layer enablement shipped on 2026-07-05 under beads epic `hist-96j`.

**Date**: 2026-07-01

**Context**: catalog history capture | **Module**: `backstage-plugin-catalog-backend-module-history`

**Related Plans**: [Implementation plan](../plans/2026-05-11-catalog-history-backstage-module.md)

**Related ADRs**: none (first ADR)

---

## Context

Backstage's catalog produces entity truth in three distinct places. Verified against `backstage/backstage` source:

1. **Provider layer** — `EntityProviderConnection.applyMutation`. This is what `HistoryRecordingEntityProvider` wraps today. It captures the entity envelope exactly as emitted by the source system (Okta, GitHub, MS Graph, etc.), _before_ any processing. Volume is low: roughly one call per provider refresh cycle.

2. **Processor layer** — `DefaultCatalogProcessingOrchestrator.processSingleEntity` (`plugins/catalog-backend/src/processing/DefaultCatalogProcessingOrchestrator.ts`). Runs `preProcessEntity` → policy enforcement → validation → `postProcessEntity` across all registered processors in registration order. Processors can:
   - (a) **mutate the entity in place** — add annotations, labels, spec fields, inferred ownership; and
   - (b) **emit brand-new entities** via `emit(processingResult.entity(...))` that have _no provider origin at all_ — e.g. entities discovered from a Location's target.

   Emitted entities become their own `refresh_state` rows and flow through the identical `processSingleEntity` pipeline as top-level provider entities (confirmed in `DefaultCatalogProcessingEngine.ts`, which treats `result.deferredEntities` as new top-level processing items). **None of this is visible to the provider-layer wrapper.**

3. **Stitch layer** — `performStitching` (`plugins/catalog-backend/src/database/operations/stitcher/performStitching.ts`). Merges in relations (from a separate `relations` table, populated via `emit(processingResult.relation(...))`), computes the orphan flag, attaches processing-error status items, sanitizes annotation URLs, and computes the final etag/hash. Writes to `final_entities`, which is what the Catalog API actually serves. This layer is **fully internal** to `@backstage/plugin-catalog-backend` — no public hook, no emitted event for an external consumer to observe it as it happens.

### Current state — what we ship today

`HistoryRecordingEntityProvider` observes **layer 1 only**.

The project maintainer assessed this as:

- **Good enough for identity-shaped entities** — Users, Groups, org-chart data from providers like Okta / MS Graph — where the provider sits close to the source of truth and processors do little beyond passthrough.
- **Insufficient for entities whose meaningful changes happen downstream** — Components, APIs, Resources — where processors add relations, annotations, and ownership inference, and in some cases emit entities that never had a provider origin. For those kinds, the current history table can miss real changes or attribute them to the wrong moment/cause.

## Decision

Be honest about this scope split now (this ADR), and record — but **not** implement — two additions for a later phase.

1. **Processor-layer capture (planned).** A `CatalogProcessor` registered last in the processing chain (via `catalogProcessingExtensionPoint`), hooking `postProcessEntity`, diffing against a last-seen-hash per `entityRef` — the same etag-skip pattern the provider wrapper already uses — to avoid a write storm. This layer runs _once per entity per processing cycle_, which is far higher volume than once per provider `applyMutation`. Rows tagged `source: 'processing'`.

   The soft requirement is that consumers register this processor **last** so it observes post-mutation content. This ordering guarantee is **not** fully controllable across independently-added backend modules, so gaps here are expected and acceptable — they are closed by layer 3 below.

2. **Reconciler elevated to ground truth (planned).** Today the reconciler is an on-demand CLI safety net. Plan to move it toward the already-floated `coreServices.scheduler`-driven continuous mode (see the implementation plan). It is the only layer reading through the **public Catalog API**, and therefore the only one _able to observe_ true stitched state — relations, orphan flag, processing errors, final etag. Rows tagged `source: 'reconciler'`.

   **Prerequisite — schema/mapping extension.** The current row shape cannot actually _store_ stitched state: `EntityRow` / `entityToRow` persist only `metadata` and `spec` (plus derived columns), dropping top-level `relations` and `status` entirely. Worse, because stitched entities carry a `metadata.etag` computed over the full final entity (including relations), a relation-only or processing-error-only change would flip the etag and record a "modified" row whose stored `metadata`/`spec` are byte-identical — an unexplainable diff with no historical relation/error data. Before reconciler rows can claim ground-truth status, the schema and mapping must be extended to persist stitched-only fields (at minimum `relations`, `status`/error items, and the orphan flag). Until then, reconciler capture detects _that_ the served entity changed, not _what_ changed at the stitch layer.

3. **Attribution model (planned).** Every recorded row/cycle should carry `source: 'provider' | 'processing' | 'reconciler'` so consumers can distinguish:
   - _what the source system said_ (provider),
   - _what processing did to it_ (processing), and
   - _what the catalog actually served_ (reconciler).

   This tri-source attribution is more valuable than trying to collapse everything into a single hook.

4. **Independent per-layer enablement (planned).** Provider-layer and processor-layer capture must be independently toggleable, not an all-or-nothing package. Processors run far more frequently than providers — once per entity per processing cycle vs. once per provider `applyMutation` — so an operator who only cares about identity-shaped entities (Users/Groups via Okta/MS Graph) should be able to run provider-only capture and never pay the processor-layer write/storage cost. Conversely, an operator chasing Component/API drift should be able to run processor-only, or both. Config surface follows the existing `catalog.history.enabled` pattern (see README), e.g. `catalog.history.provider.enabled` and `catalog.history.processing.enabled`, each defaulting independently — provider capture defaults on (matches today's shipped behavior), processor capture defaults off (opt-in, given the volume/cost profile). The reconciler remains a separate on/off knob regardless of which of the two are enabled, since it serves a different purpose (ground-truth backstop) and has its own cost profile (full catalog read via the public API).

> **Scope guard:** This ADR does **not** change v1 shipping behavior (provider-layer-only). It scopes what "sufficient" means today and sets expectations for what comes next. The `source` column addition to `catalog_history_cycles` / `catalog_history_entities` and the new processor are left to a future phase to design. (Note: today the reconciler is distinguished only by overloading the existing `provider` value `'reconciler'`; the planned `source` column supersedes that overloading.)

## Alternatives Considered

### Option 1: Single capture hook at stitch time

- **Pros**: Would observe the exact truth the Catalog API serves — relations, orphan flag, final etag — in one place.
- **Cons**: The stitch layer (`performStitching`) is fully internal to `@backstage/plugin-catalog-backend`.
- **Why rejected**: Not possible today. There is no public extension point or emitted event for stitch-time observation in OSS Backstage. The reconciler-through-the-public-API approach (layer 3) is the closest attainable substitute.

### Option 2: Processor-only capture (drop the provider layer)

- **Pros**: Captures post-processing content, closer to served truth than provider origin.
- **Cons**: Loses cheap, low-volume, clearly-attributed origin data; higher write volume; can't tell "what the source system said" from "what processing did."
- **Why rejected**: The provider layer is cheap (once per refresh vs once per entity per cycle), clearly attributed, and sufficient for identity-type entities. Dropping it discards useful signal that is cheaper to store and query.

### Option 3: Do nothing — ship provider-layer only, forever

- **Pros**: Zero additional work; no write-volume increase; no new integration requirement.
- **Cons**: Misses real, meaningful changes for Components / APIs / Resources, where truth is manufactured downstream of the provider.
- **Why rejected**: Directly conflicts with the maintainer's explicit concern about downstream-shaped entities. Acceptable for v1 as an _interim_ state, not as a permanent design.

## Consequences

### Positive

- Documentation is honest today about exactly what layer 1 does and does not capture, per entity shape.
- The tri-source attribution model (`provider` / `processing` / `reconciler`) gives consumers a clear provenance signal instead of a lossy single-hook approximation.
- The reconciler becomes the ground-truth backstop that reflects true stitched state, closing gaps left by unguaranteed processor ordering.
- Independent per-layer enablement lets operators pay only for the capture cost they actually need — provider-only for identity-entity use cases, processor-layer opt-in for Component/API drift tracking, without an all-or-nothing tradeoff.

### Negative

- **Write volume increases meaningfully** once processor-layer capture ships: per-entity-per-cycle instead of per-provider-mutation.
- Requires **per-entity hash/etag skip logic** reused and extended from the provider wrapper to keep the processor layer from producing a write storm.
- Introduces a **new integration requirement**: consumers must register the capture processor _last_ (to be documented in the README when the processor ships). This ordering is not fully enforceable across independently-added backend modules, so processor-layer gaps are expected — accepted as a known limitation closed by the reconciler.
- A future phase must design the `source` column addition to `catalog_history_cycles` / `catalog_history_entities` and the new processor. No schema change is made in this ADR.
- Elevating the reconciler to ground truth requires extending `EntityRow` / `entityToRow` and the history schema to persist stitched-only fields (`relations`, `status`, orphan flag) — otherwise reconciler rows record etag flips with no explanatory data for relation-only or error-only changes.
- Independent enablement adds a config/testing surface: each layer combination (provider-only, processor-only, both, neither-but-reconciler) needs to behave correctly and be covered by tests once implemented, rather than a single on/off switch.

### Neutral / non-impact

- No change to existing v1 schema in this ADR — the plan is recorded only.
- This ADR does not block or alter current v1 shipping (provider-layer-only).

## Implementation Notes

- Reuse the provider wrapper's etag-skip pattern for the processor-layer diff, keyed on `entityRef` → last-seen hash.
- Prefer `metadata.etag` when present; otherwise a stable hash of canonicalized `metadata + spec`, consistent with the provider wrapper.
- Elevating the reconciler to continuous mode should ride the `coreServices.scheduler` path already outlined in the implementation plan (distributed lock across replicas, no external auth token, in-process catalog service as the `EntityFetcher`).
- Defer the `source` column design (enum, indexes, backfill of existing rows) to the future phase that implements processor-layer capture.
- Defer exact config key names/shape for per-layer enablement to the implementing phase; `catalog.history.provider.enabled` / `catalog.history.processing.enabled` above are illustrative, not final.
- The stitched-field persistence design (columns vs JSONB for `relations`/`status`, orphan flag representation, whether provider/processing rows leave them NULL) belongs to the same future phase as the `source` column — they land together, since both are prerequisites for meaningful reconciler ground-truth rows.
