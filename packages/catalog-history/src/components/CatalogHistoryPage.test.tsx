/** @jsxRuntime automatic */
import '@testing-library/jest-dom';
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { TestApiProvider, renderTestApp } from '@backstage/frontend-test-utils';
import type {
  HistoryEntityVersionResponse,
  HistoryChangeFeedResponse,
  HistoryTimelineSummary,
} from '@kunickiaj/backstage-plugin-catalog-history-common';
import {
  catalogHistoryApiRef,
  CatalogHistoryApiError,
  type CatalogHistoryApi,
} from '../api/CatalogHistoryApi';
import { catalogHistoryPlugin } from '../plugin';
import { parseEntityRef } from '@backstage/catalog-model';
import { CatalogHistoryPage } from './CatalogHistoryPage';

const componentRef = 'component:default/example';
const deletedRef = 'group:teams/retired-team';

function event(
  id: string,
  entityRef = componentRef,
): HistoryEntityVersionResponse & HistoryChangeFeedResponse['items'][number] {
  return {
    ...parseEntityRef(entityRef),
    id,
    entityRef,
    cycleId: `cycle-${id}`,
    source: 'provider',
    provider: 'directory',
    op: entityRef === deletedRef ? 'delete' : 'update',
    changedAt: '2026-10-23T12:00:00.000Z',
    summary: {},
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(res => {
    resolve = res;
  });
  return { promise, resolve };
}

function setup() {
  const api: jest.Mocked<
    CatalogHistoryApi & Required<Pick<CatalogHistoryApi, 'getChangeFeed'>>
  > = {
    getChangeFeed: jest.fn().mockResolvedValue({ items: [] }),
    getEntityTimeline: jest.fn(),
    getEntityVersion: jest.fn(),
  };
  // Intentionally no EntityProvider: browsing must not require a current entity.
  const mount = () =>
    render(
      <TestApiProvider apis={[[catalogHistoryApiRef, api]]}>
        <CatalogHistoryPage />
      </TestApiProvider>,
    );
  return { api, mount };
}

describe('CatalogHistoryPage', () => {
  afterEach(() => jest.useRealTimers());

  it('uses applied global scope for provider discovery and retains the exact selection while editing another prefix', async () => {
    // Arrange
    const { api, mount } = setup();
    const selected = ' Original Provider ';
    api.getProviders = jest.fn().mockResolvedValue({ items: [selected] });
    mount();
    await screen.findByText('No recorded events match these filters.');
    fireEvent.change(
      screen.getByRole('textbox', { name: 'Entity reference' }),
      { target: { value: 'Example' } },
    );
    fireEvent.change(screen.getByRole('textbox', { name: 'Kind' }), {
      target: { value: ' Component ' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Source$/ }));
    fireEvent.click(screen.getByRole('option', { name: 'provider' }));
    fireEvent.click(screen.getByRole('button', { name: /Operation$/ }));
    fireEvent.click(screen.getByRole('option', { name: 'update' }));
    const after = '2026-10-01T12:00';
    const before = '2026-10-24T12:00';
    fireEvent.change(screen.getByLabelText('Recorded after (local time)'), {
      target: { value: after },
    });
    fireEvent.change(screen.getByLabelText('Recorded before (local time)'), {
      target: { value: before },
    });
    const scope = {
      entityRef: componentRef,
      kind: 'Component',
      source: 'provider',
      op: 'update',
      changedAfter: new Date(after).toISOString(),
      changedBefore: new Date(before).toISOString(),
    };
    const input = screen.getByRole('combobox', { name: 'Provider' });
    fireEvent.focus(input);
    fireEvent.keyDown(input, { key: 'ArrowDown', code: 'ArrowDown' });
    fireEvent.click(
      await screen.findByRole('option', { name: 'Original Provider' }),
    );
    await waitFor(() =>
      expect(api.getChangeFeed).toHaveBeenLastCalledWith({
        ...scope,
        provider: selected,
        limit: 25,
        cursor: undefined,
      }),
    );

    // Act: changing source flushes other filters, never the uncommitted prefix.
    fireEvent.change(input, { target: { value: 'not-selected' } });
    fireEvent.click(screen.getByRole('button', { name: /Source$/ }));
    fireEvent.click(screen.getByRole('option', { name: 'processing' }));
    await waitFor(() =>
      expect(api.getChangeFeed).toHaveBeenLastCalledWith({
        ...scope,
        source: 'processing',
        provider: selected,
        limit: 25,
        cursor: undefined,
      }),
    );
    // An inverted date draft must not replace the last applied scope.
    fireEvent.change(screen.getByLabelText('Recorded before (local time)'), {
      target: { value: '2026-09-01T12:00' },
    });
    fireEvent.focus(input);
    jest.useFakeTimers();
    fireEvent.change(input, { target: { value: 'raw%_\\' } });
    await act(async () => jest.advanceTimersByTime(300));
    jest.useRealTimers();

    // Assert
    expect(api.getProviders).toHaveBeenCalledWith({
      ...scope,
      prefix: undefined,
      limit: 25,
    });
    expect(api.getProviders).toHaveBeenLastCalledWith({
      ...scope,
      source: 'processing',
      prefix: 'raw%_\\',
      limit: 25,
    });
    expect(api.getChangeFeed).toHaveBeenLastCalledWith({
      ...scope,
      source: 'processing',
      provider: selected,
      limit: 25,
      cursor: undefined,
    });
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Check history filters',
    );
    for (const [request] of jest.mocked(api.getProviders).mock.calls) {
      expect(request).not.toHaveProperty('provider');
      expect(request).not.toHaveProperty('owner');
      expect(request).not.toHaveProperty('cursor');
    }
    expect(api.getEntityTimeline).not.toHaveBeenCalled();
    expect(api.getEntityVersion).not.toHaveBeenCalled();
  });

  it('keeps legacy custom APIs on debounced exact provider filtering and cancels pending text on reset', async () => {
    // Arrange: no discovery method is intentional for older custom APIs.
    const { api, mount } = setup();
    mount();
    await screen.findByText('No recorded events match these filters.');
    jest.useFakeTimers();
    const input = screen.getByRole('textbox', { name: 'Provider' });

    // Act
    fireEvent.change(input, { target: { value: ' legacy-exact ' } });
    await act(async () => jest.advanceTimersByTime(299));
    expect(api.getChangeFeed).toHaveBeenCalledTimes(1);
    await act(async () => jest.advanceTimersByTime(1));
    expect(api.getChangeFeed).toHaveBeenLastCalledWith(
      expect.objectContaining({ provider: 'legacy-exact', cursor: undefined }),
    );
    fireEvent.change(input, { target: { value: 'must-not-apply' } });
    fireEvent.click(screen.getByRole('button', { name: 'Reset filters' }));
    await act(async () => jest.advanceTimersByTime(300));

    // Assert
    expect(screen.getByRole('textbox', { name: 'Provider' })).toHaveValue('');
    expect(api.getChangeFeed).toHaveBeenCalledTimes(3);
    expect(api.getChangeFeed).toHaveBeenLastCalledWith({
      limit: 25,
      cursor: undefined,
    });
    expect(api.getEntityVersion).not.toHaveBeenCalled();
  });

  it('renders explicitly supplied update summaries but keeps legacy and lifecycle feed rows badge-free', async () => {
    // Arrange: the default global feed need not compute per-entity summaries.
    const { api, mount } = setup();
    api.getChangeFeed.mockResolvedValue({
      items: [
        {
          ...event('custom-update'),
          summary: { ownerChanged: true, statusChanged: true },
        },
        event('legacy-empty'),
        {
          ...event('legacy-omitted'),
          summary: undefined as unknown as HistoryTimelineSummary,
        },
        {
          ...event('legacy-null'),
          summary: null as unknown as HistoryTimelineSummary,
        },
        {
          ...event('insert'),
          op: 'insert',
          summary: { relationsChanged: true },
        },
        { ...event('deleted', deletedRef), summary: { orphanChanged: true } },
      ],
    });

    // Act
    mount();
    await screen.findByRole('row', { name: /^Event custom-update,/ });

    // Assert
    const grid = screen.getByRole('grid');
    const update = within(grid).getByRole('row', {
      name: /^Event custom-update,/,
    });
    const operation = within(update).getByRole('gridcell', {
      name: 'update Recorded field changes: Owner changed, Status changed',
    });
    expect(within(operation).getByText('update')).toBeVisible();
    const list = within(operation).getByRole('list', {
      name: 'Recorded field changes: Owner changed, Status changed',
    });
    expect(
      within(list)
        .getAllByRole('listitem')
        .map(item => item.textContent),
    ).toEqual(['Owner changed', 'Status changed']);
    for (const [id, op] of [
      ['legacy-empty', 'update'],
      ['legacy-omitted', 'update'],
      ['legacy-null', 'update'],
      ['insert', 'insert'],
      ['deleted', 'delete'],
    ]) {
      const row = within(grid).getByRole('row', {
        name: new RegExp(`^Event ${id},`),
      });
      expect(within(row).queryByRole('list')).not.toBeInTheDocument();
      expect(within(row).getByRole('gridcell', { name: op })).toBeVisible();
    }
    expect(
      within(grid)
        .getAllByRole('columnheader')
        .map(header => header.textContent),
    ).toEqual(['Entity', 'Recorded at', 'Source', 'Provider', 'Operation']);
    expect(within(grid).getAllByRole('list')).toHaveLength(1);
    expect(within(grid).queryByText(/no changes/i)).not.toBeInTheDocument();
    expect(api.getChangeFeed).toHaveBeenCalledTimes(1);
    expect(api.getChangeFeed).toHaveBeenCalledWith({
      limit: 25,
      cursor: undefined,
    });
    expect(api.getEntityTimeline).not.toHaveBeenCalled();
    expect(api.getEntityVersion).not.toHaveBeenCalled();
  });

  it('loads an unscoped feed and explains an empty result without entity reads', async () => {
    // Arrange
    const { api, mount } = setup();
    // Act
    mount();
    // Assert
    await screen.findByText('No recorded events match these filters.');
    expect(api.getChangeFeed).toHaveBeenCalledWith({
      limit: 25,
      cursor: undefined,
    });
    expect(api.getEntityTimeline).not.toHaveBeenCalled();
    expect(api.getEntityVersion).not.toHaveBeenCalled();
    expect(
      screen.getByRole('textbox', { name: 'Entity reference' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Kind' })).toBeInTheDocument();
  });

  it('shows identities in both views and reads the clicked entity and delete ID', async () => {
    // Arrange
    const { api, mount } = setup();
    api.getChangeFeed.mockResolvedValue({
      items: [event('component'), event('deleted', deletedRef)],
    });
    api.getEntityVersion.mockImplementation(async ({ id, entityRef }) =>
      event(id, entityRef),
    );
    mount();
    // Act
    fireEvent.click(
      await screen.findByRole('row', { name: /^Event component,/ }),
    );
    await screen.findByText('cycle-component');
    expect(
      within(
        screen.getByRole('region', { name: 'Recorded event details' }),
      ).getByText(componentRef),
    ).toBeInTheDocument();
    act(() => screen.getByRole('row', { name: /^Event deleted,/ }).focus());
    fireEvent.click(screen.getByRole('row', { name: /^Event deleted,/ }));
    // Assert
    await screen.findByText(
      'Entity deleted. This event is a deletion record and has no snapshot.',
    );
    expect(
      screen.getByRole('columnheader', { name: 'Entity' }),
    ).toBeInTheDocument();
    expect(
      within(screen.getByRole('grid')).getByText(componentRef),
    ).toBeInTheDocument();
    expect(
      within(screen.getByRole('grid')).getByText(deletedRef),
    ).toBeInTheDocument();
    expect(
      within(
        screen.getByRole('region', { name: 'Recorded event details' }),
      ).getByText(deletedRef),
    ).toBeInTheDocument();
    expect(api.getEntityVersion.mock.calls.map(([request]) => request)).toEqual(
      [
        { entityRef: componentRef, id: 'component' },
        { entityRef: deletedRef, id: 'deleted' },
      ],
    );
    expect(screen.queryByText('cycle-component')).not.toBeInTheDocument();
    expect(screen.queryByText('Raw snapshot')).not.toBeInTheDocument();
  });

  it('ignores late detail from a previously selected different entity', async () => {
    // Arrange
    const { api, mount } = setup();
    const obsolete = deferred<HistoryEntityVersionResponse>();
    api.getChangeFeed.mockResolvedValue({
      items: [event('old'), event('selected', deletedRef)],
    });
    api.getEntityVersion
      .mockReturnValueOnce(obsolete.promise)
      .mockResolvedValueOnce(event('selected', deletedRef));
    mount();
    fireEvent.click(await screen.findByRole('row', { name: /^Event old,/ }));
    // Act
    act(() => screen.getByRole('row', { name: /^Event selected,/ }).focus());
    fireEvent.click(screen.getByRole('row', { name: /^Event selected,/ }));
    await screen.findByText('cycle-selected');
    await act(async () => obsolete.resolve(event('old')));
    // Assert
    expect(screen.getByText('cycle-selected')).toBeInTheDocument();
    expect(screen.queryByText('cycle-old')).not.toBeInTheDocument();
    expect(api.getEntityVersion).toHaveBeenLastCalledWith({
      entityRef: deletedRef,
      id: 'selected',
    });
  });

  it('pages globally, resets filters to page one, and ignores obsolete pages', async () => {
    // Arrange
    const { api, mount } = setup();
    const obsolete = deferred<HistoryChangeFeedResponse>();
    api.getChangeFeed
      .mockResolvedValueOnce({
        items: [event('first')],
        nextCursor: 'opaque+/=',
      })
      .mockResolvedValueOnce({
        items: [event('second', deletedRef)],
        nextCursor: 'older',
      })
      .mockReturnValueOnce(obsolete.promise)
      .mockResolvedValueOnce({
        items: [event('filtered', deletedRef)],
        nextCursor: 'filtered-cursor',
      })
      .mockResolvedValueOnce({ items: [event('reset')] });
    api.getEntityVersion.mockResolvedValue(event('filtered', deletedRef));
    mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Load older' }));
    await screen.findByRole('row', { name: /^Event second,/ });
    expect(api.getChangeFeed).toHaveBeenLastCalledWith({
      limit: 25,
      cursor: 'opaque+/=',
    });
    expect(
      screen.getByRole('row', { name: /^Event first,/ }),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Load older' }));
    // Act
    jest.useFakeTimers();
    fireEvent.change(screen.getByRole('textbox', { name: 'Kind' }), {
      target: { value: ' Group ' },
    });
    act(() => jest.advanceTimersByTime(299));
    expect(api.getChangeFeed).toHaveBeenCalledTimes(3);
    act(() => jest.advanceTimersByTime(1));
    jest.useRealTimers();
    fireEvent.click(
      await screen.findByRole('row', { name: /^Event filtered,/ }),
    );
    await screen.findByText('cycle-filtered');
    expect(api.getChangeFeed).toHaveBeenLastCalledWith(
      expect.objectContaining({ kind: 'Group', cursor: undefined }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Reset filters' }));
    await screen.findByRole('row', { name: /^Event reset,/ });
    await act(async () =>
      obsolete.resolve({ items: [event('obsolete')], nextCursor: 'stale' }),
    );
    // Assert
    expect(api.getChangeFeed).toHaveBeenLastCalledWith({
      limit: 25,
      cursor: undefined,
    });
    expect(
      screen.queryByRole('row', {
        name: /^Event (obsolete|first|second|filtered),/,
      }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText('cycle-filtered')).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Load older' }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Kind' })).toHaveValue('');
  });

  it('reports unsupported custom APIs instead of showing an empty feed', async () => {
    // Arrange
    const api: CatalogHistoryApi = {
      getEntityTimeline: jest.fn(),
      getEntityVersion: jest.fn(),
    };
    // Act
    render(
      <TestApiProvider apis={[[catalogHistoryApiRef, api]]}>
        <CatalogHistoryPage />
      </TestApiProvider>,
    );
    // Assert
    await screen.findByText(
      /Cross-entity history is not supported by this installation/,
    );
    expect(
      screen.queryByText('No recorded events match these filters.'),
    ).not.toBeInTheDocument();
    expect(api.getEntityTimeline).not.toHaveBeenCalled();
  });

  it.each([
    [401, /Sign in again/],
    [403, /do not have permission/],
    [404, /check that the history backend is enabled/],
    [500, /History could not be loaded/],
    [501, /Cross-entity history is not supported/],
  ])(
    'explains HTTP %s and recovers by retrying the feed',
    async (status, message) => {
      // Arrange
      const { api, mount } = setup();
      api.getChangeFeed.mockRejectedValueOnce(
        new CatalogHistoryApiError(status as number),
      );
      mount();
      await screen.findByText(message as RegExp);
      // Act
      fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
      // Assert
      await screen.findByText('No recorded events match these filters.');
      expect(api.getChangeFeed).toHaveBeenCalledTimes(2);
      expect(api.getEntityTimeline).not.toHaveBeenCalled();
    },
  );

  it('mounts the plugin page at /catalog-history with an API override', async () => {
    // Arrange
    const { api } = setup();
    // Act
    renderTestApp({
      features: [catalogHistoryPlugin],
      initialRouteEntries: ['/catalog-history'],
      config: {
        app: { extensions: [{ 'entity-content:catalog-history': false }] },
      },
      apis: [[catalogHistoryApiRef, api]],
    });
    // Assert
    await screen.findByRole('heading', { name: 'Catalog history' });
    await screen.findByText('No recorded events match these filters.');
    expect(api.getChangeFeed).toHaveBeenCalledWith({
      limit: 25,
      cursor: undefined,
    });
    expect(api.getEntityTimeline).not.toHaveBeenCalled();
  });
});
