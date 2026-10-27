import { createServiceFactory } from '@backstage/backend-plugin-api';
import {
  mockCredentials,
  mockServices,
  startTestBackend,
  type TestBackend,
} from '@backstage/backend-test-utils';
import { InputError, NotFoundError } from '@backstage/errors';
import {
  catalogProcessingExtensionPoint,
  catalogServiceRef,
  type CatalogService,
} from '@backstage/plugin-catalog-node';
import { AuthorizeResult } from '@backstage/plugin-permission-common';
import {
  catalogHistoryReadPermission,
  type HistoryEntityDiffResponse,
} from '@kunickiaj/backstage-plugin-catalog-history-common';
import {
  historyStoreServiceRef,
  type HistoryQueryService,
} from '@kunickiaj/backstage-plugin-catalog-history-node';
import { InMemoryHistoryStore } from '@kunickiaj/backstage-plugin-catalog-history-node/testUtils';
import request from '../__testUtils__/testBackendRequest';
import { catalogModuleHistory } from '../catalogModuleHistory';

jest.setTimeout(30000);

const path = '/api/catalog/history/entities/Component/Default/Example/diff';
const entityRef = 'component:default/example';
const diff: HistoryEntityDiffResponse = { entityRef, changes: [] };
let backend: TestBackend | undefined;

afterEach(async () => {
  await backend?.stop();
  backend = undefined;
});

async function startApi(
  options: {
    missing?: boolean;
    decision?: AuthorizeResult.ALLOW | AuthorizeResult.DENY;
  } = {},
) {
  const getEntityDiff = jest
    .fn<
      ReturnType<HistoryQueryService['getEntityDiff']>,
      Parameters<HistoryQueryService['getEntityDiff']>
    >()
    .mockResolvedValue(diff);
  const query = {
    getEntityTimeline: jest.fn().mockResolvedValue({ items: [] }),
    getEntityVersions: jest.fn().mockResolvedValue({ items: [] }),
    getEntityVersion: jest.fn(),
    ...(options.missing ? {} : { getEntityDiff }),
  };
  const store = Object.assign(new InMemoryHistoryStore(), { query });
  const permissions = mockServices.permissions.mock();
  permissions.authorize.mockResolvedValue([
    { result: options.decision ?? AuthorizeResult.ALLOW },
  ]);
  const logger = mockServices.logger.mock();
  backend = await startTestBackend({
    extensionPoints: [
      [catalogProcessingExtensionPoint, { addProcessor: jest.fn() }],
    ],
    features: [
      catalogModuleHistory,
      createServiceFactory({
        service: historyStoreServiceRef,
        deps: {},
        factory: () => store,
      }),
      createServiceFactory({
        service: catalogServiceRef,
        deps: {},
        factory: () =>
          ({ queryEntities: jest.fn() }) as unknown as CatalogService,
      }),
      permissions.factory,
      logger.factory,
      mockServices.httpAuth.factory({
        defaultCredentials: mockCredentials.none(),
      }),
      mockServices.rootConfig.factory({
        data: {
          permission: { enabled: true },
          catalog: { history: { api: { enabled: true } } },
        },
      }),
    ],
  });
  return { server: backend.server, getEntityDiff, permissions, logger };
}

describe('catalog history diff HTTP route', () => {
  it('parses row targets in order and returns the store diff', async () => {
    // Arrange
    const { server, getEntityDiff, permissions } = await startApi();
    // Act
    const response = await request(server)
      .get(`${path}?from=row:12&to=row:9`)
      .set('Authorization', mockCredentials.user.header());
    // Assert
    expect(response.status).toBe(200);
    expect(response.body).toEqual(diff);
    expect(getEntityDiff).toHaveBeenCalledWith({
      entityRef,
      from: { kind: 'history-row', id: '12' },
      to: { kind: 'history-row', id: '9' },
    });
    expect(permissions.authorize).toHaveBeenCalledWith(
      [{ permission: catalogHistoryReadPermission }],
      expect.anything(),
    );
  });

  it('requires an authenticated user', async () => {
    // Arrange
    const { server, getEntityDiff } = await startApi();
    // Act
    const response = await request(server).get(`${path}?from=row:1&to=row:2`);
    // Assert
    expect(response.status).toBe(401);
    expect(getEntityDiff).not.toHaveBeenCalled();
  });

  it('rejects a denied read before parsing or querying', async () => {
    // Arrange
    const { server, getEntityDiff } = await startApi({
      decision: AuthorizeResult.DENY,
    });
    // Act
    const response = await request(server)
      .get(`${path}?from=cycle:x`)
      .set('Authorization', mockCredentials.user.header());
    // Assert
    expect(response.status).toBe(403);
    expect(getEntityDiff).not.toHaveBeenCalled();
  });

  it('returns 501 when the store cannot compare versions', async () => {
    // Arrange
    const { server } = await startApi({ missing: true });
    // Act
    const response = await request(server)
      .get(`${path}?from=row:1&to=row:2`)
      .set('Authorization', mockCredentials.user.header());
    // Assert
    expect(response.status).toBe(501);
  });

  it.each([
    ['from=cycle:abc&to=row:2', 'Invalid history diff target'],
    [
      'from=row:1&to=timestamp:2026-01-01T00:00:00Z',
      'Invalid history diff target',
    ],
    ['from=row:1', 'History diff requires from and to targets'],
    ['from=1&to=row:2', 'Invalid history diff target'],
    ['from=entry:1&to=row:2', 'Invalid history diff target'],
    ['from=row:0&to=row:2', 'Invalid history row id'],
    ['from=row:1&to=row:1', 'History diff targets must be different rows'],
    [
      'from=row:1&to=row:2&source=provider',
      'Unknown, repeated, or empty history query parameter',
    ],
    [
      'from=row:1&from=row:3&to=row:2',
      'Unknown, repeated, or empty history query parameter',
    ],
  ])('rejects %s with a specific message', async (query, message) => {
    // Arrange
    const { server, getEntityDiff } = await startApi();
    // Act
    const response = await request(server)
      .get(`${path}?${query}`)
      .set('Authorization', mockCredentials.user.header());
    // Assert
    expect(response.status).toBe(400);
    expect(response.body.error.message).toContain(message);
    expect(getEntityDiff).not.toHaveBeenCalled();
  });

  it.each([
    [new NotFoundError('row 2 is gone'), 404, 'History version not found'],
    [new InputError('detail'), 400, 'Invalid history query'],
    [
      new Error('connection refused'),
      500,
      'Unable to retrieve catalog history',
    ],
  ])(
    'maps store error %s to a sanitized %i',
    async (error, status, message) => {
      // Arrange
      const { server, getEntityDiff } = await startApi();
      getEntityDiff.mockRejectedValue(error);
      // Act
      const response = await request(server)
        .get(`${path}?from=row:1&to=row:2`)
        .set('Authorization', mockCredentials.user.header());
      // Assert
      expect(response.status).toBe(status);
      expect(response.body.error.message).toBe(message);
    },
  );
});
