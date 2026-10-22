# @kunickiaj/backstage-plugin-catalog-history-storage-node

Storage, migrations, and history service factories for the Backstage catalog history plugin family.

This package is a `node-library`, not a backend plugin.

This package owns:

- the Postgres history schema migrations and `ensureSchema` bootstrap;
- `PostgresHistoryStore`, the Postgres implementation of the `HistoryStore` contract from `@kunickiaj/backstage-plugin-catalog-history-node`;
- `historyStoreServiceFactory`, the default factory for `historyStoreServiceRef`, which resolves the consuming plugin's database and provides a schema-aware store.

Add this factory when you want the default Postgres implementation directly:

```ts
import { historyStoreServiceFactory } from '@kunickiaj/backstage-plugin-catalog-history-storage-node';

backend.add(historyStoreServiceFactory);
```

The `@kunickiaj/backstage-plugin-catalog-backend-module-history` default export already includes this factory. If you need custom storage, register your own `createServiceFactory({ service: historyStoreServiceRef, ... })` and use the named `catalogModuleHistory` export instead of the module package's default loader.

For compatibility, the default factory still honors the deprecated `catalog.history.database` override. Prefer a custom service factory for new dedicated-storage setups.

The productization roadmap discusses future query service and HTTP API work; this package currently remains a storage Node library.

For architecture and roadmap details, see the [workspace README](../../README.md).
