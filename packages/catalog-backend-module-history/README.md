# @kunickiaj/backstage-plugin-catalog-backend-module-history

Backstage backend module that records catalog entity changes into a versioned history store.

The default backend feature loader installs the catalog backend module and the default Postgres `historyStoreServiceRef` factory from `@kunickiaj/backstage-plugin-catalog-history-storage-node`.

```ts
backend.add(
  import('@kunickiaj/backstage-plugin-catalog-backend-module-history'),
);
```

Advanced storage overrides should register their own `historyStoreServiceRef` factory and import the named module instead of the default loader:

```ts
backend.add(catalogModuleHistory);
backend.add(myHistoryStoreServiceFactory);
```

Provider wrappers should be configured in the same catalog module where the provider is created: depend on `historyStoreServiceRef`, then pass the resolved store into `HistoryRecordingEntityProvider`. Enabled provider capture requires a store that implements `HistoryStore.withProviderMutation(provider, callback)`. The wrapper uses that callback to load current etags, forward the catalog mutation, and record the cycle while coordinating the named provider across backend instances. A store without this capability forwards the original mutation unchanged and logs that recording was skipped. The legacy `catalog.history.database` setting remains as a deprecated compatibility path honored by the default store factory, so all consumers of the injected store share the same connection.

## Removed compatibility re-exports in `0.5.0`

Releases from `0.2.0` through `0.4.0` re-exported store contracts and storage from this package. `0.5.0` removes them. Import them from their own packages:

| Symbols                                                                                                          | Import from                                                |
| ---------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| `CaptureSource`, `CurrentEtag`, `CycleInput`, `EntityRow`, `HistoryStore`, `MutationType`, `RECONCILER_PROVIDER` | `@kunickiaj/backstage-plugin-catalog-history-node`         |
| `ensureSchema`, `historyStoreServiceFactory`, `PostgresHistoryStore`                                             | `@kunickiaj/backstage-plugin-catalog-history-storage-node` |

```ts
import type { HistoryStore } from '@kunickiaj/backstage-plugin-catalog-history-node';
import { PostgresHistoryStore } from '@kunickiaj/backstage-plugin-catalog-history-storage-node';
```

The default backend loader and the capture exports, such as `HistoryRecordingEntityProvider`, stay in this package.

## Optional HTTP read API in `0.2.0`

Set `catalog.history.api.enabled` to `true` to serve authenticated entity-history routes from this catalog module. The routes use the same history store as recording; no separate backend plugin or database is needed.

```yaml
catalog:
  history:
    api:
      enabled: true
```

The routes are `GET /api/catalog/history/entities/:kind/:namespace/:name/history`, `GET /api/catalog/history/entities/:kind/:namespace/:name/versions`, and `GET /api/catalog/history/entities/:kind/:namespace/:name/versions/:id`. The detail route returns the exact recorded event for the canonical entity reference and row ID; use the timeline item's `id`, not an etag. They require the `catalog-history.read` permission (`catalogHistoryReadPermission` from `@kunickiaj/backstage-plugin-catalog-history-common`). With the permission framework enabled, only an explicit `ALLOW` permits access; without it, authenticated users use Backstage's normal permission behavior.

Custom `historyStoreServiceRef` factories must provide the optional query capability, including `getEntityVersion`, when this setting is enabled. Otherwise backend startup fails. Keep the API disabled when a custom store only supports recording.

## Optional full-to-delta conversion

`HistoryRecordingEntityProvider` defaults to forwarding provider mutations unchanged. With `convertFullToDelta: true`, full snapshots with an existing history baseline become deltas: every incoming entry goes into `added`, with its `locationKey` intact, and history refs missing from the snapshot go into `removed`. The catalog compares each entry's full content and key; the wrapper does not use history etags to filter catalog writes. This preserves key-only changes and content changes even when a provider reuses an etag, but does not avoid comparing unchanged entries.

History still classifies changes using entity etags, so its counts can report an entry as unchanged even when the catalog sees a key or content change. History is best-effort, not a deletion safety check: a missing history ref cannot produce an inferred removal. An empty baseline or a failed baseline read forwards the original full mutation instead.

With `forceFullEvery` configured, the first full after the wrapper starts is forwarded unchanged even when history already has a baseline. Each successfully forwarded full starts the interval, including a fallback full after a history-read failure; rejected catalog writes and native deltas do not reset it. The first full received at or after the interval expires is forwarded unchanged to reconcile against the catalog's own provider refs. This is not a background timer. Keep conversion disabled when deletions must always use the catalog's current provider refs.

Native `full` and `delta` mutations remain unchanged unless conversion is enabled. Conversion is opt-in. A converted full reads its history baseline before it forwards. A missing history reference cannot infer a removal after a failed capture. When conversion is off, original full mutations continue to reconcile the catalog. `forceFullEvery` also supplies periodic original full mutations when conversion is on.

### Catalog regression tests

The provider tests include an in-memory SQLite integration with the pinned catalog backend development dependency. Run them from the workspace root with `env CI=1 yarn test packages/catalog-backend-module-history/src/provider --watch=false --runInBand`. They do not require a running catalog or an external database.

For current usage and productization roadmap details, see the [workspace README](../../README.md).

## Provider mutation ordering in `0.5.0`

A provider can call `applyMutation` again before an earlier call finishes, for example when a webhook push arrives during a scheduled full refresh. The default Postgres store uses provider-scoped PostgreSQL exclusion to serialize the baseline read, catalog forward, history recording, and commit for that provider across backend instances. Every catalog forward for one provider waits for its earlier history work, even when conversion is off. Other providers can proceed independently, subject to database pool capacity.

Pool acquisition and provider-lock acquisition use 5-second attempts. Pool exhaustion and provider-lock contention retry before the callback starts, so a busy provider never causes a catalog write to bypass coordination. A waiter can remain queued until the holder completes, its process exits, or the store shuts down. History SQL statements inside coordination have a 30-second limit. These limits exclude schema initialization and the local queue. The store does not put a lease or whole-operation deadline around the catalog call because the generic catalog API cannot cancel or fence a write. Other coordination failures, such as an unavailable database, cause the wrapper to forward the original mutation once and record nothing. If recording fails after a successful forward, it logs the failure and does not fail ingestion or forward the mutation again. A catalog rejection propagates unchanged and produces no history record. The store never retries the callback or a catalog write.

PostgreSQL releases the exclusion when a process crashes. A crash after a catalog forward and before history recording can leave that event absent from history. Losing the history database connection while the catalog call is running can also break the exclusion, so ordering cannot be guaranteed for that uncertain interval. Catalog and history writes do not share an atomic transaction.

The additive migration and custom-store requirements are described in [storage coordination](../catalog-history-backend/README.md#provider-mutation-coordination-in-050). Every participating backend must upgrade before relying on this order. The change does not repair incorrectly ordered existing history.
