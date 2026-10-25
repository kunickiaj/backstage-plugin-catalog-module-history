import { MiddlewareFactory } from '@backstage/backend-defaults/rootHttpRouter';
import type {
  HttpAuthService,
  LoggerService,
  PermissionsService,
  RootConfigService,
} from '@backstage/backend-plugin-api';
import {
  AuthenticationError,
  InputError,
  NotAllowedError,
  NotFoundError,
  NotImplementedError,
} from '@backstage/errors';
import { AuthorizeResult } from '@backstage/plugin-permission-common';
import type { Request, Router } from 'express';
import PromiseRouter from 'express-promise-router';
import { catalogHistoryReadPermission } from '@kunickiaj/backstage-plugin-catalog-history-common';
import type { HistoryStore } from '@kunickiaj/backstage-plugin-catalog-history-node';
import {
  parseHistoryChangeFeedRequest,
  parseHistoryCycleDetailRequest,
  parseHistoryCycleListRequest,
  parseHistoryEntityAsOfRequest,
  parseHistoryEntitySearchRequest,
  parseHistoryKindSearchRequest,
  parseHistoryProviderSearchRequest,
  parseHistoryRequest,
  parseHistoryVersionRequest,
} from './parseHistoryRequest';
import { queryErrorMetadata } from './queryErrorMetadata';

/** Options for the opt-in catalog history read router. @public */
export interface HistoryRouterOptions {
  query: NonNullable<HistoryStore['query']>;
  httpAuth: HttpAuthService;
  permissions: PermissionsService;
  config: RootConfigService;
  logger: LoggerService;
}

async function authorize(req: Request, options: HistoryRouterOptions) {
  const credentials = await options.httpAuth
    .credentials(req, { allow: ['user'] })
    .catch(() => {
      throw new AuthenticationError('User authentication is required');
    });
  const [decision] = await options.permissions
    .authorize([{ permission: catalogHistoryReadPermission }], { credentials })
    .catch(() => {
      throw new Error('History authorization failed');
    });
  if (decision?.result !== AuthorizeResult.ALLOW) {
    throw new NotAllowedError('Catalog history read permission is required');
  }
}

async function retrieve<T>(
  query: () => Promise<T>,
  options: HistoryRouterOptions,
) {
  try {
    return await query();
  } catch (error) {
    // Cursor validation lives in the query implementation. Do not expose
    // its causes or database errors through Backstage's error serializer.
    if (error instanceof InputError) {
      throw new InputError('Invalid history query');
    }
    if (error instanceof NotFoundError) {
      throw new NotFoundError('History version not found');
    }
    options.logger.error(
      'Catalog history query failed',
      queryErrorMetadata(error),
    );
    throw new Error('Unable to retrieve catalog history');
  }
}

/**
 * Creates authenticated history read routes relative to /api/catalog.
 * Access grants all retained history, independent of catalog visibility.
 * @public
 */
export function createHistoryRouter(options: HistoryRouterOptions): Router {
  const router = PromiseRouter();
  router.get('/history/cycles', async (req, res) => {
    await authorize(req, options);
    const listCycles = options.query.listCycles?.bind(options.query);
    if (!listCycles) {
      throw new NotImplementedError(
        'This history store does not support listing cycles.',
      );
    }
    const request = parseHistoryCycleListRequest(req);
    const result = await retrieve(() => listCycles(request), options);
    res.json(result);
  });
  router.get('/history/cycles/:cycleId', async (req, res) => {
    await authorize(req, options);
    const getCycle = options.query.getCycle?.bind(options.query);
    if (!getCycle) {
      throw new NotImplementedError(
        'This history store does not support reading cycles.',
      );
    }
    const request = parseHistoryCycleDetailRequest(req);
    const result = await retrieve(() => getCycle(request), options);
    res.json(result);
  });
  router.get('/history/entities', async (req, res) => {
    await authorize(req, options);
    const getEntities = options.query.getEntities?.bind(options.query);
    if (!getEntities) {
      throw new NotImplementedError(
        'This history store does not support entity discovery.',
      );
    }
    const request = parseHistoryEntitySearchRequest(req);
    const result = await retrieve(() => getEntities(request), options);
    res.json(result);
  });
  router.get('/history/kinds', async (req, res) => {
    await authorize(req, options);
    const getKinds = options.query.getKinds?.bind(options.query);
    if (!getKinds) {
      throw new NotImplementedError(
        'This history store does not support kind discovery.',
      );
    }
    const request = parseHistoryKindSearchRequest(req);
    const result = await retrieve(() => getKinds(request), options);
    res.json(result);
  });
  router.get('/history/providers', async (req, res) => {
    await authorize(req, options);
    const getProviders = options.query.getProviders?.bind(options.query);
    if (!getProviders) {
      throw new NotImplementedError(
        'This history store does not support provider discovery. Use an exact provider name or configure a store with provider-discovery support.',
      );
    }
    const request = parseHistoryProviderSearchRequest(req);
    const result = await retrieve(() => getProviders(request), options);
    res.json(result);
  });
  router.get('/history/changes', async (req, res) => {
    await authorize(req, options);
    const getChangeFeed = options.query.getChangeFeed?.bind(options.query);
    if (!getChangeFeed) {
      throw new NotImplementedError(
        'This history store does not support browsing changes. Use entity history or configure a store with change-feed support.',
      );
    }
    const request = parseHistoryChangeFeedRequest(req);
    const result = await retrieve(() => getChangeFeed(request), options);
    res.json(result);
  });
  router.get(
    '/history/entities/:kind/:namespace/:name/as-of',
    async (req, res) => {
      await authorize(req, options);
      const getEntityAsOf = options.query.getEntityAsOf?.bind(options.query);
      if (!getEntityAsOf) {
        throw new NotImplementedError(
          'This history store does not support reading entity history as of a timestamp.',
        );
      }
      const request = parseHistoryEntityAsOfRequest(req);
      const result = await retrieve(() => getEntityAsOf(request), options);
      res.json(result);
    },
  );
  for (const endpoint of ['history', 'versions'] as const) {
    router.get(
      `/history/entities/:kind/:namespace/:name/${endpoint}`,
      async (req, res) => {
        await authorize(req, options);
        const request = parseHistoryRequest(req, endpoint);
        const result = await retrieve(
          () =>
            endpoint === 'history'
              ? options.query.getEntityTimeline(request)
              : options.query.getEntityVersions(request),
          options,
        );
        res.json(result);
      },
    );
  }
  router.get(
    '/history/entities/:kind/:namespace/:name/versions/:id',
    async (req, res) => {
      await authorize(req, options);
      const request = parseHistoryVersionRequest(req);
      const result = await retrieve(
        () => options.query.getEntityVersion(request),
        options,
      );
      res.json(result);
    },
  );
  router.use(
    MiddlewareFactory.create(options).error({ showStackTraces: false }),
  );
  return router;
}
