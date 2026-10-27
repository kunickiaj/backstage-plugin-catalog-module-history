import { createBackendFeatureLoader } from '@backstage/backend-plugin-api';
import { historyStoreServiceFactory as defaultHistoryStoreServiceFactory } from '@kunickiaj/backstage-plugin-catalog-history-storage-node';
import { catalogModuleHistory } from './module/catalogModuleHistory';

export default createBackendFeatureLoader({
  loader() {
    return [defaultHistoryStoreServiceFactory, catalogModuleHistory];
  },
});

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
export { catalogModuleHistory } from './module/catalogModuleHistory';
export {
  createHistoryRouter,
  type HistoryRouterOptions,
} from './service/createHistoryRouter';
