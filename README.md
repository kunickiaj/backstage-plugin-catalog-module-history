# backstage-plugin-catalog-backend-module-history

A Backstage backend module that records every catalog `EntityProvider` mutation into a versioned history store, producing a queryable audit trail of every entity change with no impact on Backstage's hot path.

Ships with a Postgres backend in v1; designed around a pluggable `HistoryStore` interface so additional backends (Dolt, ClickHouse, etc.) can be added without changes to the wrapper.

**Status: pre-alpha.** Under active development; not yet published to npm.

## Documentation

- [Implementation plan](docs/plans/2026-05-11-catalog-history-backstage-module.md)

## License

Apache-2.0
