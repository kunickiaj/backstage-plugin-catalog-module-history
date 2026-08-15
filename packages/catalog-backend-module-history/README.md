# backstage-plugin-catalog-backend-module-history

Backstage backend module that records catalog entity changes into a versioned history store.

The default backend feature loader installs both the catalog backend module and the default Postgres `historyStoreServiceRef` factory from `@kunickiaj/catalog-history-backend`.

```ts
backend.add(import('backstage-plugin-catalog-backend-module-history'));
```

Advanced storage overrides should register their own `historyStoreServiceRef` factory and import the named module instead of the default loader:

```ts
backend.add(catalogModuleHistory);
backend.add(myHistoryStoreServiceFactory);
```

Provider wrappers should be configured in the same catalog module where the provider is created: depend on `historyStoreServiceRef`, then pass the resolved store into `HistoryRecordingEntityProvider`. The legacy `catalog.history.database` setting remains as a deprecated compatibility path honored by the default store factory, so all consumers of the injected store share the same connection.

For current usage and productization roadmap details, see the [workspace README](../../README.md).
