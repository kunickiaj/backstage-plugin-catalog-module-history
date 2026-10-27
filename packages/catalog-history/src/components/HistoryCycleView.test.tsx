/** @jsxRuntime automatic */
import '@testing-library/jest-dom';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type {
  HistoryCycleChange,
  HistoryCycleDetailResponse,
  HistoryEntityVersionResponse,
} from '@kunickiaj/backstage-plugin-catalog-history-common';
import {
  type CatalogHistoryApi,
  CatalogHistoryApiError,
} from '../api/CatalogHistoryApi';
import { HistoryCycleView } from './HistoryCycleView';
import { deferred } from '../__testUtils__/deferred';

// Public route registration is covered by the application integration tests.
jest.mock('@backstage/frontend-plugin-api', () => ({
  ...jest.requireActual('@backstage/frontend-plugin-api'),
  useRouteRef: () => undefined,
}));

const cycleId = 'preview/é ?#';
const entityRef = 'component:default/other-entity';
const changedAt = '2026-10-23T12:00:00.000Z';

function row(id = 'event-1', cycle = cycleId): HistoryCycleChange {
  return {
    id,
    entityRef,
    kind: 'Component',
    namespace: 'default',
    name: 'other-entity',
    cycleId: cycle,
    changedAt,
    source: 'provider',
    provider: 'recorded-provider',
    op: 'update',
    summary: {},
  };
}

function page(
  items = [row()],
  nextCursor?: string,
  cycle = cycleId,
): HistoryCycleDetailResponse {
  return {
    cycle: {
      cycleId: cycle,
      source: 'provider',
      provider: 'recorded-provider',
      mutationType: 'full',
      startedAt: '2026-10-23T11:00:00.000Z',
      finishedAt: changedAt,
      counts: { inserted: 2, updated: 30, deleted: 3, unchanged: 10 },
    },
    changes: { items, nextCursor },
  };
}

function detail(
  overrides: Partial<HistoryEntityVersionResponse> = {},
): HistoryEntityVersionResponse {
  return {
    ...row(),
    snapshot: {
      entityRef,
      kind: 'Component',
      namespace: 'default',
      name: 'other-entity',
      owner: 'group:default/selected-owner',
    },
    ...overrides,
  };
}

function setup() {
  const api = {
    getCycle: jest.fn<Promise<HistoryCycleDetailResponse>, [unknown]>(),
    getEntityTimeline: jest.fn(),
    getEntityVersion: jest.fn().mockResolvedValue(detail()),
    getChangeFeed: jest.fn(),
    listCycles: jest.fn(),
  } satisfies CatalogHistoryApi;
  api.getCycle.mockResolvedValue(page());
  return api;
}

function view(api: CatalogHistoryApi, id = cycleId) {
  return (
    <MemoryRouter
      initialEntries={[
        `/history?source=provider&cycleId=${encodeURIComponent(id)}&q=hello#saved`,
      ]}
    >
      <HistoryCycleView api={api} cycleId={id} />
    </MemoryRouter>
  );
}

function metadata() {
  return screen.getByRole('region', { name: 'Recorded cycle metadata' });
}

describe('HistoryCycleView recorded cycle contract', () => {
  it('does not invent field changes when runtime summaries were not recorded', async () => {
    // Arrange
    const api = setup();
    api.getCycle.mockResolvedValue(
      page([{ ...row(), summary: undefined } as unknown as HistoryCycleChange]),
    );

    // Act
    render(view(api));
    await screen.findByText(entityRef);

    // Assert
    expect(
      screen.queryByText(/owner changed|spec changed|No changes/i),
    ).not.toBeInTheDocument();
    expect(api.getEntityVersion).not.toHaveBeenCalled();
  });

  it('prevents rapid first-load retries from issuing concurrent requests', async () => {
    // Arrange
    const api = setup();
    const pending = deferred<HistoryCycleDetailResponse>();
    api.getCycle
      .mockRejectedValueOnce(new Error('offline'))
      .mockReturnValueOnce(pending.promise);
    render(view(api));
    await screen.findByRole('alert');
    const retry = screen.getByRole('button', { name: 'Retry' });

    // Act
    act(() => {
      fireEvent.click(retry);
      fireEvent.click(retry);
    });
    await act(async () => pending.resolve(page()));

    // Assert
    expect(api.getCycle).toHaveBeenCalledTimes(2);
    expect(screen.getByText('1 changes loaded · Newest first')).toBeVisible();
  });

  it('discards a failed old page and resets its retry cursor when the cycle changes', async () => {
    // Arrange
    const api = setup();
    const pending = deferred<HistoryCycleDetailResponse>();
    api.getCycle
      .mockResolvedValueOnce(page([row()], 'obsolete-cursor'))
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValueOnce(page([], undefined, 'next-cycle'));
    const rendered = render(view(api));
    fireEvent.click(
      await screen.findByRole('button', { name: 'Load more changes' }),
    );

    // Act
    rendered.rerender(view(api, 'next-cycle'));
    await screen.findByText('next-cycle');
    await act(async () => pending.reject(new CatalogHistoryApiError(404)));

    // Assert
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Retry' }),
    ).not.toBeInTheDocument();
    expect(api.getCycle).toHaveBeenLastCalledWith({
      cycleId: 'next-cycle',
      limit: 25,
      cursor: undefined,
    });
    expect(metadata()).toHaveTextContent('next-cycle');
  });

  it('clears an existing paging error and cursor on refresh', async () => {
    // Arrange
    const api = setup();
    const fresh = deferred<HistoryCycleDetailResponse>();
    api.getCycle
      .mockResolvedValueOnce(page([row()], 'failed-cursor'))
      .mockRejectedValueOnce(new CatalogHistoryApiError(500))
      .mockReturnValueOnce(fresh.promise);
    render(view(api));
    fireEvent.click(
      await screen.findByRole('button', { name: 'Load more changes' }),
    );
    await screen.findByRole('alert');

    // Act
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));

    // Assert
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.queryByText(entityRef)).not.toBeInTheDocument();
    expect(api.getCycle).toHaveBeenLastCalledWith({
      cycleId,
      limit: 25,
      cursor: undefined,
    });
    await act(async () => fresh.resolve(page([])));
    expect(screen.getByText(/No retained changed events/)).toBeVisible();
  });

  it('rejects a malformed later page while preserving the first page', async () => {
    // Arrange
    const api = setup();
    api.getCycle
      .mockResolvedValueOnce(page([row()], 'cursor'))
      .mockResolvedValueOnce(page([row('foreign-row', 'foreign-cycle')]));
    render(view(api));

    // Act
    fireEvent.click(
      await screen.findByRole('button', { name: 'Load more changes' }),
    );

    // Assert
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'could not be loaded',
    );
    expect(screen.getByText('1 changes loaded · Newest first')).toBeVisible();
    expect(metadata()).toBeVisible();
    expect(screen.queryByText(/foreign-row/)).not.toBeInTheDocument();
  });

  it('renders recorded metadata and totals independently of loaded changes', async () => {
    // Arrange
    const api = setup();

    // Act
    const { container } = render(view(api));
    await screen.findByText('1 changes loaded · Newest first');

    // Assert
    for (const text of [cycleId, 'provider', 'recorded-provider', 'full']) {
      expect(within(metadata()).getByText(text)).toBeInTheDocument();
    }
    for (const [label, count] of [
      ['Inserted', '2'],
      ['Updated', '30'],
      ['Deleted', '3'],
      ['Unchanged', '10'],
    ]) {
      expect(
        within(metadata()).getByText(label).nextElementSibling,
      ).toHaveTextContent(count);
    }
    expect(
      Array.from(container.querySelectorAll('time')).map(t => t.dateTime),
    ).toEqual(expect.arrayContaining(['2026-10-23T11:00:00.000Z', changedAt]));
    expect(api.getCycle.mock.calls).toEqual([
      [{ cycleId, limit: 25, cursor: undefined }],
    ]);
    expect(
      screen.getByRole('link', { name: 'Back to catalog history' }),
    ).toHaveAttribute('href', '/history?source=provider&q=hello#saved');
    expect(api.getEntityVersion).not.toHaveBeenCalled();
    expect(api.getEntityTimeline).not.toHaveBeenCalled();
    expect(api.getChangeFeed).not.toHaveBeenCalled();
    expect(api.listCycles).not.toHaveBeenCalled();
    expect(
      screen.queryByText(/No changes|owner changed|spec changed/i),
    ).not.toBeInTheDocument();
  });

  it('keeps a valid empty retained page and its nonzero recorded totals', async () => {
    // Arrange
    const api = setup();
    api.getCycle.mockResolvedValue(page([]));

    // Act
    render(view(api));

    // Assert
    expect(
      await screen.findByText(/No retained changed events are available/),
    ).toBeVisible();
    expect(metadata()).toHaveTextContent('30');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.queryByText(/No changes recorded/i)).not.toBeInTheDocument();
    expect(api.getEntityVersion).not.toHaveBeenCalled();
  });

  it.each(['', '   '])('rejects blank ID %j without making any request', id => {
    // Arrange
    const api = setup();

    // Act
    render(view(api, id));

    // Assert
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Cycle ID was not provided.',
    );
    expect(api.getCycle).not.toHaveBeenCalled();
    expect(api.getEntityVersion).not.toHaveBeenCalled();
  });

  it('supports legacy APIs without calling an absent cycle method', () => {
    // Arrange
    const api = setup();
    const legacy = { ...api, getCycle: undefined };

    // Act
    render(view(legacy));

    // Assert
    expect(screen.getByRole('status')).toHaveTextContent(
      'not supported by this installation',
    );
    expect(api.getCycle).not.toHaveBeenCalled();
    expect(api.getEntityVersion).not.toHaveBeenCalled();
  });

  it.each([
    [401, 'Sign in again'],
    [403, 'You do not have permission'],
    [
      404,
      'Refresh history or check whether this installation supports cycle details.',
    ],
    [501, 'Ask your administrator to upgrade'],
    [500, 'could not be loaded. Try again.'],
  ])(
    'explains HTTP %s without exposing backend details',
    async (status, message) => {
      // Arrange
      const api = setup();
      api.getCycle.mockRejectedValue(
        new CatalogHistoryApiError(Number(status)),
      );

      // Act
      render(view(api));

      // Assert
      expect(await screen.findByRole('alert')).toHaveTextContent(
        String(message),
      );
      expect(screen.getByRole('button', { name: 'Retry' })).toBeEnabled();
      expect(
        screen.queryByRole('region', { name: 'Recorded cycle metadata' }),
      ).not.toBeInTheDocument();
    },
  );

  it.each(['network', 'synchronous'])(
    'recovers from a %s failure without leaking raw errors',
    async mode => {
      // Arrange
      const api = setup();
      const error = new Error('<html>SELECT secret FROM history</html>', {
        cause: 'private cause',
      });
      api.getCycle.mockImplementationOnce(() => {
        if (mode === 'synchronous') throw error;
        return Promise.reject(error);
      });

      // Act
      render(view(api));
      expect(await screen.findByRole('alert')).toHaveTextContent(
        'could not be loaded. Try again.',
      );
      fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
      await screen.findByText('1 changes loaded · Newest first');

      // Assert
      expect(document.body).not.toHaveTextContent(
        /SELECT|private cause|<html>/,
      );
      expect(api.getCycle.mock.calls).toEqual([
        [{ cycleId, limit: 25, cursor: undefined }],
        [{ cycleId, limit: 25, cursor: undefined }],
      ]);
    },
  );

  it('preserves the API method receiver', async () => {
    // Arrange
    const api = setup();
    api.getCycle.mockImplementation(function load(this: CatalogHistoryApi) {
      if (this !== api) throw new Error('lost receiver');
      return Promise.resolve(page());
    });

    // Act
    render(view(api));

    // Assert
    expect(
      await screen.findByText('1 changes loaded · Newest first'),
    ).toBeVisible();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it.each([
    [
      'wrong header',
      { ...page(), cycle: { ...page().cycle, cycleId: 'wrong' } },
    ],
    ['wrong row', page([row('wrong', 'another-cycle')])],
    ['custom ID case mismatch', page([row('wrong', cycleId.toUpperCase())])],
    [
      'negative counts',
      {
        ...page(),
        cycle: {
          ...page().cycle,
          counts: { ...page().cycle.counts, updated: -1 },
        },
      },
    ],
    [
      'fractional counts',
      {
        ...page(),
        cycle: {
          ...page().cycle,
          counts: { ...page().cycle.counts, inserted: 0.5 },
        },
      },
    ],
    [
      'unsafe counts',
      {
        ...page(),
        cycle: {
          ...page().cycle,
          counts: {
            ...page().cycle.counts,
            deleted: Number.MAX_SAFE_INTEGER + 1,
          },
        },
      },
    ],
    [
      'missing metadata',
      { ...page(), cycle: { ...page().cycle, provider: undefined } },
    ],
    ['missing changes', { ...page(), changes: undefined }],
    ['bad cursor', { ...page(), changes: { items: [row()], nextCursor: 1 } }],
    ['empty row identity', page([{ ...row(), id: '' }])],
  ])(
    'rejects %s rather than displaying misleading data',
    async (_label, payload) => {
      // Arrange
      const api = setup();
      api.getCycle.mockResolvedValue(payload as HistoryCycleDetailResponse);

      // Act
      render(view(api));

      // Assert
      expect(await screen.findByRole('alert')).toHaveTextContent(
        'could not be loaded',
      );
      expect(
        screen.queryByRole('region', { name: 'Recorded cycle metadata' }),
      ).not.toBeInTheDocument();
      expect(screen.queryByText(entityRef)).not.toBeInTheDocument();
      expect(api.getEntityVersion).not.toHaveBeenCalled();
    },
  );

  it('accepts equivalent UUID case without altering the request ID', async () => {
    // Arrange
    const api = setup();
    const id = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    api.getCycle.mockResolvedValue(
      page([row('uuid-event', id.toUpperCase())], undefined, id.toUpperCase()),
    );

    // Act
    render(view(api, id));

    // Assert
    expect(
      await screen.findByText('1 changes loaded · Newest first'),
    ).toBeVisible();
    expect(api.getCycle).toHaveBeenCalledWith({
      cycleId: id,
      limit: 25,
      cursor: undefined,
    });
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it.each(['pointer', 'keyboard'])(
    'loads the selected cross-entity identity only after %s selection',
    async mode => {
      // Arrange
      const api = setup();
      render(view(api));
      const cell = await screen.findByText(entityRef);
      expect(api.getEntityVersion).not.toHaveBeenCalled();

      // Act
      if (mode === 'pointer') fireEvent.click(cell);
      else {
        const selectedRow = cell.closest('tr')!;
        act(() => selectedRow.focus());
        fireEvent.keyDown(selectedRow, { key: 'Enter', code: 'Enter' });
        fireEvent.keyUp(selectedRow, { key: 'Enter', code: 'Enter' });
      }
      await screen.findByRole('heading', { name: 'Recorded event' });

      // Assert
      expect(api.getEntityVersion.mock.calls).toEqual([
        [{ entityRef, id: 'event-1' }],
      ]);
      expect(
        screen.getByRole('region', { name: 'Recorded event details' }),
      ).toHaveFocus();
      expect(
        screen.getByRole('region', { name: 'Recorded entity fields' }),
      ).toHaveTextContent('group:default/selected-owner');
      expect(
        screen.queryByText('No saved field differences.'),
      ).not.toBeInTheDocument();
    },
  );

  it.each([{ id: 'wrong-id' }, { entityRef: 'component:default/wrong' }])(
    'rejects a mismatched detail identity %j',
    async mismatch => {
      // Arrange
      const api = setup();
      api.getEntityVersion.mockResolvedValue(
        detail({
          ...mismatch,
          snapshot: {
            entityRef,
            kind: 'Component',
            namespace: 'default',
            name: 'private-wrong-payload',
          },
        }),
      );
      render(view(api));

      // Act
      fireEvent.click(await screen.findByText(entityRef));

      // Assert
      expect(await screen.findByRole('alert')).toBeVisible();
      expect(
        screen.queryByText(/private-wrong-payload/),
      ).not.toBeInTheDocument();
      expect(
        screen.queryByRole('region', { name: 'Recorded entity fields' }),
      ).not.toBeInTheDocument();
    },
  );

  it('appends and deduplicates server pages without replacing recorded totals', async () => {
    // Arrange
    const api = setup();
    api.getCycle.mockResolvedValueOnce(page([row()], 'opaque-next'));
    const next = page([
      row(),
      { ...row('event-2'), entityRef: 'system:default/second' },
    ]);
    next.cycle.counts.updated = 999;
    api.getCycle.mockResolvedValueOnce(next);
    render(view(api));

    // Act
    fireEvent.click(
      await screen.findByRole('button', { name: 'Load more changes' }),
    );
    await screen.findByText('2 changes loaded · Newest first');

    // Assert
    expect(api.getCycle.mock.calls[1]).toEqual([
      { cycleId, limit: 25, cursor: 'opaque-next' },
    ]);
    expect(screen.getAllByText(entityRef)).toHaveLength(1);
    expect(screen.getByText('system:default/second')).toBeVisible();
    expect(metadata()).toHaveTextContent('30');
    expect(metadata()).not.toHaveTextContent('999');
    expect(
      screen.queryByRole('button', { name: 'Load more changes' }),
    ).not.toBeInTheDocument();
    expect(api.getEntityVersion).not.toHaveBeenCalled();
  });

  it('retains rows on page failure and retries the same cursor once during rapid clicks', async () => {
    // Arrange
    const api = setup();
    const failed = deferred<HistoryCycleDetailResponse>();
    const retried = deferred<HistoryCycleDetailResponse>();
    api.getCycle
      .mockResolvedValueOnce(page([row()], 'failed-cursor'))
      .mockReturnValueOnce(failed.promise)
      .mockReturnValueOnce(retried.promise);
    render(view(api));
    const load = await screen.findByRole('button', {
      name: 'Load more changes',
    });

    // Act
    fireEvent.click(load);
    fireEvent.click(load);
    await act(async () => failed.reject(new Error('page failed')));
    const retry = screen.getByRole('button', { name: 'Retry' });
    expect(metadata()).toBeVisible();
    expect(screen.getByText(entityRef)).toBeVisible();
    fireEvent.focus(window);
    fireEvent.click(retry);
    fireEvent.click(retry);
    await act(async () => retried.resolve(page([row('event-2')])));

    // Assert
    expect(api.getCycle.mock.calls).toEqual([
      [{ cycleId, limit: 25, cursor: undefined }],
      [{ cycleId, limit: 25, cursor: 'failed-cursor' }],
      [{ cycleId, limit: 25, cursor: 'failed-cursor' }],
    ]);
    expect(screen.getByText('2 changes loaded · Newest first')).toBeVisible();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it.each(['cycle', 'api', 'refresh'])(
    'hides old rows, metadata and selection on %s reset and ignores the pending page',
    async reset => {
      // Arrange
      const api = setup();
      const oldPage = deferred<HistoryCycleDetailResponse>();
      const freshPage = deferred<HistoryCycleDetailResponse>();
      api.getCycle
        .mockResolvedValueOnce(page([row()], 'old-cursor'))
        .mockReturnValueOnce(oldPage.promise)
        .mockReturnValueOnce(freshPage.promise);
      const nextApi = setup();
      nextApi.getCycle.mockReturnValue(freshPage.promise);
      const rendered = render(view(api));
      fireEvent.click(await screen.findByText(entityRef));
      await screen.findByRole('heading', { name: 'Recorded event' });
      fireEvent.click(
        screen.getByRole('button', { name: 'Load more changes' }),
      );

      // Act
      if (reset === 'refresh')
        fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
      else
        rendered.rerender(
          view(
            reset === 'api' ? nextApi : api,
            reset === 'cycle' ? 'new-cycle' : cycleId,
          ),
        );

      // Assert: no prior identity is displayed while the replacement is pending.
      expect(
        screen.queryByRole('region', { name: 'Recorded cycle metadata' }),
      ).not.toBeInTheDocument();
      expect(screen.queryByText(entityRef)).not.toBeInTheDocument();
      expect(
        screen.queryByRole('heading', { name: 'Recorded event' }),
      ).not.toBeInTheDocument();
      await act(async () => oldPage.resolve(page([row('obsolete')])));
      expect(screen.queryByText(/obsolete/)).not.toBeInTheDocument();
      const id = reset === 'cycle' ? 'new-cycle' : cycleId;
      await act(async () => freshPage.resolve(page([], undefined, id)));
      expect(metadata()).toHaveTextContent(id);
      const currentApi = reset === 'api' ? nextApi : api;
      expect(currentApi.getCycle).toHaveBeenLastCalledWith({
        cycleId: id,
        limit: 25,
        cursor: undefined,
      });
      expect(
        screen.getByRole('heading', { name: 'Select an event' }),
      ).toBeVisible();
    },
  );

  it.each(['resolve', 'reject'])(
    'ignores an obsolete first response that will %s after switching cycle',
    async outcome => {
      // Arrange
      const api = setup();
      const old = deferred<HistoryCycleDetailResponse>();
      api.getCycle
        .mockReturnValueOnce(old.promise)
        .mockResolvedValueOnce(page([], undefined, 'current-cycle'));
      const rendered = render(view(api));

      // Act
      rendered.rerender(view(api, 'current-cycle'));
      await screen.findByText('current-cycle');
      await act(async () => {
        if (outcome === 'resolve') old.resolve(page());
        else old.reject(new CatalogHistoryApiError(404));
      });

      // Assert
      expect(metadata()).toHaveTextContent('current-cycle');
      expect(screen.queryByText(entityRef)).not.toBeInTheDocument();
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    },
  );

  it('refreshes an in-flight first request without reusing its late response', async () => {
    // Arrange
    const api = setup();
    const old = deferred<HistoryCycleDetailResponse>();
    const fresh = deferred<HistoryCycleDetailResponse>();
    api.getCycle
      .mockReturnValueOnce(old.promise)
      .mockReturnValueOnce(fresh.promise);
    render(view(api));

    // Act
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    await act(async () => fresh.resolve(page([])));
    await act(async () => old.resolve(page()));

    // Assert
    expect(api.getCycle).toHaveBeenCalledTimes(2);
    expect(screen.getByText(/No retained changed events/)).toBeVisible();
    expect(screen.queryByText(entityRef)).not.toBeInTheDocument();
  });

  it.each(['resolve', 'reject'])(
    'ignores late selected detail %s after refresh',
    async outcome => {
      // Arrange
      const api = setup();
      const pending = deferred<HistoryEntityVersionResponse>();
      api.getEntityVersion.mockReturnValue(pending.promise);
      render(view(api));
      fireEvent.click(await screen.findByText(entityRef));

      // Act
      fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
      await screen.findByText('1 changes loaded · Newest first');
      await act(async () => {
        if (outcome === 'resolve') pending.resolve(detail());
        else pending.reject(new CatalogHistoryApiError(404));
      });

      // Assert
      expect(
        screen.getByRole('heading', { name: 'Select an event' }),
      ).toBeVisible();
      expect(
        screen.queryByRole('heading', { name: 'Recorded event' }),
      ).not.toBeInTheDocument();
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    },
  );

  it.each(['resolve', 'reject'])(
    'cleans up a pending request before unmount and late %s',
    async outcome => {
      // Arrange
      const api = setup();
      const pending = deferred<HistoryCycleDetailResponse>();
      api.getCycle.mockReturnValue(pending.promise);
      const errors = jest.spyOn(console, 'error').mockImplementation(() => {});
      const rendered = render(view(api));

      // Act
      try {
        rendered.unmount();
        await act(async () => {
          if (outcome === 'resolve') pending.resolve(page());
          else pending.reject(new Error('late network failure'));
        });

        // Assert
        expect(errors).not.toHaveBeenCalled();
      } finally {
        errors.mockRestore();
      }
    },
  );
});
