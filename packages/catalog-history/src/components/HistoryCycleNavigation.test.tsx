/** @jsxRuntime automatic */
import '@testing-library/jest-dom';
import {
  act,
  fireEvent,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { renderTestApp } from '@backstage/frontend-test-utils';
import {
  createFrontendPlugin,
  PageBlueprint,
} from '@backstage/frontend-plugin-api';
import { EntityProvider } from '@backstage/plugin-catalog-react';
import type {
  HistoryCycle,
  HistoryEntityVersionResponse,
} from '@kunickiaj/backstage-plugin-catalog-history-common';
import {
  catalogHistoryApiRef,
  CatalogHistoryApiError,
  type CatalogHistoryApi,
} from '../api/CatalogHistoryApi';
import { catalogHistoryPlugin } from '../plugin';
import { EntityCatalogHistoryContent } from './EntityCatalogHistoryContent';

const entityRef = 'component:default/example';
const otherRef = 'group:teams/deleted';
const cycleId = 'CUSTOM?&/#ABC';
const header: HistoryCycle = {
  cycleId,
  source: 'provider',
  provider: ' Recorded Provider ',
  mutationType: 'full',
  startedAt: '2026-10-23T12:00:00.000Z',
  finishedAt: '2026-10-23T12:00:01.000Z',
  counts: { inserted: 4, updated: 8, deleted: 2, unchanged: 20 },
};
function event(id = 'selected', ref = entityRef): HistoryEntityVersionResponse {
  return {
    id,
    entityRef: ref,
    cycleId,
    source: header.source,
    provider: header.provider,
    op: 'update',
    changedAt: header.finishedAt,
    summary: {},
  };
}
function setup() {
  const api: jest.Mocked<CatalogHistoryApi> = {
    getChangeFeed: jest.fn().mockResolvedValue({
      items: [
        {
          ...event(),
          kind: 'Component',
          namespace: 'default',
          name: 'example',
        },
      ],
    }),
    getEntityTimeline: jest.fn().mockResolvedValue({ items: [event()] }),
    getEntityVersion: jest
      .fn()
      .mockImplementation(async ({ id, entityRef: ref }) => event(id, ref)),
    getCycle: jest.fn().mockResolvedValue({
      cycle: header,
      changes: {
        items: [
          {
            ...event('different', otherRef),
            kind: 'Group',
            namespace: 'teams',
            name: 'deleted',
          },
        ],
      },
    }),
    getEntities: jest.fn().mockResolvedValue({
      items: [
        {
          entityRef,
          kind: 'Component',
          namespace: 'default',
          name: 'example',
        },
      ],
    }),
    getKinds: jest.fn().mockResolvedValue({ items: ['Component', 'Group'] }),
    getProviders: jest.fn().mockResolvedValue({ items: [header.provider] }),
  };
  return api;
}
const entityPage = createFrontendPlugin({
  pluginId: 'history-test-entity',
  extensions: [
    PageBlueprint.make({
      params: {
        path: '/fixed-entity',
        loader: async () => (
          <EntityProvider
            entity={{
              apiVersion: 'backstage.io/v1alpha1',
              kind: 'Component',
              metadata: { name: 'example' },
            }}
          >
            <EntityCatalogHistoryContent />
          </EntityProvider>
        ),
      },
    }),
  ],
});
function mount(api: CatalogHistoryApi, route: string) {
  return renderTestApp({
    features: [catalogHistoryPlugin, entityPage],
    initialRouteEntries: [route],
    config: {
      app: {
        extensions: [
          { 'entity-content:catalog-history': false },
          { 'page:catalog-history': { config: { path: '/audit-history' } } },
        ],
      },
    },
    apis: [[catalogHistoryApiRef, api]],
  });
}

describe('public recording cycle navigation', () => {
  it.each([
    [401, /Sign in again/],
    [403, /do not have permission/],
    [
      404,
      /Refresh history or check whether this installation supports cycle details/,
    ],
    [501, /not supported by this installation/],
    [500, /could not be loaded/],
  ] as const)(
    'keeps the public Back action available on cycle HTTP %s errors',
    async (status, message) => {
      // Arrange
      const api = setup();
      jest
        .mocked(api.getCycle!)
        .mockRejectedValueOnce(new CatalogHistoryApiError(status));
      // Act
      mount(api, `/audit-history?cycleId=${encodeURIComponent(cycleId)}`);
      // Assert
      expect(await screen.findByRole('alert')).toHaveTextContent(message);
      expect(
        screen.getByRole('link', { name: 'Back to catalog history' }),
      ).toHaveAttribute('href', '/audit-history');
      expect(api.getChangeFeed).not.toHaveBeenCalled();
      expect(api.getEntityVersion).not.toHaveBeenCalled();
    },
  );

  it('offers Back rather than an empty cycle when the custom API lacks cycle support', async () => {
    // Arrange
    const api = setup();
    delete api.getCycle;
    // Act
    mount(api, '/audit-history?cycleId=opaque-preview-id');
    // Assert
    await screen.findByText(
      'Recording cycle details are not supported by this installation.',
    );
    expect(
      screen.getByRole('link', { name: 'Back to catalog history' }),
    ).toBeInTheDocument();
    expect(api.getChangeFeed).not.toHaveBeenCalled();
    expect(
      screen.queryByText(/No retained changed events/),
    ).not.toBeInTheDocument();
  });
  it('passes an uppercase UUID query unchanged while accepting its lowercase recorded header', async () => {
    // Arrange
    const api = setup();
    const uuid = 'ABCDEFAB-1234-4ABC-8DEF-123456789ABC';
    jest.mocked(api.getCycle!).mockResolvedValue({
      cycle: { ...header, cycleId: uuid.toLowerCase() },
      changes: { items: [] },
    });
    // Act
    mount(api, `/audit-history?cycleId=${uuid}`);
    // Assert
    await screen.findByRole('region', { name: 'Recorded cycle metadata' });
    expect(api.getCycle).toHaveBeenCalledWith({
      cycleId: uuid,
      limit: 25,
      cursor: undefined,
    });
    expect(screen.getByText(uuid.toLowerCase())).toBeInTheDocument();
    expect(api.getChangeFeed).not.toHaveBeenCalled();
  });
  it.each(['missing-id', 'missing-capability', 'unresolved-route'])(
    'renders provenance without a link for %s',
    async reason => {
      // Arrange
      const api = setup();
      const getCycle = api.getCycle;
      if (reason === 'missing-id')
        api.getEntityVersion.mockResolvedValue({ ...event(), cycleId: '' });
      if (reason === 'missing-capability') delete api.getCycle;
      // Act
      if (reason === 'unresolved-route') {
        renderTestApp({
          features: [entityPage],
          initialRouteEntries: ['/fixed-entity'],
          apis: [[catalogHistoryApiRef, api]],
        });
      } else mount(api, '/fixed-entity');
      fireEvent.click(
        await screen.findByRole('row', { name: /^Event selected,/ }),
      );
      const inspector = screen.getByRole('region', {
        name: 'Recorded event details',
      });
      await within(inspector).findAllByText(
        reason === 'missing-id' ? 'Not recorded' : cycleId,
      );
      // Assert
      expect(
        within(inspector).queryByRole('link', { name: /View recording cycle/ }),
      ).not.toBeInTheDocument();
      expect(getCycle).not.toHaveBeenCalled();
    },
  );

  it('uses cycle continuation and retries that page without requesting feed or snapshots', async () => {
    // Arrange
    const api = setup();
    const first = {
      ...event('first'),
      kind: 'Component',
      namespace: 'default',
      name: 'example',
    };
    const second = {
      ...event('second', otherRef),
      kind: 'Group',
      namespace: 'teams',
      name: 'deleted',
    };
    jest
      .mocked(api.getCycle!)
      .mockResolvedValueOnce({
        cycle: header,
        changes: { items: [first], nextCursor: 'cycle-only-cursor' },
      })
      .mockRejectedValueOnce(new CatalogHistoryApiError(500))
      .mockResolvedValueOnce({ cycle: header, changes: { items: [second] } });
    mount(api, `/audit-history?cycleId=${encodeURIComponent(cycleId)}`);
    // Act
    fireEvent.click(
      await screen.findByRole('button', { name: 'Load more changes' }),
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Retry' }));
    await screen.findByRole('row', { name: /^Event second,/ });
    // Assert
    expect(jest.mocked(api.getCycle!).mock.calls).toEqual([
      [{ cycleId, limit: 25, cursor: undefined }],
      [{ cycleId, limit: 25, cursor: 'cycle-only-cursor' }],
      [{ cycleId, limit: 25, cursor: 'cycle-only-cursor' }],
    ]);
    expect(
      screen.getByRole('row', { name: /^Event first,/ }),
    ).toBeInTheDocument();
    expect(api.getChangeFeed).not.toHaveBeenCalled();
    expect(api.getEntityVersion).not.toHaveBeenCalled();
  });

  it.each(['/audit-history', '/fixed-entity'])(
    'opens the real public route from %s and inspects another recorded entity only on selection',
    async route => {
      // Arrange: actual plugin route resolution, including an overridden page path.
      const api = setup();
      mount(api, route);
      const row = await screen.findByRole('row', { name: /^Event selected,/ });
      // Act
      fireEvent.click(row);
      const link = await screen.findByRole('link', {
        name: `View recording cycle ${cycleId}`,
      });
      // Assert
      const url = new URL(link.getAttribute('href')!, 'https://example.test');
      expect(url.pathname).toBe('/audit-history');
      expect(url.searchParams.get('cycleId')).toBe(cycleId);
      expect(link.getAttribute('href')).toContain('%3F%26%2F%23');
      fireEvent.click(link);
      await screen.findByRole('heading', { name: 'Recording cycle' });
      const metadata = await screen.findByRole('region', {
        name: 'Recorded cycle metadata',
      });
      expect(metadata).toHaveTextContent('Recorded Provider');
      expect(metadata).toHaveTextContent('provider');
      expect(metadata).toHaveTextContent('Unchanged20');
      expect(api.getEntityVersion).toHaveBeenCalledTimes(1);
      expect(
        screen.queryByRole('combobox', { name: 'Entity' }),
      ).not.toBeInTheDocument();
      expect(
        screen.queryByRole('combobox', { name: 'Kind' }),
      ).not.toBeInTheDocument();
      const changed = await screen.findByRole('row', {
        name: /^Event different,/,
      });
      act(() => changed.focus());
      fireEvent.keyDown(changed, { key: 'Enter', code: 'Enter' });
      fireEvent.keyUp(changed, { key: 'Enter', code: 'Enter' });
      await waitFor(() =>
        expect(api.getEntityVersion).toHaveBeenLastCalledWith({
          entityRef: otherRef,
          id: 'different',
        }),
      );
      expect(
        screen.getByRole('region', { name: 'Recorded event details' }),
      ).toHaveFocus();
      expect(
        screen.getByRole('link', { name: 'Back to catalog history' }),
      ).toHaveAttribute('href', '/audit-history');
    },
  );

  it('loads a direct query without feed/discovery/detail requests and preserves unrelated query and hash on Back', async () => {
    // Arrange
    const api = setup();
    // Act
    mount(
      api,
      `/audit-history?keep=value&cycleId=${encodeURIComponent(cycleId)}#anchor`,
    );
    await screen.findByRole('region', { name: 'Recorded cycle metadata' });
    // Assert
    expect(api.getCycle).toHaveBeenCalledWith({
      cycleId,
      limit: 25,
      cursor: undefined,
    });
    for (const method of [
      api.getChangeFeed,
      api.getEntities,
      api.getKinds,
      api.getProviders,
      api.getEntityVersion,
    ])
      expect(method).not.toHaveBeenCalled();
    expect(
      screen.getByRole('link', { name: 'Back to catalog history' }),
    ).toHaveAttribute('href', '/audit-history?keep=value#anchor');
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
    fireEvent.click(
      screen.getByRole('link', { name: 'Back to catalog history' }),
    );
    await screen.findByRole('row', { name: /^Event selected,/ });
    expect(api.getChangeFeed).toHaveBeenCalledTimes(1);
  });

  it('retains an applied source through the real public cycle route and Back', async () => {
    // Arrange: query navigation must preserve the page's applied filter state.
    const api = setup();
    mount(api, '/audit-history');
    await screen.findByRole('row', { name: /^Event selected,/ });
    fireEvent.click(screen.getByRole('button', { name: /Source$/ }));
    fireEvent.click(screen.getByRole('option', { name: 'provider' }));
    await screen.findByRole('row', { name: /^Event selected,/ });

    // Act
    fireEvent.click(screen.getByRole('row', { name: /^Event selected,/ }));
    fireEvent.click(
      await screen.findByRole('link', {
        name: `View recording cycle ${cycleId}`,
      }),
    );
    await screen.findByRole('heading', { name: 'Recording cycle' });
    expect(
      screen.queryByRole('button', { name: /Source$/ }),
    ).not.toBeInTheDocument();
    fireEvent.click(
      screen.getByRole('link', { name: 'Back to catalog history' }),
    );
    await screen.findByRole('row', { name: /^Event selected,/ });

    // Assert: both the visible control and the returned feed retain the source.
    expect(screen.getByRole('button', { name: /Source$/ })).toHaveTextContent(
      'provider',
    );
    expect(api.getChangeFeed).toHaveBeenLastCalledWith(
      expect.objectContaining({ source: 'provider' }),
    );
  });

  it('treats an empty query ID as missing rather than fetching an empty cycle', async () => {
    // Arrange
    const api = setup();
    // Act
    mount(api, '/audit-history?cycleId=');
    // Assert
    await screen.findByText('Cycle ID was not provided.');
    expect(api.getCycle).not.toHaveBeenCalled();
    expect(api.getChangeFeed).not.toHaveBeenCalled();
    expect(
      screen.getByRole('link', { name: 'Back to catalog history' }),
    ).toHaveAttribute('href', '/audit-history');
  });

  it('keeps deletion and previous snapshot cycle links tied to their own recorded provenance', async () => {
    // Arrange
    const api = setup();
    api.getEntityVersion.mockResolvedValue({
      ...event(),
      op: 'delete',
      previousVersion: {
        ...event('previous'),
        cycleId: 'previous-cycle',
        source: 'processing',
        provider: 'previous-provider',
        snapshot: {
          entityRef,
          kind: 'Component',
          namespace: 'default',
          name: 'example',
        },
      },
    });
    mount(api, '/audit-history');
    // Act
    fireEvent.click(
      await screen.findByRole('row', { name: /^Event selected,/ }),
    );
    // Assert
    const current = await screen.findByRole('link', {
      name: `View recording cycle ${cycleId}`,
    });
    const previous = screen.getByRole('link', {
      name: 'View recording cycle previous-cycle',
    });
    expect(
      new URL(
        current.getAttribute('href')!,
        'https://example.test',
      ).searchParams.get('cycleId'),
    ).toBe(cycleId);
    expect(previous).toHaveAttribute(
      'href',
      '/audit-history?cycleId=previous-cycle',
    );
    expect(screen.getByText('previous-provider')).toBeInTheDocument();
    const inspector = screen.getByRole('region', {
      name: 'Recorded event details',
    });
    expect(within(inspector).getByText('processing')).toBeInTheDocument();
    expect(
      within(inspector).getByText(header.provider.trim()),
    ).toBeInTheDocument();
  });
});
