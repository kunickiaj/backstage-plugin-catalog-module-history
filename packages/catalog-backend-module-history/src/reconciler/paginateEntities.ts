import { Entity } from '@backstage/catalog-model';
import {
  QueryEntitiesRequest,
  QueryEntitiesResponse,
} from '@backstage/catalog-client';

const DEFAULT_PAGE_SIZE = 500;

export type QueryEntitiesFn = (
  request: QueryEntitiesRequest,
) => Promise<QueryEntitiesResponse>;

/**
 * Walks the catalog's cursor-paginated queryEntities endpoint until the
 * server stops returning a nextCursor, accumulating every page. Used by
 * EntityFetcher adapters so a single reconcile() call sees the whole
 * catalog, not just the default page.
 *
 * A 500-row page size is a balance between request count and per-request
 * payload size; both the HTTP CatalogClient and the in-process
 * CatalogService respect the limit argument.
 */
export async function fetchAllEntities(
  queryFn: QueryEntitiesFn,
  pageSize: number = DEFAULT_PAGE_SIZE,
): Promise<Entity[]> {
  const all: Entity[] = [];
  let cursor: string | undefined;
  do {
    const response: QueryEntitiesResponse = cursor
      ? await queryFn({ cursor, limit: pageSize })
      : await queryFn({ limit: pageSize });
    all.push(...response.items);
    cursor = response.pageInfo.nextCursor;
  } while (cursor);
  return all;
}
