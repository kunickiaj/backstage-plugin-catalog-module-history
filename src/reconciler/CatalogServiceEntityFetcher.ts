import { type AuthService } from '@backstage/backend-plugin-api';
import { type CatalogService } from '@backstage/plugin-catalog-node';
import { type Entity } from '@backstage/catalog-model';
import { EntityFetcher } from './EntityFetcher';
import { fetchAllEntities } from './paginateEntities';

/**
 * EntityFetcher used by the scheduled in-process reconciler mode. The HTTP
 * CatalogClient path remains available for the external CLI.
 */
export class CatalogServiceEntityFetcher implements EntityFetcher {
  private readonly catalog: CatalogService;

  private readonly auth: AuthService;

  constructor(options: { catalog: CatalogService; auth: AuthService }) {
    this.catalog = options.catalog;
    this.auth = options.auth;
  }

  async getEntities(): Promise<Entity[]> {
    const credentials = await this.auth.getOwnServiceCredentials();
    return fetchAllEntities(request =>
      this.catalog.queryEntities(request, { credentials }),
    );
  }
}
