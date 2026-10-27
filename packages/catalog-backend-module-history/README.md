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

## Deprecated compatibility re-exports

This module still re-exports the following deprecated symbols from its package entry point for source compatibility. New and updated backend code should import them from their canonical Node or storage package instead. These are symbol aliases, not package-name aliases.

The compatibility imports below use this module's current npm name; they do not make superseded npm package names installable.

| Retained symbols                                                                                                 | Import from                                                |
| ---------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| `CaptureSource`, `CurrentEtag`, `CycleInput`, `EntityRow`, `HistoryStore`, `MutationType`, `RECONCILER_PROVIDER` | `@kunickiaj/backstage-plugin-catalog-history-node`         |
| `ensureSchema`, `historyStoreServiceFactory`, `PostgresHistoryStore`                                             | `@kunickiaj/backstage-plugin-catalog-history-storage-node` |

For example, replace a type and runtime storage import from this module:

```ts
import type { HistoryStore } from '@kunickiaj/backstage-plugin-catalog-backend-module-history';
import { PostgresHistoryStore } from '@kunickiaj/backstage-plugin-catalog-backend-module-history';
```

with canonical imports:

```ts
import type { HistoryStore } from '@kunickiaj/backstage-plugin-catalog-history-node';
import { PostgresHistoryStore } from '@kunickiaj/backstage-plugin-catalog-history-storage-node';
```

The default backend loader (`backend.add(import('@kunickiaj/backstage-plugin-catalog-backend-module-history'))`) and module capture exports remain imports from this package. No removal version has been announced. A future removal must be documented as a breaking release change before consumers upgrade.

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

A converted full reads its history baseline before it forwards, so it waits for any earlier recordings from the same wrapper, and later mutations from that wrapper wait for its forward. If a history call hangs while conversion is on, that provider's catalog writes stop until it finishes. The default store's `queryTimeoutMs` deadline applies only to history API reads, not to the wrapper's baseline reads or recording writes.

### Catalog regression tests

The provider tests include an in-memory SQLite integration with the pinned catalog backend development dependency. Run them from the workspace root with `env CI=1 yarn test packages/catalog-backend-module-history/src/provider --watch=false --runInBand`. They do not require a running catalog or an external database.

For current usage and productization roadmap details, see the [workspace README](../../README.md).

## Overlapping provider mutations (unreleased)

A provider can call `applyMutation` again before an earlier call finishes, for example when a webhook push arrives during a scheduled full refresh. The wrapper forwards overlapping calls to the catalog one at a time, in arrival order, and records them in history in the same order. Each recording reads its baseline only after the previous recording finishes, so history's latest row for an entity matches the catalog's last applied mutation. Earlier versions could record an older full on top of a newer push. Earlier versions also forwarded overlapping calls in parallel, so a provider that sends many concurrent deltas now sends them one at a time.

Without conversion, forwards do not wait for history, so a slow or unavailable store does not delay catalog writes. Each `applyMutation` call still resolves only after its own recording, so the provider feels slow history as slower calls. A provider that awaits each call therefore never has more than one mutation waiting. A provider with many calls in flight keeps one waiting mutation per call. The wrapper logs one warning when more than 20 recordings are queued, and warns again only after the queue drains: `History recording for provider <name> is <n> mutations behind`. A failed forward rejects only its own call and records nothing. A failed recording is logged and does not stop later mutations. Each wrapper has its own order, so different providers stay independent.
