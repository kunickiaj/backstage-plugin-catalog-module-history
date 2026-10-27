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

To place the History tab after your other entity tabs, list those `entity-content` extensions in `app.extensions` and put `entity-content:catalog-history` last. Backstage orders extensions named in app config by their position in that list:

```yaml
app:
  extensions:
    - entity-content:catalog/overview
    # Your other entity tabs, in display order.
    - entity-content:catalog-history
```

If the tab belongs to an entity page group, Backstage sorts the group's tabs by title unless the group sets `contentOrder: natural`. Check the rendered entity page after changing the order. To remove the tab, set `entity-content:catalog-history: false`.

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

### Structured snapshots in `0.3.0`

The current workspace adds read-only sections for recorded entity fields, metadata, spec, relations, and status items. Owner, memberships, parent, and orphan status come from the selected saved snapshot, without filling gaps from spec fields or the current catalog entity.

Missing fields show **Not recorded** or a category-specific missing message. Recorded empty lists and objects have explicit empty states; an orphan value of `false` shows **No**. JSON scalars preserve their types, and nested values appear as keyboard-focusable JSON blocks within their fields. The complete raw snapshot remains available separately.

For a deletion, these sections appear only within **Last recorded snapshot before deletion** when that earlier snapshot exists. They do not describe a deletion payload or a current entity state.

### Timeline badges in `0.3.0`

Update rows can show **Owner changed**, **Relations changed**, **Status changed**, and **Orphan changed** beneath the operation. Each badge requires an explicit `true` summary flag from the API; missing or false flags render no badge and do not imply that the event has no other changes. Inserts and deletes do not show these comparison badges.

The default Postgres backend supplies summaries for the entity timeline and current event detail. Its global feed and version lists still return empty summaries; older and custom APIs can also omit them. The UI does not fetch each event or compare loaded rows to fill those gaps. Badge comparisons describe known fields in adjacent saved events from the same source and provider, not the original upstream mutation.

### Provider suggestions in `0.3.0`

Open **Provider** to discover names represented in retained history for the applied filters. Suggestions come from the server across retained rows, not only the loaded event page or current provider registrations. Names from deleted entities can still appear. With no unfinished search, opening the picker shows the first names in scope, even when a provider is already selected.

Typing searches by a case-insensitive literal prefix after 300 ms; `%`, `_`, and backslash are ordinary characters. This is not fuzzy or substring matching. Choose a returned full name to apply the existing exact provider filter. Its case and whitespace remain unchanged, including when other filters are applied. While editing, the previous provider stays applied and is identified below the field; clearing removes it. Only the first 25 suggestions are shown. **Type more to narrow** means more matching names exist, not that the current suggestions are the complete set.

Missing optional `getProviders` support or a `404`/`501` discovery response switches to **Exact provider name; suggestions unavailable.** That textbox retains the original exact-entry debounce behavior. A successful empty search is supported discovery with no matches, not a reason to switch modes. `401`/`403` remain access errors, and other failures show a retry action. Reset clears the editor and pending work; stale responses after typing, context changes, API replacement, or unmount are ignored. Ignoring a response does not cancel its server SQL.

Stored empty provider names are displayed but cannot be selected because the existing history API rejects an empty `provider` parameter. Nonempty whitespace names have escaped labels for readability and retain their original value when selected.

### Entity and Kind pickers in `0.3.0`

The standalone page's **Entity** picker searches retained entity names by literal, case-insensitive prefix after 300 ms. Choose a returned identity to apply its exact reference without typing the reference yourself. Options show name, kind, and namespace so equal names remain distinguishable. Retained delete-only identities are included; the picker does not query the live catalog or infer current/deleted status.

Selecting an Entity also sets its Kind in one filter update. Choosing an incompatible Kind clears Entity; **All kinds** removes only the kind predicate and keeps Entity. Clearing Entity leaves Kind selected. While editing either search, the previous selection stays applied. Enter or blur does not turn unfinished search text into a filter.

Entity suggestions use only the applied kind, source, exact provider, operation, and valid time filters, never the selected reference or unfinished drafts. Only the first 25 suggestions are shown; a narrowing hint means more matches exist. **Kind** searches all retained kinds independently of those filters and uses **Load more kinds** to reach later pages. Loading kind suggestions does not page the event list.

Each control handles compatibility independently. Missing `getEntities` or `getKinds`, or its `404`/`501` response, retains the corresponding legacy textbox. Entity-reference text keeps its exact-match and default-Component/default-namespace behavior; Kind text keeps its existing matching behavior. A discovery prefix is not automatically applied on fallback. `401`/`403` remain access errors, successful empty responses remain supported discovery, and other failures offer Retry. Reset clears selections and pending work; stale results cannot restore an old selection or append an obsolete kind page.

The entity-scoped History tab does not show or call these global discovery controls. Existing provider selections preserve their original case and whitespace through Entity and Kind changes.

### Recording cycle navigation in `0.3.0`

Choose an inspector's **Cycle ID** to open its **Recording cycle**, meaning one recorded capture run or batch. The view shows the saved provider, capture source, mutation type, start/finish times, and recorded totals. **Changed entities** lists retained event metadata across the cycle; choose a row by pointer or keyboard to inspect that row's exact entity reference and event ID. It fetches a snapshot only after selection.

**Load more changes** follows the cycle's opaque change cursor. A failed later page keeps the header and loaded rows, and Retry repeats the failed page. Recorded totals do not become page totals. An empty change page says that no retained changed events are available; it does not imply that the capture run recorded no activity. Refresh restarts the page and clears inspector selection. Old results from a different cycle, API instance, or refresh are ignored.

Links resolve through the plugin's public history route, so hosts can override the page mount. Direct `?cycleId=…` URLs work on that page. A missing ID shows an error without making a request. **Back to catalog history** removes only `cycleId`; the existing filter form stays mounted but hidden in cycle mode, preserving its values and exact selections. It does not load the global event feed while viewing a cycle. Browser Back also works.

An API without optional `getCycle`, or an unresolved public history route, keeps the cycle ID as plain text. Missing event cycle context shows **Not recorded**. A `501` cycle response shows unsupported-cycle guidance; `404` shows an unavailable-cycle message without guessing whether the row or route is absent. Access failures remain sign-in or permission messages, and other failures offer Retry. The pre-deletion saved snapshot links to its own cycle, preserving that record's source and provider.

### Compare two recorded events (unreleased)

Select an event, then choose **Compare with another event** in the inspector and select a second event of the same entity. The inspector shows both events' provenance and the saved fields that differ, from the older event to the newer one. **Swap** reverses the direction, **Exit comparison** returns to the selected event, and **Cancel comparison** stops picking. Selecting another row leaves the comparison and shows that row. On the **Catalog history** page, only events of the first event's entity can be picked.

The two events can come from different capture sources or providers. In that case the inspector warns that each layer records different fields, so fields that only one layer stores appear as added or removed. A deletion record has no snapshot, so comparing with one shows every saved field of the other event as added or removed.

On the **Catalog history** page, the comparison is kept in the URL as `?compare=<from>..<to>&compareRef=<entityRef>`, so the link opens the same comparison. Opening a recording cycle from a compared event leaves the comparison. The entity **History** tab keeps the comparison only while the tab is open and its filters stay the same.

The action appears only when the history API provides optional `getEntityDiff`. A `501` response says the backend does not support comparison. A `404` means an event is no longer available or the backend has no comparison route.

## SDK: retained entity and Kind discovery

`0.3.0` adds optional `getEntities` and `getKinds` methods to
`CatalogHistoryApi` and `CatalogHistoryClient`. The standalone page uses them
for the pickers above. Custom consumers can also call them through an injected
API instance named `api`:

```ts
const page = await api.getEntities?.({
  prefix: 'pay',
  kind: 'Component',
  source: 'provider',
  limit: 25,
});

// page?.items[0]
// { entityRef: 'component:default/payment-api', kind: 'Component',
//   namespace: 'default', name: 'payment-api' }

const kinds = await api.getKinds?.({ prefix: 'com', limit: 25 });
```

Entity discovery accepts `prefix`, `kind`, `source`, `provider`, `op`,
`changedAfter`, `changedBefore`, `limit`, and `cursor`. It returns only
identity metadata from the latest matching retained row per canonical reference,
including delete-only history. Kind discovery accepts only `prefix`, `limit`,
and `cursor`, and returns one stored spelling per folded retained kind.

Both methods are optional for custom API implementations. The client forwards
HTTP failures by status without caching or compatibility fallback: `404` means
the route is absent, `501` means the store lacks that method, and `401`/`403`
remain authentication or authorization failures. Treat cursors as opaque and
reset them when changing a bound prefix or entity-search filter.

### Cycle SDK methods in `0.3.0`

```ts
const cycles = await api.listCycles?.({ source: 'provider', limit: 25 });

const cycle = await api.getCycle?.({
  cycleId: '00000000-0000-4000-8000-000000000001',
  limit: 25,
});
```

`listCycles` and `getCycle` are also optional. They return recorded cycle
metadata and a retained change page, respectively. The client URI-encodes
cycle IDs and filter values, uses the same
authenticated fetch API, and has no fallback or cache.

### Diff SDK method (unreleased)

`getEntityDiff` is optional for custom API implementations. The default client accepts only `history-row` targets and rejects others before making a request:

```ts
const diff = await api.getEntityDiff?.({
  entityRef: 'component:default/payment-api',
  from: { kind: 'history-row', id: '1042' },
  to: { kind: 'history-row', id: '1187' },
});
```

### As-of SDK method in `0.3.0`

`getEntityAsOf` is optional for custom API implementations. It reads one
retained observation at or before the requested timestamp:

```ts
const result = await api.getEntityAsOf?.({
  entityRef: 'component:default/payment-api',
  timestamp: '2026-10-24T12:00:00.123456Z',
  source: 'provider',
  provider: 'example-provider',
});
```

The client URI-encodes the entity path and sends only `timestamp`, `source`,
and `provider`. It preserves the requested timestamp and provider string,
including provider case and whitespace, and returns server JSON unchanged.
HTTP failures propagate by status without caching or automatic fallback.
A successful result can omit
`version` and `snapshot` when no eligible retained observation exists; a
selected delete has a version but no snapshot. An older backend without the
route returns `404`; a custom store without the method returns `501` after
authorization. `401`/`403` remain access failures.

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

It also exports the plugin's API and entity-content blueprints for NFS composition. The default plugin automatically registers the standalone page. There are no statistics, facets, as-of, or arbitrary version-comparison views.

`0.3.0` also exposes optional `CatalogHistoryApi.getProviders(request)` and the corresponding `CatalogHistoryClient` method for [retained-provider discovery](../../README.md#provider-discovery-in-030). Custom APIs can omit it. It returns server-matched names for suggestions; consumers still apply a selected full name through the existing exact `provider` filter. HTTP `404` and `501` identify unavailable discovery, while `401` and `403` are authentication/access errors. The HTTP client forwards failures without caching; the provider picker handles compatibility fallback.

For API configuration, permissions, routes, and retention behavior, read the [workspace README](../../README.md#read-history-over-http-in-020).

## License

Apache-2.0
