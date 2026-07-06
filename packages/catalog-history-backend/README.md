# @kunickiaj/catalog-history-backend

Storage, migrations, and history service factories for the Backstage catalog history plugin family.

This package owns:

- the Postgres history schema migrations and `ensureSchema` bootstrap;
- `PostgresHistoryStore`, the Postgres implementation of the `HistoryStore` contract from `@kunickiaj/catalog-history-node`;
- `historyStoreServiceFactory`, the default factory for `historyStoreServiceRef`, which resolves the consuming plugin's database and provides a schema-aware store.

Add this factory when you want the default Postgres implementation directly:

```ts
import { historyStoreServiceFactory } from '@kunickiaj/catalog-history-backend';

backend.add(historyStoreServiceFactory);
```

The `backstage-plugin-catalog-backend-module-history` default export already includes this factory. If you need custom storage, register your own `createServiceFactory({ service: historyStoreServiceRef, ... })` and use the named `catalogModuleHistory` export instead of the module package's default loader.

For compatibility, the default factory still honors the deprecated `catalog.history.database` override. Prefer a custom service factory for new dedicated-storage setups.

The future history query service and HTTP API from the productization roadmap will also live here; at that point this package is expected to become a full backend plugin.

For architecture and roadmap details, see the [workspace README](../../README.md).
