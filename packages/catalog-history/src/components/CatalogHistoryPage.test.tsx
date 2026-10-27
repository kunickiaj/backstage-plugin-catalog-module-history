/** @jsxRuntime automatic */
import '@testing-library/jest-dom';
import {
  act,
  fireEvent,
  render as renderComponent,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { TestApiProvider, renderTestApp } from '@backstage/frontend-test-utils';
import type {
  HistoryEntityVersionResponse,
  HistoryChangeFeedResponse,
  HistoryTimelineSummary,
  HistoryEntitySearchResponse,
  HistoryKindSearchResponse,
} from '@kunickiaj/backstage-plugin-catalog-history-common';
import {
  catalogHistoryApiRef,
  CatalogHistoryApiError,
  type CatalogHistoryApi,
} from '../api/CatalogHistoryApi';
import { catalogHistoryPlugin } from '../plugin';
import { parseEntityRef } from '@backstage/catalog-model';
import { CatalogHistoryPage } from './CatalogHistoryPage';
import { MemoryRouter, useLocation, useNavigate } from 'react-router-dom';
import { deferred } from '../__testUtils__/deferred';

function render(ui: Parameters<typeof renderComponent>[0]) {
  return renderComponent(ui, { wrapper: MemoryRouter });
}

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

  it('returns through native router history without requesting a global feed while the cycle is active', async () => {
    // Arrange
    const { api } = setup();
    api.getCycle = jest.fn().mockResolvedValue({
      cycle: {
        cycleId: 'direct-cycle',
        source: 'processing',
        provider: 'recorded-provider',
        mutationType: 'delta',
        startedAt: '2026-10-23T12:00:00.000Z',
        finishedAt: '2026-10-23T12:00:01.000Z',
        counts: { inserted: 0, updated: 0, deleted: 0, unchanged: 2 },
      },
      changes: { items: [] },
    });
    function BrowserBack() {
      const navigate = useNavigate();
      return <button onClick={() => navigate(-1)}>Browser Back</button>;
    }
    renderComponent(
      <MemoryRouter
        initialEntries={[
          '/catalog-history?keep=1',
          '/catalog-history?keep=1&cycleId=direct-cycle',
        ]}
      >
        <TestApiProvider apis={[[catalogHistoryApiRef, api]]}>
          <BrowserBack />
          <CatalogHistoryPage />
        </TestApiProvider>
      </MemoryRouter>,
    );
    await screen.findByRole('region', { name: 'Recorded cycle metadata' });
    expect(api.getChangeFeed).not.toHaveBeenCalled();
    // Act
    fireEvent.click(screen.getByRole('button', { name: 'Browser Back' }));
    // Assert
    await screen.findByText('No recorded events match these filters.');
    expect(api.getChangeFeed).toHaveBeenCalledTimes(1);
    expect(
      screen.queryByRole('heading', { name: 'Recording cycle' }),
    ).not.toBeInTheDocument();
    expect(api.getEntityVersion).not.toHaveBeenCalled();
  });

  it('queries literal entity prefixes in applied scope without applying drafts or reading snapshots', async () => {
    // Arrange: the discovered deletion is absent from the loaded event page.
    const { api, mount } = setup();
    const selected = {
      entityRef: deletedRef,
      kind: 'Group',
      namespace: 'teams',
      name: 'retired-team',
    };
    const rawProvider = ' Original Provider ';
    api.getEntities = jest
      .fn()
      .mockResolvedValue({ items: [selected], nextCursor: 'entity-only' });
    api.getKinds = jest.fn().mockResolvedValue({ items: ['Group', 'API'] });
    api.getProviders = jest.fn().mockResolvedValue({ items: [rawProvider] });
    api.getChangeFeed.mockResolvedValue({ items: [event('loaded')] });
    mount();
    await screen.findByRole('row', { name: /^Event loaded,/ });
    const kind = screen.getByRole('combobox', { name: 'Kind' });
    fireEvent.focus(kind);
    fireEvent.keyDown(kind, { key: 'ArrowDown', code: 'ArrowDown' });
    fireEvent.click(await screen.findByRole('option', { name: 'Group' }));
    fireEvent.click(screen.getByRole('button', { name: /Source$/ }));
    fireEvent.click(screen.getByRole('option', { name: 'provider' }));
    fireEvent.click(screen.getByRole('button', { name: /Operation$/ }));
    fireEvent.click(screen.getByRole('option', { name: 'delete' }));
    const after = '2026-10-01T12:00';
    const before = '2026-10-24T12:00';
    fireEvent.change(screen.getByLabelText('Recorded after (local time)'), {
      target: { value: after },
    });
    fireEvent.change(screen.getByLabelText('Recorded before (local time)'), {
      target: { value: before },
    });
    const provider = screen.getByRole('combobox', { name: 'Provider' });
    fireEvent.focus(provider);
    fireEvent.keyDown(provider, { key: 'ArrowDown', code: 'ArrowDown' });
    fireEvent.click(
      await screen.findByRole('option', { name: 'Original Provider' }),
    );
    const scope = {
      kind: 'Group',
      source: 'provider',
      provider: rawProvider,
      op: 'delete',
      changedAfter: new Date(after).toISOString(),
      changedBefore: new Date(before).toISOString(),
    };
    await waitFor(() =>
      expect(api.getChangeFeed).toHaveBeenLastCalledWith({
        ...scope,
        limit: 25,
        cursor: undefined,
      }),
    );
    const input = screen.getByRole('combobox', { name: 'Entity' });
    fireEvent.focus(input);
    await waitFor(() =>
      expect(api.getEntities).toHaveBeenCalledWith({
        ...scope,
        prefix: undefined,
        limit: 25,
      }),
    );
    const feedCalls = api.getChangeFeed.mock.calls.length;
    const entityCalls = jest.mocked(api.getEntities).mock.calls.length;

    // Act: an inverted date draft must not enter the discovery context.
    fireEvent.change(screen.getByLabelText('Recorded before (local time)'), {
      target: { value: '2026-09-01T12:00' },
    });
    jest.useFakeTimers();
    fireEvent.change(input, { target: { value: 'raw%_\\' } });
    await act(async () => jest.advanceTimersByTime(299));
    expect(api.getEntities).toHaveBeenCalledTimes(entityCalls);
    await act(async () => jest.advanceTimersByTime(1));
    jest.useRealTimers();
    fireEvent.keyDown(input, { key: 'Escape', code: 'Escape' });
    fireEvent.focus(kind);
    jest.useFakeTimers();
    fireEvent.change(kind, { target: { value: 'gR' } });
    await act(async () => jest.advanceTimersByTime(300));
    jest.useRealTimers();
    fireEvent.keyDown(kind, { key: 'Escape', code: 'Escape' });

    // Assert
    expect(api.getEntities).toHaveBeenLastCalledWith({
      ...scope,
      prefix: 'raw%_\\',
      limit: 25,
    });
    expect(api.getChangeFeed).toHaveBeenCalledTimes(feedCalls);
    expect(api.getEntityVersion).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Check history filters',
    );
    for (const [request] of jest.mocked(api.getEntities).mock.calls) {
      expect(request).not.toHaveProperty('entityRef');
      expect(request).not.toHaveProperty('owner');
      expect(request).not.toHaveProperty('cursor');
    }
    for (const [request] of jest.mocked(api.getKinds).mock.calls) {
      expect(Object.keys(request!)).toEqual(['prefix', 'limit']);
    }
    expect(api.getKinds).toHaveBeenLastCalledWith({
      prefix: 'gR',
      limit: 25,
      cursor: undefined,
    });
  });

  it('applies a returned canonical identity and kind atomically, retaining selections while editing prefixes or other filters', async () => {
    // Arrange: identical names must remain distinct across kind and namespace.
    const { api, mount } = setup();
    const selected = {
      entityRef: 'group:teams/shared',
      kind: 'Group',
      namespace: 'teams',
      name: 'shared',
    };
    const other = {
      entityRef: 'component:default/shared',
      kind: 'Component',
      namespace: 'default',
      name: 'shared',
    };
    const rawProvider = ' Exact Provider ';
    api.getEntities = jest.fn().mockResolvedValue({ items: [other, selected] });
    api.getKinds = jest
      .fn()
      .mockResolvedValue({ items: ['API', 'Component', 'Group'] });
    api.getProviders = jest.fn().mockResolvedValue({ items: [rawProvider] });
    mount();
    await screen.findByText('No recorded events match these filters.');
    const provider = screen.getByRole('combobox', { name: 'Provider' });
    fireEvent.focus(provider);
    fireEvent.keyDown(provider, { key: 'ArrowDown', code: 'ArrowDown' });
    fireEvent.click(
      await screen.findByRole('option', { name: 'Exact Provider' }),
    );
    const input = screen.getByRole('combobox', { name: 'Entity' });
    fireEvent.focus(input);
    fireEvent.keyDown(input, { key: 'ArrowDown', code: 'ArrowDown' });
    // Act
    fireEvent.click(
      await screen.findByRole('option', { name: 'shared — Group / teams' }),
    );
    await waitFor(() =>
      expect(api.getChangeFeed).toHaveBeenLastCalledWith(
        expect.objectContaining({
          entityRef: selected.entityRef,
          kind: 'Group',
          provider: rawProvider,
          cursor: undefined,
        }),
      ),
    );
    expect(screen.getByRole('combobox', { name: 'Kind' })).toHaveValue('Group');
    const callsAfterSelection = api.getChangeFeed.mock.calls.length;
    fireEvent.focus(input);
    jest.useFakeTimers();
    fireEvent.change(input, { target: { value: 'unselected-name' } });
    fireEvent.change(provider, { target: { value: 'unselected-provider' } });
    await act(async () => jest.advanceTimersByTime(300));
    jest.useRealTimers();
    expect(api.getChangeFeed).toHaveBeenCalledTimes(callsAfterSelection);
    fireEvent.click(screen.getByRole('button', { name: /Source$/ }));
    fireEvent.click(screen.getByRole('option', { name: 'processing' }));
    const after = '2026-10-01T12:00';
    fireEvent.change(screen.getByLabelText('Recorded after (local time)'), {
      target: { value: after },
    });

    // Assert
    await waitFor(() =>
      expect(api.getChangeFeed).toHaveBeenLastCalledWith({
        entityRef: selected.entityRef,
        kind: 'Group',
        provider: rawProvider,
        source: 'processing',
        changedAfter: new Date(after).toISOString(),
        limit: 25,
        cursor: undefined,
      }),
    );
    expect(api.getEntities).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'Group',
        provider: rawProvider,
        prefix: 'unselected-name',
      }),
    );
    expect(api.getEntityVersion).not.toHaveBeenCalled();
    for (const [request] of jest.mocked(api.getEntities).mock.calls) {
      expect(request).not.toHaveProperty('entityRef');
      expect(request).not.toHaveProperty('owner');
    }
    expect(
      api.getChangeFeed.mock.calls
        .slice(1)
        .every(
          ([request]) =>
            !request.entityRef || request.entityRef === selected.entityRef,
        ),
    ).toBe(true);
  });

  it('retains entity on All kinds, retains kind on Clear entity, and clears entity on an incompatible kind', async () => {
    // Arrange
    const { api, mount } = setup();
    const selected = {
      entityRef: deletedRef,
      kind: 'Group',
      namespace: 'teams',
      name: 'retired-team',
    };
    api.getEntities = jest.fn().mockResolvedValue({ items: [selected] });
    api.getKinds = jest.fn().mockResolvedValue({ items: ['API', 'Group'] });
    mount();
    await screen.findByText('No recorded events match these filters.');
    const entity = screen.getByRole('combobox', { name: 'Entity' });
    const kind = screen.getByRole('combobox', { name: 'Kind' });
    const chooseEntity = async () => {
      fireEvent.focus(entity);
      fireEvent.keyDown(entity, { key: 'ArrowDown', code: 'ArrowDown' });
      fireEvent.click(
        await screen.findByRole('option', {
          name: 'retired-team — Group / teams',
        }),
      );
    };
    const chooseKind = async (name: string) => {
      fireEvent.focus(kind);
      fireEvent.keyDown(kind, { key: 'ArrowDown', code: 'ArrowDown' });
      fireEvent.click(await screen.findByRole('option', { name }));
    };
    await chooseEntity();
    // Act / Assert: All kinds removes only kind, never the selected exact ref.
    await chooseKind('All kinds');
    await waitFor(() =>
      expect(api.getChangeFeed).toHaveBeenLastCalledWith(
        expect.objectContaining({
          entityRef: deletedRef,
          kind: undefined,
          cursor: undefined,
        }),
      ),
    );
    expect(entity).toHaveValue('retired-team');
    await chooseKind('Group');
    fireEvent.click(screen.getByRole('button', { name: 'Clear entity' }));
    await waitFor(() =>
      expect(api.getChangeFeed).toHaveBeenLastCalledWith(
        expect.objectContaining({
          kind: 'Group',
          cursor: undefined,
        }),
      ),
    );
    expect(api.getChangeFeed.mock.calls.at(-1)![0].entityRef).toBeUndefined();
    expect(entity).toHaveValue('');
    expect(kind).toHaveValue('Group');
    await chooseEntity();
    await chooseKind('API');
    await waitFor(() =>
      expect(api.getChangeFeed).toHaveBeenLastCalledWith(
        expect.objectContaining({
          kind: 'API',
          cursor: undefined,
        }),
      ),
    );
    expect(api.getChangeFeed.mock.calls.at(-1)![0].entityRef).toBeUndefined();
    expect(entity).toHaveValue('');
    expect(kind).toHaveValue('API');
  });

  it('keeps metadata cursors out of event paging, resets pages on entity selection, and inspects the exact row by keyboard', async () => {
    // Arrange
    const { api, mount } = setup();
    const selected = {
      entityRef: deletedRef,
      kind: 'Group',
      namespace: 'teams',
      name: 'retired-team',
    };
    api.getEntities = jest
      .fn()
      .mockResolvedValue({ items: [selected], nextCursor: 'entities-only' });
    api.getKinds = jest.fn().mockImplementation(async request =>
      request.cursor
        ? { items: ['Group'] }
        : {
            items: Array.from({ length: 25 }, (_, i) => `Kind${i}`),
            nextCursor: 'kinds-only',
          },
    );
    api.getChangeFeed.mockImplementation(async request => ({
      items: [
        event(
          `${request.entityRef ? 'selected' : 'initial'}${request.cursor ? '-older' : ''}`,
          request.entityRef ?? componentRef,
        ),
      ],
      nextCursor: request.cursor ? undefined : 'events-only',
    }));
    api.getEntityVersion.mockImplementation(async ({ id, entityRef }) =>
      event(id, entityRef),
    );
    mount();
    await screen.findByRole('row', { name: /^Event initial,/ });
    const kind = screen.getByRole('combobox', { name: 'Kind' });
    fireEvent.focus(kind);
    fireEvent.keyDown(kind, { key: 'ArrowDown', code: 'ArrowDown' });
    const calls = api.getChangeFeed.mock.calls.length;
    // Act
    await screen.findByRole('option', { name: 'Kind24' });
    fireEvent.keyDown(kind, { key: 'Escape', code: 'Escape' });
    fireEvent.click(
      await screen.findByRole('button', { name: 'Load more kinds' }),
    );
    await waitFor(() =>
      expect(api.getKinds).toHaveBeenLastCalledWith({
        prefix: undefined,
        limit: 25,
        cursor: 'kinds-only',
      }),
    );
    expect(api.getChangeFeed).toHaveBeenCalledTimes(calls);
    fireEvent.keyDown(kind, { key: 'Escape', code: 'Escape' });
    fireEvent.click(screen.getByRole('button', { name: 'Load older' }));
    await waitFor(() =>
      expect(api.getChangeFeed).toHaveBeenLastCalledWith({
        limit: 25,
        cursor: 'events-only',
      }),
    );
    const entity = screen.getByRole('combobox', { name: 'Entity' });
    fireEvent.focus(entity);
    fireEvent.keyDown(entity, { key: 'ArrowDown', code: 'ArrowDown' });
    fireEvent.click(
      await screen.findByRole('option', {
        name: 'retired-team — Group / teams',
      }),
    );
    const row = await screen.findByRole('row', { name: /^Event selected,/ });
    act(() => row.focus());
    fireEvent.keyDown(row, { key: 'Enter', code: 'Enter' });
    fireEvent.keyUp(row, { key: 'Enter', code: 'Enter' });
    await screen.findByText('cycle-selected');
    // Assert
    expect(api.getChangeFeed).toHaveBeenLastCalledWith(
      expect.objectContaining({
        entityRef: deletedRef,
        kind: 'Group',
        cursor: undefined,
      }),
    );
    expect(
      screen.queryByRole('row', { name: /^Event initial,/ }),
    ).not.toBeInTheDocument();
    expect(api.getEntityVersion).toHaveBeenCalledWith({
      entityRef: deletedRef,
      id: 'selected',
    });
    fireEvent.click(screen.getByRole('button', { name: 'Load older' }));
    await waitFor(() =>
      expect(api.getChangeFeed).toHaveBeenLastCalledWith(
        expect.objectContaining({
          entityRef: deletedRef,
          kind: 'Group',
          cursor: 'events-only',
        }),
      ),
    );
  });

  it.each(['first', 'later'] as const)(
    'ignores %s metadata responses after reset and never reapplies a previous exact identity',
    async stage => {
      // Arrange
      const { api, mount } = setup();
      const selected = {
        entityRef: deletedRef,
        kind: 'Group',
        namespace: 'teams',
        name: 'retired-team',
      };
      const entities = deferred<HistoryEntitySearchResponse>();
      const kinds = deferred<HistoryKindSearchResponse>();
      api.getEntities = jest.fn();
      api.getKinds = jest.fn();
      if (stage === 'later') {
        jest
          .mocked(api.getEntities)
          .mockResolvedValueOnce({ items: [selected] });
        jest.mocked(api.getKinds).mockResolvedValueOnce({
          items: ['Group'],
          nextCursor: 'old-kinds',
        });
      }
      jest
        .mocked(api.getEntities)
        .mockReturnValueOnce(entities.promise)
        .mockResolvedValue({ items: [] });
      jest
        .mocked(api.getKinds)
        .mockReturnValueOnce(kinds.promise)
        .mockResolvedValue({ items: [] });
      mount();
      await screen.findByText('No recorded events match these filters.');
      const entity = screen.getByRole('combobox', { name: 'Entity' });
      fireEvent.focus(entity);
      fireEvent.keyDown(entity, { key: 'ArrowDown', code: 'ArrowDown' });
      await waitFor(() => expect(api.getEntities).toHaveBeenCalledTimes(1));
      if (stage === 'later') {
        fireEvent.click(
          await screen.findByRole('option', {
            name: 'retired-team — Group / teams',
          }),
        );
        fireEvent.focus(entity);
        jest.useFakeTimers();
        fireEvent.change(entity, { target: { value: 'obsolete-prefix' } });
        await act(async () => jest.advanceTimersByTime(300));
        jest.useRealTimers();
      }
      fireEvent.keyDown(entity, { key: 'Escape', code: 'Escape' });
      const kind = screen.getByRole('combobox', { name: 'Kind' });
      fireEvent.focus(kind);
      fireEvent.keyDown(kind, { key: 'ArrowDown', code: 'ArrowDown' });
      if (stage === 'later') {
        await screen.findByRole('option', { name: 'Group' });
        fireEvent.keyDown(kind, { key: 'Escape', code: 'Escape' });
        fireEvent.click(
          await screen.findByRole('button', { name: 'Load more kinds' }),
        );
      }
      await waitFor(() =>
        expect(api.getKinds).toHaveBeenCalledTimes(stage === 'later' ? 2 : 1),
      );
      await waitFor(() =>
        expect(api.getEntities).toHaveBeenCalledTimes(
          stage === 'later' ? 2 : 1,
        ),
      );
      // Act
      fireEvent.keyDown(kind, { key: 'Escape', code: 'Escape' });
      fireEvent.click(screen.getByRole('button', { name: 'Reset filters' }));
      await act(async () => {
        entities.resolve({
          items: [selected],
          nextCursor: 'obsolete-entities',
        });
        kinds.resolve({
          items: ['ObsoleteKind'],
          nextCursor: 'obsolete-kinds',
        });
      });
      const resetEntity = screen.getByRole('combobox', { name: 'Entity' });
      fireEvent.focus(resetEntity);
      fireEvent.keyDown(resetEntity, { key: 'ArrowDown', code: 'ArrowDown' });
      await screen.findByText('No matching entities.');
      fireEvent.keyDown(resetEntity, { key: 'Escape', code: 'Escape' });
      fireEvent.click(screen.getByRole('button', { name: /Source$/ }));
      fireEvent.click(screen.getByRole('option', { name: 'processing' }));
      // Assert: another filter change must not resurrect the pre-reset exact ref.
      await waitFor(() =>
        expect(api.getChangeFeed).toHaveBeenLastCalledWith(
          expect.objectContaining({
            source: 'processing',
            kind: undefined,
            cursor: undefined,
          }),
        ),
      );
      expect(api.getChangeFeed.mock.calls.at(-1)![0].entityRef).toBeUndefined();
      expect(resetEntity).toHaveValue('');
      expect(screen.getByRole('combobox', { name: 'Kind' })).toHaveValue(
        'All kinds',
      );
      expect(
        screen.queryByRole('option', { name: /retired-team|ObsoleteKind/ }),
      ).not.toBeInTheDocument();
      expect(
        screen.queryByRole('button', { name: 'Load more kinds' }),
      ).not.toBeInTheDocument();
    },
  );

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

  it('opens a shared comparison link and removes it on exit', async () => {
    // Arrange: the compared events need not be on the loaded page.
    const { api } = setup();
    const getEntityDiff = jest.fn().mockResolvedValue({
      entityRef: componentRef,
      from: { ...event('12'), snapshot: undefined },
      to: { ...event('9'), snapshot: undefined },
      changes: [],
    });
    function Location() {
      return <output aria-label="Location">{useLocation().search}</output>;
    }
    renderComponent(
      <MemoryRouter
        initialEntries={[
          `/catalog-history?keep=1&compare=12..9&compareRef=${componentRef}`,
        ]}
      >
        <TestApiProvider
          apis={[[catalogHistoryApiRef, { ...api, getEntityDiff }]]}
        >
          <CatalogHistoryPage />
          <Location />
        </TestApiProvider>
      </MemoryRouter>,
    );
    // Act
    await screen.findByRole('heading', {
      name: 'Comparing two recorded events',
    });
    fireEvent.click(screen.getByRole('button', { name: 'Exit comparison' }));
    // Assert
    expect(getEntityDiff).toHaveBeenCalledWith({
      entityRef: componentRef,
      from: { kind: 'history-row', id: '12' },
      to: { kind: 'history-row', id: '9' },
    });
    await waitFor(() =>
      expect(screen.getByLabelText('Location')).toHaveTextContent(/^\?keep=1$/),
    );
    expect(
      screen.queryByRole('heading', { name: 'Comparing two recorded events' }),
    ).not.toBeInTheDocument();
  });

  it('keeps loaded older events when a comparison starts, swaps, and exits', async () => {
    // Arrange: the second event comes from the older page.
    const { api } = setup();
    api.getChangeFeed.mockImplementation(async request =>
      request.cursor
        ? { items: [event('1')] }
        : {
            items: [{ ...event('2'), changedAt: '2026-10-24T12:00:00.000Z' }],
            nextCursor: 'older',
          },
    );
    api.getEntityVersion.mockImplementation(async request => event(request.id));
    const getEntityDiff = jest.fn(async request => ({
      entityRef: componentRef,
      from: event(request.from.id),
      to: event(request.to.id),
      changes: [],
    }));
    renderComponent(
      <MemoryRouter initialEntries={['/catalog-history']}>
        <TestApiProvider
          apis={[[catalogHistoryApiRef, { ...api, getEntityDiff }]]}
        >
          <CatalogHistoryPage />
        </TestApiProvider>
      </MemoryRouter>,
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Load older' }));
    fireEvent.click(await screen.findByRole('row', { name: /^Event 1,/ }));
    fireEvent.click(
      await screen.findByRole('button', { name: 'Compare with another event' }),
    );
    // Act
    fireEvent.click(screen.getByRole('row', { name: /^Event 2,/ }));
    await screen.findByRole('heading', {
      name: 'Comparing two recorded events',
    });
    fireEvent.click(screen.getByRole('button', { name: 'Swap' }));
    fireEvent.click(screen.getByRole('button', { name: 'Exit comparison' }));
    // Assert: URL updates do not reload the feed or drop older rows.
    await screen.findByRole('button', { name: 'Compare with another event' });
    expect(api.getChangeFeed).toHaveBeenCalledTimes(2);
    expect(screen.getByRole('row', { name: /^Event 1,/ })).toBeInTheDocument();
  });

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
