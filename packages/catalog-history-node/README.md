# @kunickiaj/catalog-history-node

Backend-only contracts and service refs for the Backstage catalog history plugin family.

This package owns:

- the `HistoryStore` write contract and its row/cycle types (`EntityRow`, `CycleInput`, `CaptureSource`);
- `historyStoreServiceRef`, the plugin-scoped service ref that backend modules use to obtain a history store through Backstage DI;
- `HistoryQueryService`, the backend-only read contract for timelines, cycles, versions, as-of reads, diffs, facets, and stats;
- `InMemoryHistoryStore` and `InMemoryHistoryQueryService`, test doubles for history integrations, exported from the `@kunickiaj/catalog-history-node/testUtils` subpath so they stay out of the production contract surface.

Custom store implementations can optionally implement `HistoryStore.ensureReady()` for schema bootstrap or other startup preparation. Consumers call it before registering capture layers; simple in-memory or always-ready stores can omit it.

`CaptureSource` and `MutationType` are aliases of the isomorphic enums in
`@kunickiaj/catalog-history-common`, so backend and frontend code share one
vocabulary.

The default service factories ship with `@kunickiaj/catalog-history-backend`.
The query router/service wiring is intentionally deferred until the backend
query implementation lands, so it can be bound to the same history storage used
by the catalog writer rather than a separate plugin-scoped database.
Frontend packages must not depend on this package.

For architecture and roadmap details, see the [workspace README](../../README.md).
