# @kunickiaj/catalog-history-backend

Storage, migrations, and history service factories for the Backstage catalog history plugin family.

This package owns:

- the Postgres history schema migrations and `ensureSchema` bootstrap;
- `PostgresHistoryStore`, the Postgres implementation of the `HistoryStore` contract from `@kunickiaj/catalog-history-node`;
- `historyStoreServiceFactory`, the default factory for `historyStoreServiceRef`, which resolves the consuming plugin's database, runs migrations, and provides a ready store.

The future history query service and HTTP API from the productization roadmap will also live here; at that point this package is expected to become a full backend plugin.

For architecture and roadmap details, see the [workspace README](../../README.md).
