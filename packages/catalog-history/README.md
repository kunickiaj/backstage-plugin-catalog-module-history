# @kunickiaj/backstage-plugin-catalog-history

Backstage New Frontend System (NFS) plugin that adds a **History** tab to catalog entity pages and a **Catalog history** page at `/catalog-history`. It reads recorded entity events from the catalog backend; it does not record history itself.

## Features introduced in `0.2.0`

The History tab, catalog-history page, and NFS default-plugin registration are introduced in `0.2.0`. The setup below works from the workspace preview and from an installed package.

## Run the local preview

From the workspace root:

```sh
yarn install --immutable
yarn workspace @kunickiaj/backstage-plugin-catalog-history start
```

Open <http://localhost:3000>. The start script uses only `dev/app-config.yaml`,
which binds the preview to localhost. No backend or sign-in setup is required.

The preview uses `createDevApp`, the real NFS plugin registration and History
components, and an in-memory API override. Its banner identifies synthetic entities,
including `component:default/example-service`. Ten October 2026 events cover provider,
processing, and reconciler sources, owner/lifecycle/status changes, repeated
A → B → A snapshots with distinct event IDs, update changes, and a delete with a
prior saved state. Open `/catalog-history` to browse multiple entities, including a
deleted entity. Pages contain at most five events so **Load older** can be exercised.
Nothing contacts a live catalog.

Fixtures and the API factory live under `dev/`, outside the published package.
They are demonstration data, not an alternative backend implementation.

## Add the plugin to an NFS app

From the host repository root, install the package in the app workspace:

```sh
yarn --cwd packages/app add '@kunickiaj/backstage-plugin-catalog-history@^0.2.0'
```

Replace `packages/app` when the app workspace is elsewhere. Use the published package version in a host app; do not use `workspace:^` for this dependency.

Enable the backend read API first:

```yaml
catalog:
  history:
    api:
      enabled: true
```

Then register the default export alongside the app's existing features:

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

The plugin contributes the entity-content extension at `history` with the title **History**, so the catalog entity page renders it as an entity tab. It also registers the `/catalog-history` page with navigation metadata and the title **Catalog history**.

The default plugin registers `catalogHistoryApiRef` with Backstage discovery and fetch APIs, so no separate API factory wiring is required.

This plugin uses Backstage UI (BUI), with a dependency on `@backstage/ui@^0.19.0`. If the host app does not already declare BUI, add a version compatible with both the host and that range rather than upgrading arbitrarily.

If BUI styles are not already loaded, import the stylesheet once in the app entry point:

```ts
import '@backstage/ui/css/styles.css';
```

Do not use legacy `EntityLayout.Route` or Material UI setup for this package.

## Synthetic preview screenshots

These fixture-based previews show the UI only. They do not prove a live host-app installation, authentication flow, or end-to-end backend integration.

![Catalog history page browsing events for multiple entities, including a deleted team](https://raw.githubusercontent.com/kunickiaj/backstage-plugin-catalog-module-history/v0.2.0/docs/catalog-history-browse.png)

- [Entity History tab preview](https://raw.githubusercontent.com/kunickiaj/backstage-plugin-catalog-module-history/v0.2.0/docs/catalog-history-preview.png)
- [Deletion inspector preview](https://raw.githubusercontent.com/kunickiaj/backstage-plugin-catalog-module-history/v0.2.0/docs/catalog-history-deletion.png)

## Browse entity and catalog history

The **History** tab lists recorded events for the current entity, newest first. Its event table identifies the affected kind, namespace, and name. It can filter by capture source, provider, operation, and recorded-after or recorded-before time, then load older pages. It deliberately has no entity-reference or kind filter.

The **Catalog history** page lists retained events across all entities, including entities deleted from the live catalog. Its event table identifies the affected kind, namespace, and name. Readers can filter by exact entity reference, kind, capture source, provider, operation, and recorded time. An entity short name is interpreted as `Component:default/<name>`; a canonical reference remains exact. Kind matching is case-insensitive and custom kinds are valid.

Text filters apply after 300 ms. Dropdowns and valid local date-and-time values apply immediately; valid dates convert to ISO instants. An invalid date or range leaves the current results in place and shows an error. Filter changes reset to the first page. **Reset filters** clears all filters and cancels pending text input.

Select a row by pointer or keyboard to open its exact event in the inspector; there is no separate inspect button. The inspector uses the selected event's entity reference and ID, so it opens the correct record from either view. The responsive timeline and inspector panels show provenance and raw JSON separately. For updates with a comparable prior saved snapshot, the inspector also shows field paths with before and after values. Arrays are compared as whole values, and identity and etag fields are excluded. If no prior saved snapshot is available, the view says so; an empty change list means there were no saved field differences.

Snapshots are stored entity states. The displayed update changes compare the retained current and immediately preceding snapshots for the same entity, source, and provider, ordered by recorded time and event ID. They are not necessarily the delta from the original capture source.

Delete events are tombstones and do not contain a current entity snapshot. When the immediately preceding saved event from the same source and provider has a snapshot, the inspector displays it as **Last recorded snapshot before deletion**, with that record's provenance and a note that it is not the deletion payload.

Direct catalog deletion and location unregistration do not guarantee a recorded delete event, even though earlier retained events can remain visible on the **Catalog history** page. Read the [known deletion-capture limitation](../../README.md#known-deletion-capture-limitation) before treating retained history as a complete deletion audit.

`Recorded at` is when the selected capture source recorded the event. It is not necessarily when the upstream provider changed the entity, so events from different sources may not reflect ingestion order.

Capture sources describe where the record came from:

- `provider` records the entity supplied by a catalog provider.
- `processing` records catalog processor output.
- `reconciler` records the served catalog view observed by reconciliation.

### Structured snapshots in unreleased source

The current workspace adds read-only sections for recorded entity fields, metadata, spec, relations, and status items. Owner, memberships, parent, and orphan status come from the selected saved snapshot, without filling gaps from spec fields or the current catalog entity.

Missing fields show **Not recorded** or a category-specific missing message. Recorded empty lists and objects have explicit empty states; an orphan value of `false` shows **No**. JSON scalars preserve their types, and nested values appear as keyboard-focusable JSON blocks within their fields. The complete raw snapshot remains available separately.

For a deletion, these sections appear only within **Last recorded snapshot before deletion** when that earlier snapshot exists. They do not describe a deletion payload or a current entity state.

### Timeline badges in unreleased source

Update rows can show **Owner changed**, **Relations changed**, **Status changed**, and **Orphan changed** beneath the operation. Each badge requires an explicit `true` summary flag from the API; missing or false flags render no badge and do not imply that the event has no other changes. Inserts and deletes do not show these comparison badges.

The default Postgres backend supplies summaries for the entity timeline and current event detail. Its global feed and version lists still return empty summaries; older and custom APIs can also omit them. The UI does not fetch each event or compare loaded rows to fill those gaps. Badge comparisons describe known fields in adjacent saved events from the same source and provider, not the original upstream mutation.

## Access and unavailable history

The backend requires an authenticated user. When the Backstage permission framework is enabled, the policy must explicitly allow `catalog-history.read`; otherwise the tab reports an access error.

| Result                                 | Likely cause                                                                  | Action                                                                                |
| -------------------------------------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| No recorded events match these filters | No matching retained events, or filters exclude them                          | Reset or adjust the filters.                                                          |
| Sign-in error (`401`)                  | The session is missing or expired                                             | Sign in again and retry.                                                              |
| Permission error (`403`)               | `catalog-history.read` was not explicitly allowed                             | Ask an administrator to update the permission policy.                                 |
| History unavailable (`404`)            | The API is disabled, unreachable, or the backend is older and lacks the route | Enable `catalog.history.api.enabled`, then check the catalog backend version and URL. |
| Catalog history unavailable (`501`)    | A custom history API does not implement the cross-entity change feed          | Upgrade the custom API. The entity tab can still work.                                |
| Recorded event unavailable (`404`)     | The selected retained event no longer exists                                  | Refresh the timeline and select an available event.                                   |

The tab is available only on an entity page that the catalog can load. The **Catalog history** page can browse retained events for deleted entities. When permissions are enabled, an explicit allow for `catalog-history.read` grants access to all retained history; it is not limited to current catalog visibility.

## Public exports

This NFS- and BUI-only package exports:

- the default `catalogHistoryPlugin` plugin and named `catalogHistoryPlugin`;
- `EntityCatalogHistoryContent` for composing the tab in an NFS extension;
- `catalogHistoryApiRef` and `CatalogHistoryClient` for API integration or tests.

It also exports the plugin's API and entity-content blueprints for NFS composition. The default plugin automatically registers the standalone page. There is no cycle, stats, facets, as-of, or arbitrary version-comparison view.

Current source also exposes optional `CatalogHistoryApi.getProviders(request)` and the corresponding `CatalogHistoryClient` method for [retained-provider discovery](../../README.md#provider-discovery-in-unreleased-source). Custom APIs can omit it. It returns server-matched names for suggestions; consumers still apply a selected full name through the existing exact `provider` filter. HTTP `404` and `501` identify unavailable discovery, while `401` and `403` are authentication/access errors. The client forwards failures without caching or automatic fallback.

For API configuration, permissions, routes, and retention behavior, read the [workspace README](../../README.md#read-history-over-http-in-020).

## License

Apache-2.0
