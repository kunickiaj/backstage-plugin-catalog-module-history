// Store contracts moved to @kunickiaj/catalog-history-node; re-exported here
// for compatibility with existing imports.
/** @deprecated Import from `@kunickiaj/catalog-history-node` instead; these re-exports will be removed in a future release. */
export type {
  CaptureSource,
  CurrentEtag,
  CycleInput,
  EntityRow,
  HistoryStore,
  MutationType,
} from '@kunickiaj/catalog-history-node';
/** @deprecated Import from `@kunickiaj/catalog-history-node` instead; this re-export will be removed in a future release. */
export { RECONCILER_PROVIDER } from '@kunickiaj/catalog-history-node';
// Storage moved to @kunickiaj/catalog-history-backend; re-exported here for
// compatibility with existing imports.
/** @deprecated Import from `@kunickiaj/catalog-history-backend` instead; these re-exports will be removed in a future release. */
export {
  ensureSchema,
  PostgresHistoryStore,
} from '@kunickiaj/catalog-history-backend';
export { entityToRow } from './mapping/entityToRow';
export {
  HistoryRecordingEntityProvider,
  type HistoryRecordingEntityProviderOptions,
} from './provider/HistoryRecordingEntityProvider';
export {
  HistoryRecordingCatalogProcessor,
  type HistoryRecordingCatalogProcessorOptions,
} from './processor/HistoryRecordingCatalogProcessor';
export { reconcile, type ReconcileOptions } from './reconciler/reconcile';
export type { EntityFetcher } from './reconciler/EntityFetcher';
export { CatalogServiceEntityFetcher } from './reconciler/CatalogServiceEntityFetcher';
export { catalogModuleHistory, default } from './module/catalogModuleHistory';
