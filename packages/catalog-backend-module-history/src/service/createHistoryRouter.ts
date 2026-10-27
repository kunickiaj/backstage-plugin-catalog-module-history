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
  parseHistoryDiffRequest,
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
  // Optional reads: authorize first, then answer 501 when the store lacks
  // the method, then parse, so an unauthorized caller learns nothing.
  const optional = <TRequest>(
    path: string,
    method: (
      query: HistoryRouterOptions['query'],
    ) => ((request: TRequest) => Promise<unknown>) | undefined,
    parse: (req: Request) => TRequest,
    missing: string,
  ) => {
    router.get(path, async (req, res) => {
      await authorize(req, options);
      const read = method(options.query);
      if (!read) throw new NotImplementedError(missing);
      const request = parse(req);
      res.json(await retrieve(() => read(request), options));
    });
  };
  optional(
    '/history/cycles',
    q => q.listCycles?.bind(q),
    parseHistoryCycleListRequest,
    'This history store does not support listing cycles.',
  );
  optional(
    '/history/cycles/:cycleId',
    q => q.getCycle?.bind(q),
    parseHistoryCycleDetailRequest,
    'This history store does not support reading cycles.',
  );
  optional(
    '/history/entities',
    q => q.getEntities?.bind(q),
    parseHistoryEntitySearchRequest,
    'This history store does not support entity discovery.',
  );
  optional(
    '/history/kinds',
    q => q.getKinds?.bind(q),
    parseHistoryKindSearchRequest,
    'This history store does not support kind discovery.',
  );
  optional(
    '/history/providers',
    q => q.getProviders?.bind(q),
    parseHistoryProviderSearchRequest,
    'This history store does not support provider discovery. Use an exact provider name or configure a store with provider-discovery support.',
  );
  optional(
    '/history/changes',
    q => q.getChangeFeed?.bind(q),
    parseHistoryChangeFeedRequest,
    'This history store does not support browsing changes. Use entity history or configure a store with change-feed support.',
  );
  optional(
    '/history/entities/:kind/:namespace/:name/as-of',
    q => q.getEntityAsOf?.bind(q),
    parseHistoryEntityAsOfRequest,
    'This history store does not support reading entity history as of a timestamp.',
  );
  optional(
    '/history/entities/:kind/:namespace/:name/diff',
    q => q.getEntityDiff?.bind(q),
    parseHistoryDiffRequest,
    'This history store does not support comparing history versions.',
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
