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

Provider wrappers should be configured in the same catalog module where the provider is created: depend on `historyStoreServiceRef`, then pass the resolved store into `HistoryRecordingEntityProvider`. The legacy `catalog.history.database` setting remains as a deprecated compatibility path honored by the default store factory, so all consumers of the injected store share the same connection.

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

### Catalog regression tests

The provider tests include an in-memory SQLite integration with the pinned catalog backend development dependency. Run them from the workspace root with `env CI=1 yarn test packages/catalog-backend-module-history/src/provider --watch=false --runInBand`. They do not require a running catalog or an external database.

For current usage and productization roadmap details, see the [workspace README](../../README.md).
