import { Entity } from '@backstage/catalog-model';

/**
 * Minimal interface for fetching the current catalog snapshot. Used by the
 * reconciler so it can be driven either by Backstage's in-process catalog
 * service (the default deployment) or by the HTTP CatalogClient (the
 * external CronJob path).
 */
export interface EntityFetcher {
  getEntities(): Promise<Entity[]>;
}
