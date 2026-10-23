# @kunickiaj/backstage-plugin-catalog-history

An unreleased Backstage New Frontend System (NFS) plugin that adds a **History** tab to catalog entity pages. It reads recorded entity events from the catalog backend; it does not record history itself.

## Status

The package source is versioned as `0.1.0`, but is not published to npm and is not included in this repository's release or trusted-publishing setup. Use it from this workspace until a frontend package release is announced.

## Run the local preview

From the workspace root:

```sh
yarn install --immutable
yarn workspace @kunickiaj/backstage-plugin-catalog-history start
```

Open <http://localhost:3000>. The start script uses only `dev/app-config.yaml`,
which binds the preview to localhost. No backend or sign-in setup is required.

The preview uses `createDevApp`, the real NFS plugin registration and History
component, and an in-memory API override. Its banner identifies the synthetic
`component:default/example-service` entity. Ten October 2026 events cover provider,
processing, and reconciler sources, owner/lifecycle/status changes, repeated
A → B → A snapshots with distinct event IDs, update changes, and a delete with a
prior saved state. Pages contain at most five events so **Load older** can be
exercised. Nothing contacts a live catalog.

Fixtures and the API factory live under `dev/`, outside the published package.
They are demonstration data, not an alternative backend implementation.

## Add the plugin to an NFS app

Enable the backend read API first:

```yaml
catalog:
  history:
    api:
      enabled: true
```

Then add the workspace package to the app and register its default export alongside the app's existing features:

```ts
import { createApp } from '@backstage/frontend-defaults';
import catalogHistoryPlugin from '@kunickiaj/backstage-plugin-catalog-history';

export default createApp({
  features: [
    // Keep the app's existing features here.
    catalogHistoryPlugin,
  ],
});
```

The plugin contributes the entity-content extension at `history` with the title **History**, so the catalog entity page renders it as an entity tab. It uses Backstage UI (BUI) components. If the app does not already load BUI styles, import the stylesheet once in its entry point:

```ts
import '@backstage/ui/css/styles.css';
```

Do not use legacy `EntityLayout.Route` or Material UI setup for this package.

## What the tab shows

The tab lists recorded events for the current entity, newest first. Readers can filter by capture source, provider, operation, and recorded-after or recorded-before time, then load older pages. Source and operation changes apply immediately; provider input applies after 300 ms. Valid local date-and-time values convert to ISO instants and apply automatically. An invalid date or range leaves the current results in place and shows an error. **Reset filters** clears all filters and cancels a pending provider update.

Select a row by pointer or keyboard to open its exact event in the inspector; there is no separate inspect button. The responsive timeline and inspector panels show provenance and raw JSON separately. For updates with a comparable prior saved snapshot, the inspector also shows field paths with before and after values. Arrays are compared as whole values, and identity and etag fields are excluded. If no prior saved snapshot is available, the tab says so; an empty change list means there were no saved field differences.

Snapshots are stored entity states. The displayed update changes compare the retained current and immediately preceding snapshots for the same entity, source, and provider, ordered by recorded time and event ID. They are not necessarily the delta from the original capture source.

Delete events are tombstones and do not contain a current entity snapshot. When the immediately preceding saved event from the same source and provider has a snapshot, the inspector displays it as **Last recorded snapshot before deletion**, with that record's provenance and a note that it is not the deletion payload.

`Recorded at` is when the selected capture source recorded the event. It is not necessarily when the upstream provider changed the entity, so events from different sources may not reflect ingestion order.

Capture sources describe where the record came from:

- `provider` records the entity supplied by a catalog provider.
- `processing` records catalog processor output.
- `reconciler` records the served catalog view observed by reconciliation.

## Access and unavailable history

The backend requires an authenticated user. When the Backstage permission framework is enabled, the policy must explicitly allow `catalog-history.read`; otherwise the tab reports an access error.

| Result                                 | Likely cause                                                                         | Action                                                              |
| -------------------------------------- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------- |
| No recorded events match these filters | No matching retained events, or filters exclude them                                 | Reset or adjust the filters.                                        |
| Sign-in error (`401`)                  | The session is missing or expired                                                    | Sign in again and retry.                                            |
| Permission error (`403`)               | `catalog-history.read` was not explicitly allowed                                    | Ask an administrator to update the permission policy.               |
| History unavailable (`404`)            | The catalog history API is disabled or not reachable at the catalog backend base URL | Enable `catalog.history.api.enabled` and check the catalog backend. |
| Recorded event unavailable (`404`)     | The selected retained event no longer exists                                         | Refresh the timeline and select an available event.                 |

The tab is available only on an entity page that the catalog can load. The API can retain and return history for deleted entities, but this plugin does not provide standalone browsing of deleted entities.

## Public exports

This NFS- and BUI-only package exports:

- the default `catalogHistoryPlugin` plugin and named `catalogHistoryPlugin`;
- `EntityCatalogHistoryContent` for composing the tab in an NFS extension;
- `catalogHistoryApiRef` and `CatalogHistoryClient` for API integration or tests.

It also exports the plugin's API and entity-content blueprints for NFS composition. There is no arbitrary version-comparison endpoint, as-of view, global history dashboard, or standalone deleted-entity view.

For API configuration, permissions, routes, and retention behavior, read the [workspace README](../../README.md#read-history-over-http-unreleased).

## License

Apache-2.0
