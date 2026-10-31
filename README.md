# Catalog history for Backstage

This plugin adds a **History** tab to Backstage entity pages and a catalog-wide view of recorded changes. You can inspect saved snapshots, compare events, and follow a change back to its provider or capture run.

![Catalog history development preview showing a selected event](docs/screenshots/catalog-history.png)

The screenshot uses synthetic preview data. See the [screenshot gallery](docs/screenshots/README.md) for the entity timeline, event comparison, and reproduction steps.

## Try the frontend preview

The workspace requires Node 22 or 24 and Yarn 4.5. From the workspace root, install dependencies and start the preview:

```sh
yarn install --immutable
yarn workspace @kunickiaj/backstage-plugin-catalog-history start
```

Open <http://localhost:3000>. The preview uses in-memory synthetic data and does not require a backend or sign-in. See the [frontend package README](packages/catalog-history/README.md#run-the-local-preview) for its fixture coverage.

## Install and register the backend module

```sh
yarn add @kunickiaj/backstage-plugin-catalog-backend-module-history @kunickiaj/backstage-plugin-catalog-history-node
```

Add the default module to your Backstage backend:

```ts
import { createBackend } from '@backstage/backend-defaults';

const backend = createBackend();

// ... your other plugins / modules

backend.add(import('@backstage/plugin-catalog-backend'));
backend.add(
  import('@kunickiaj/backstage-plugin-catalog-backend-module-history'),
);

backend.start();
```

History uses PostgreSQL in the catalog plugin's database by default.

> [!IMPORTANT]
> Registering the module does not wrap your providers. Follow the [provider wiring steps](docs/reference.md#provider-capture), or enable processing capture or reconciliation in the [configuration](docs/reference.md#configuration).

For the History tab and catalog-wide page, [add the frontend plugin](packages/catalog-history/README.md#add-the-plugin-to-an-nfs-app) and enable the [history API](docs/reference.md#http-api). The UI uses Backstage's New Frontend System.

For existing installations, follow the [migration guide](docs/migration.md) before upgrading.

## Choose capture paths

- **Provider capture** records `full` and `delta` mutations from wrapped providers, such as an identity provider supplying Users and Groups.
- **Processing capture** records processor mutations and processor-emitted entities. It cannot see deletes or guarantee registration order across independent modules.
- **Reconciliation** periodically reads the public Catalog API and records the served catalog, including relations, status items, and orphan state.

History starts when capture is enabled. The plugin cannot reconstruct earlier changes.

## Limitations

<a id="known-deletion-capture-limitation"></a>

- Direct entity deletion and location unregistration can bypass capture. Earlier events can remain readable without a corresponding delete event. See [deletion capture](docs/reference.md#known-deletion-capture-limitation).
- History writes are best effort. A history failure does not reject a catalog mutation that already succeeded. Slow history can delay later catalog writes for the same provider. See [provider coordination](packages/catalog-backend-module-history/README.md#provider-mutation-ordering-in-050).
- History reads require an authenticated user and `catalog-history.read`. This permission grants access to all retained history, including deleted entities, without applying current catalog visibility rules.

## Documentation

- [Configuration, API, storage, metrics, reconciliation, and retention reference](docs/reference.md)
- [Frontend integration and behavior](packages/catalog-history/README.md)
- [PostgreSQL storage and custom-store capabilities](packages/catalog-history-backend/README.md)
- [Migration guide](docs/migration.md)
- [Storage sizing and retention planning](docs/sizing.md)
- [Operations runbook](docs/operations.md)
- [Observability](docs/observability.md)
- [Release notes](docs/releases/)
- [Contributing](CONTRIBUTING.md)
