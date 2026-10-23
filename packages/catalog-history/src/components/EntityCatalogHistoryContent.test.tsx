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
import { TestApiProvider } from '@backstage/frontend-test-utils';
import { EntityProvider } from '@backstage/plugin-catalog-react';
import type {
  HistoryEntityVersionResponse,
  HistoryEntityTimelineResponse,
} from '@kunickiaj/backstage-plugin-catalog-history-common';
import {
  catalogHistoryApiRef,
  CatalogHistoryApiError,
  type CatalogHistoryApi,
} from '../api/CatalogHistoryApi';
import { EntityCatalogHistoryContent } from './EntityCatalogHistoryContent';

const entityRef = 'component:default/example';
const savedSnapshot = {
  entityRef,
  kind: 'Component',
  namespace: 'default',
  name: 'example',
  spec: { owner: 'snapshot-owner' },
};

function event(
  id: string,
  overrides: Partial<HistoryEntityVersionResponse> = {},
): HistoryEntityVersionResponse {
  return {
    id,
    entityRef,
    cycleId: `cycle-${id}`,
    source: 'provider',
    provider: 'directory-provider',
    op: 'update',
    changedAt: '2026-10-23T12:00:00.000Z',
    etag: 'etag-A',
    summary: { ownerChanged: true },
    ...overrides,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function setup() {
  const api: jest.Mocked<CatalogHistoryApi> = {
    getEntityTimeline: jest.fn().mockResolvedValue({ items: [] }),
    getEntityVersion: jest.fn(),
  };
  const mount = () =>
    render(
      <TestApiProvider apis={[[catalogHistoryApiRef, api]]}>
        <EntityProvider
          entity={{
            apiVersion: 'backstage.io/v1alpha1',
            kind: 'Component',
            metadata: { name: 'Example' },
          }}
        >
          <EntityCatalogHistoryContent />
        </EntityProvider>
      </TestApiProvider>,
    );
  return { api, mount };
}

describe('EntityCatalogHistoryContent', () => {
  it('shows the initial inspector and loaded count without adding row action buttons', async () => {
    // Arrange
    const { api, mount } = setup();
    api.getEntityTimeline.mockResolvedValue({
      items: [event('first'), event('second')],
    });

    // Act
    mount();
    await screen.findByRole('grid', {
      name: 'Entity history, newest recorded events first',
    });

    // Assert
    expect(
      screen.getByText('2 events loaded · Newest first'),
    ).toBeInTheDocument();
    expect(
      within(
        screen.getByRole('region', { name: 'Recorded event details' }),
      ).getByRole('heading', { name: 'Select an event' }),
    ).toBeInTheDocument();
    expect(screen.getAllByRole('row', { selected: false })).toHaveLength(2);
    expect(
      screen.queryByRole('button', { name: /Inspect|View event/ }),
    ).not.toBeInTheDocument();
    expect(api.getEntityVersion).not.toHaveBeenCalled();
  });

  it.each(['Enter', ' '])(
    'inspects a row with %s and keeps only one row selected',
    async key => {
      // Arrange
      const { api, mount } = setup();
      api.getEntityTimeline.mockResolvedValue({
        items: [event('first'), event('second')],
      });
      api.getEntityVersion.mockImplementation(async request =>
        event(request.id),
      );
      mount();
      const first = await screen.findByRole('row', { name: /^Event first,/ });
      fireEvent.click(first);
      await screen.findByText('cycle-first');
      const second = screen.getByRole('row', { name: /^Event second,/ });

      // Act
      act(() => second.focus());
      fireEvent.keyDown(second, {
        key,
        code: key === 'Enter' ? 'Enter' : 'Space',
      });
      fireEvent.keyUp(second, {
        key,
        code: key === 'Enter' ? 'Enter' : 'Space',
      });

      // Assert
      await screen.findByText('cycle-second');
      expect(screen.getAllByRole('row', { selected: true })).toEqual([second]);
      expect(first).toHaveAttribute('aria-selected', 'false');
      expect(
        screen.getByRole('region', { name: 'Recorded event details' }),
      ).toHaveFocus();
    },
  );

  it('shows update comparisons and exposes the exact current snapshot through its disclosure', async () => {
    // Arrange
    const { api, mount } = setup();
    api.getEntityTimeline.mockResolvedValue({ items: [event('selected')] });
    api.getEntityVersion.mockResolvedValue(
      event('selected', {
        snapshot: savedSnapshot,
        previousVersion: event('previous', {
          snapshot: { ...savedSnapshot, spec: { owner: 'old-owner' } },
        }),
        changes: [
          {
            path: ['spec', 'owner'],
            op: 'replace',
            before: 'old-owner',
            after: 'snapshot-owner',
          },
        ],
      }),
    );
    mount();

    // Act
    fireEvent.click(
      await screen.findByRole('row', { name: /^Event selected,/ }),
    );
    const comparison = await screen.findByRole('region', {
      name: 'Changes from previous event',
    });
    const raw = screen.getByText('Raw snapshot');

    // Assert
    expect(within(comparison).getByText('/spec/owner')).toBeInTheDocument();
    expect(
      within(comparison).getByText('Before').nextElementSibling,
    ).toHaveTextContent('"old-owner"');
    expect(
      within(comparison).getByText('After').nextElementSibling,
    ).toHaveTextContent('"snapshot-owner"');
    expect(raw.closest('details')).not.toHaveAttribute('open');
    fireEvent.click(raw);
    expect(raw.closest('details')).toHaveAttribute('open');
    expect(
      within(raw.closest('details')!).getByText(/"snapshot-owner"/),
    ).toBeVisible();
  });

  it.each([
    {
      previousVersion: undefined,
      changes: undefined,
      message: 'No previous saved snapshot is available for comparison.',
    },
    {
      previousVersion: event('deleted-prior', { op: 'delete' }),
      changes: undefined,
      message: 'No previous saved snapshot is available for comparison.',
    },
    {
      previousVersion: event('same', { snapshot: savedSnapshot }),
      changes: [],
      message: 'No saved field differences.',
    },
  ])(
    'explains update comparison gaps without hiding the current snapshot: $message',
    async context => {
      // Arrange
      const { api, mount } = setup();
      api.getEntityTimeline.mockResolvedValue({ items: [event('selected')] });
      api.getEntityVersion.mockResolvedValue(
        event('selected', {
          snapshot: savedSnapshot,
          previousVersion: context.previousVersion,
          changes: context.changes,
        }),
      );
      mount();

      // Act
      fireEvent.click(
        await screen.findByRole('row', { name: /^Event selected,/ }),
      );

      // Assert
      await screen.findByText(context.message);
      expect(screen.queryByText('Before')).not.toBeInTheDocument();
      const raw = screen.getByText('Raw snapshot').closest('details')!;
      if (!raw.open) fireEvent.click(within(raw).getByText('Raw snapshot'));
      expect(within(raw).getByText(/"snapshot-owner"/)).toBeVisible();
    },
  );

  it('labels the last saved snapshot and its provenance separately from the deletion payload', async () => {
    // Arrange
    const { api, mount } = setup();
    const previousVersion = event('before-delete', {
      snapshot: savedSnapshot,
      changedAt: '2026-10-22T12:00:00.000Z',
    });
    api.getEntityTimeline.mockResolvedValue({
      items: [event('deleted', { op: 'delete' })],
    });
    api.getEntityVersion.mockResolvedValue(
      event('deleted', { op: 'delete', etag: undefined, previousVersion }),
    );
    mount();

    // Act
    fireEvent.click(
      await screen.findByRole('row', { name: /^Event deleted,/ }),
    );
    const previous = await screen.findByRole('region', {
      name: 'Last recorded snapshot before deletion',
    });

    // Assert
    expect(
      screen.getByText(
        'Entity deleted. This event is a deletion record and has no snapshot.',
      ),
    ).toBeInTheDocument();
    expect(
      within(previous).getByText(/not the deletion payload/),
    ).toBeInTheDocument();
    expect(within(previous).getByText('before-delete')).toBeInTheDocument();
    expect(
      within(previous).getByText('cycle-before-delete'),
    ).toBeInTheDocument();
    expect(
      within(previous).getByText('directory-provider'),
    ).toBeInTheDocument();
    expect(within(previous).getByText(/"snapshot-owner"/)).toBeInTheDocument();
    expect(screen.queryByText('Raw snapshot')).not.toBeInTheDocument();
    expect(
      screen.queryByRole('region', { name: 'Changes from previous event' }),
    ).not.toBeInTheDocument();
  });
  it('focuses the detail region immediately while the selected event is loading', async () => {
    // Arrange: moving focus must not wait for the detail request to finish.
    const { api, mount } = setup();
    const detail = deferred<HistoryEntityVersionResponse>();
    api.getEntityTimeline.mockResolvedValue({ items: [event('selected')] });
    api.getEntityVersion.mockReturnValue(detail.promise);
    mount();
    const button = await screen.findByRole('row', {
      name: /^Event selected,/,
    });
    act(() => button.focus());

    // Act
    fireEvent.click(button);

    // Assert
    const region = screen.getByRole('region', {
      name: 'Recorded event details',
    });
    expect(region).toHaveFocus();
    expect(within(region).getByRole('status')).toHaveTextContent(
      'Loading recorded event',
    );
    await act(async () => detail.resolve(event('selected')));
    expect(region).toHaveFocus();
    expect(within(region).getByText('cycle-selected')).toBeInTheDocument();
  });

  it('restores focus to loaded details when the same event is selected again without refetching', async () => {
    // Arrange: the user has moved away from the previously selected detail.
    const { api, mount } = setup();
    api.getEntityTimeline.mockResolvedValue({ items: [event('selected')] });
    api.getEntityVersion.mockResolvedValue(event('selected'));
    mount();
    const button = await screen.findByRole('row', {
      name: /^Event selected,/,
    });
    fireEvent.click(button);
    await screen.findByText('cycle-selected');
    const provider = screen.getByRole('textbox', { name: 'Provider' });
    act(() => provider.focus());
    expect(provider).toHaveFocus();

    // Act
    const currentRow = screen.getByRole('row', { name: /^Event selected,/ });
    fireEvent.click(currentRow);

    // Assert
    expect(
      screen.getByRole('region', { name: 'Recorded event details' }),
    ).toHaveFocus();
    expect(api.getEntityVersion).toHaveBeenCalledTimes(1);
    expect(api.getEntityVersion).toHaveBeenCalledWith({
      entityRef,
      id: 'selected',
    });
  });

  it('rejects a detail response for the wrong entity instead of displaying its snapshot', async () => {
    // Arrange
    const { api, mount } = setup();
    api.getEntityTimeline.mockResolvedValue({ items: [event('selected')] });
    api.getEntityVersion.mockResolvedValue(
      event('selected', {
        entityRef: 'component:default/another',
        snapshot: {
          entityRef: 'component:default/another',
          kind: 'Component',
          namespace: 'default',
          name: 'another',
        },
      }),
    );
    mount();

    // Act
    fireEvent.click(
      await screen.findByRole('row', { name: /^Event selected,/ }),
    );

    // Assert
    await screen.findByText('History could not be loaded. Try again.');
    expect(screen.queryByText('Raw snapshot')).not.toBeInTheDocument();
  });

  it('explains a missing exact event without calling it a disabled backend and retries the same ID', async () => {
    // Arrange
    const { api, mount } = setup();
    api.getEntityTimeline.mockResolvedValue({ items: [event('selected')] });
    api.getEntityVersion
      .mockRejectedValueOnce(new CatalogHistoryApiError(404))
      .mockResolvedValueOnce(event('selected'));
    mount();
    fireEvent.click(
      await screen.findByRole('row', { name: /^Event selected,/ }),
    );
    await screen.findByText(
      'This recorded event is no longer available. Refresh the timeline.',
    );

    // Act
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));

    // Assert
    await screen.findByText('cycle-selected');
    expect(api.getEntityVersion).toHaveBeenLastCalledWith({
      entityRef,
      id: 'selected',
    });
    expect(api.getEntityVersion).toHaveBeenCalledTimes(2);
    expect(
      screen.queryByText(/check that the history backend is enabled/),
    ).not.toBeInTheDocument();
  });

  it('loads the normalized context entity, then shows an empty result without detail requests', async () => {
    // Arrange
    const { api, mount } = setup();
    const page = deferred<HistoryEntityTimelineResponse>();
    api.getEntityTimeline.mockReturnValue(page.promise);

    // Act
    mount();

    // Assert: loading and empty are distinct, with no invented event snapshot.
    expect(screen.getByRole('status')).toHaveTextContent('Loading history');
    expect(api.getEntityTimeline).toHaveBeenCalledWith({
      entityRef,
      limit: 25,
      cursor: undefined,
    });
    await act(async () => page.resolve({ items: [] }));
    expect(screen.getByRole('status')).toHaveTextContent(
      'No recorded events match',
    );
    expect(
      screen.queryByRole('button', { name: 'Load older' }),
    ).not.toBeInTheDocument();
    expect(api.getEntityVersion).not.toHaveBeenCalled();
  });

  it.each([
    [401, /Sign in again/],
    [403, /do not have permission/],
    [404, /check that the history backend is enabled/],
    [500, /History could not be loaded/],
  ])('explains HTTP %s safely and supports retry', async (status, message) => {
    // Arrange
    const { api, mount } = setup();
    api.getEntityTimeline.mockRejectedValueOnce(
      new CatalogHistoryApiError(status as number),
    );

    // Act
    mount();
    await screen.findByText(message as RegExp);
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));

    // Assert
    await screen.findByText('No recorded events match these filters.');
    expect(api.getEntityTimeline).toHaveBeenCalledTimes(2);
  });

  it('hides raw network failures', async () => {
    // Arrange
    const { api, mount } = setup();
    api.getEntityTimeline.mockRejectedValue(
      new Error('private database credentials'),
    );

    // Act
    mount();

    // Assert
    await screen.findByText('History could not be loaded. Try again.');
    expect(screen.queryByText(/private database/)).not.toBeInTheDocument();
  });

  it('appends older events using the opaque cursor and renders capture provenance and operation', async () => {
    // Arrange
    const { api, mount } = setup();
    api.getEntityTimeline
      .mockResolvedValueOnce({
        items: [event('newest')],
        nextCursor: 'opaque+/=',
      })
      .mockResolvedValueOnce({
        items: [
          event('older', {
            source: 'reconciler',
            provider: 'reconciler',
            op: 'delete',
          }),
        ],
      });

    // Act
    mount();
    await screen.findByRole('row', { name: /^Event newest,/ });
    fireEvent.click(screen.getByRole('button', { name: 'Load older' }));

    // Assert
    await screen.findByRole('row', { name: /^Event older,/ });
    const rows = screen.getAllByRole('row').slice(1);
    expect(rows).toHaveLength(2);
    expect(rows[0].querySelector('time')).toHaveAttribute(
      'dateTime',
      '2026-10-23T12:00:00.000Z',
    );
    expect(rows[0].querySelector('time')).toHaveAttribute(
      'title',
      '2026-10-23T12:00:00.000Z',
    );
    expect(rows[0]).toHaveTextContent('provider');
    expect(rows[0]).toHaveTextContent('directory-provider');
    expect(rows[0]).toHaveTextContent('update');
    expect(rows[1]).toHaveTextContent('reconciler');
    expect(rows[1]).toHaveTextContent('delete');
    expect(api.getEntityTimeline).toHaveBeenLastCalledWith({
      entityRef,
      limit: 25,
      cursor: 'opaque+/=',
    });
    expect(
      screen.queryByRole('button', { name: 'Load older' }),
    ).not.toBeInTheDocument();
  });

  it('retains loaded events when an older page fails and retries that cursor', async () => {
    // Arrange
    const { api, mount } = setup();
    api.getEntityTimeline
      .mockResolvedValueOnce({
        items: [event('newest')],
        nextCursor: 'page-two',
      })
      .mockRejectedValueOnce(new Error('private backend details'))
      .mockResolvedValueOnce({ items: [event('older')] });

    // Act
    mount();
    await screen.findByRole('button', { name: 'Load older' });
    fireEvent.click(screen.getByRole('button', { name: 'Load older' }));
    await screen.findByText('History could not be loaded. Try again.');

    // Assert: retry must not discard the successful first page or fetch it again.
    expect(
      screen.getByRole('row', { name: /^Event newest,/ }),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await screen.findByRole('row', { name: /^Event older,/ });
    expect(screen.getAllByRole('row')).toHaveLength(3);
    expect(api.getEntityTimeline).toHaveBeenLastCalledWith({
      entityRef,
      limit: 25,
      cursor: 'page-two',
    });
  });

  it('refreshes from the first page and clears the selected detail', async () => {
    // Arrange
    const { api, mount } = setup();
    api.getEntityTimeline
      .mockResolvedValueOnce({
        items: [event('old')],
        nextCursor: 'old-cursor',
      })
      .mockResolvedValueOnce({ items: [event('fresh')] });
    api.getEntityVersion.mockResolvedValue(event('old'));
    mount();
    fireEvent.click(await screen.findByRole('row', { name: /^Event old,/ }));
    await screen.findByRole('heading', { name: 'Recorded event' });

    // Act
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));

    // Assert
    await screen.findByRole('row', { name: /^Event fresh,/ });
    expect(api.getEntityTimeline).toHaveBeenLastCalledWith({
      entityRef,
      limit: 25,
      cursor: undefined,
    });
    expect(
      screen.queryByRole('row', { name: /^Event old,/ }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('heading', { name: 'Recorded event' }),
    ).not.toBeInTheDocument();
  });

  it('applies filters from the first page and ignores an older-page response from previous filters', async () => {
    // Arrange
    const { api, mount } = setup();
    const obsolete = deferred<HistoryEntityTimelineResponse>();
    api.getEntityTimeline
      .mockResolvedValueOnce({
        items: [event('old')],
        nextCursor: 'old-cursor',
      })
      .mockReturnValueOnce(obsolete.promise)
      .mockResolvedValueOnce({ items: [event('filtered')] });
    mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Load older' }));

    // Act
    jest.useFakeTimers();
    fireEvent.change(screen.getByRole('textbox', { name: 'Provider' }), {
      target: { value: ' chosen-provider ' },
    });
    act(() => jest.advanceTimersByTime(299));
    expect(api.getEntityTimeline).toHaveBeenCalledTimes(2);
    act(() => jest.advanceTimersByTime(1));
    jest.useRealTimers();
    await screen.findByRole('row', { name: /^Event filtered,/ });
    await act(async () =>
      obsolete.resolve({
        items: [event('obsolete')],
        nextCursor: 'obsolete-cursor',
      }),
    );

    // Assert
    expect(api.getEntityTimeline).toHaveBeenLastCalledWith(
      expect.objectContaining({
        provider: 'chosen-provider',
        cursor: undefined,
      }),
    );
    expect(
      screen.queryByRole('row', { name: /^Event old,/ }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('row', { name: /^Event obsolete,/ }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Load older' }),
    ).not.toBeInTheDocument();
  });

  it('resets an automatically applied filter from the first page and clears its selected detail', async () => {
    // Arrange
    const { api, mount } = setup();
    api.getEntityTimeline
      .mockResolvedValueOnce({ items: [event('initial')] })
      .mockResolvedValueOnce({
        items: [event('filtered')],
        nextCursor: 'filtered-older',
      })
      .mockResolvedValueOnce({ items: [event('reset')] });
    api.getEntityVersion.mockResolvedValue(event('filtered'));
    mount();
    await screen.findByRole('row', { name: /^Event initial,/ });
    jest.useFakeTimers();
    fireEvent.change(screen.getByRole('textbox', { name: 'Provider' }), {
      target: { value: 'chosen-provider' },
    });
    act(() => jest.advanceTimersByTime(300));
    jest.useRealTimers();
    fireEvent.click(
      await screen.findByRole('row', { name: /^Event filtered,/ }),
    );
    await screen.findByText('cycle-filtered');

    // Act
    fireEvent.click(screen.getByRole('button', { name: 'Reset filters' }));

    // Assert
    await screen.findByRole('row', { name: /^Event reset,/ });
    expect(api.getEntityTimeline).toHaveBeenCalledTimes(3);
    expect(api.getEntityTimeline).toHaveBeenLastCalledWith({
      entityRef,
      limit: 25,
      cursor: undefined,
    });
    expect(
      screen.getByRole('heading', { name: 'Select an event' }),
    ).toBeInTheDocument();
    expect(screen.queryByText('cycle-filtered')).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Load older' }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Provider' })).toHaveValue('');
  });

  it('selects exact row IDs for A-B-A versions rather than reusing an ETag match', async () => {
    // Arrange
    const { api, mount } = setup();
    const events = [
      event('first-A'),
      event('B', { etag: 'etag-B' }),
      event('second-A'),
    ];
    api.getEntityTimeline.mockResolvedValue({ items: events });
    api.getEntityVersion.mockImplementation(async request => event(request.id));
    mount();
    await screen.findByRole('row', { name: /^Event second-A,/ });

    // Act
    for (const id of ['first-A', 'B', 'second-A']) {
      fireEvent.click(
        screen.getByRole('row', { name: new RegExp(`^Event ${id},`) }),
      );
      await waitFor(() =>
        expect(api.getEntityVersion).toHaveBeenLastCalledWith({
          entityRef,
          id,
        }),
      );
      await screen.findByRole('heading', { name: 'Recorded event' });
    }

    // Assert
    expect(
      api.getEntityVersion.mock.calls.map(([request]) => request.id),
    ).toEqual(['first-A', 'B', 'second-A']);
    expect(screen.getByText('cycle-second-A')).toBeInTheDocument();
    expect(screen.getByText('etag-A')).toBeInTheDocument();
  });

  it('does not replace selected detail when a previous version response arrives late', async () => {
    // Arrange
    const { api, mount } = setup();
    const obsolete = deferred<HistoryEntityVersionResponse>();
    api.getEntityTimeline.mockResolvedValue({
      items: [event('old'), event('selected')],
    });
    api.getEntityVersion
      .mockReturnValueOnce(obsolete.promise)
      .mockResolvedValueOnce(event('selected'));
    mount();
    fireEvent.click(await screen.findByRole('row', { name: /^Event old,/ }));
    expect(screen.getByText('Loading recorded event…')).toBeInTheDocument();

    // Act
    act(() => screen.getByRole('row', { name: /^Event selected,/ }).focus());
    fireEvent.click(screen.getByRole('row', { name: /^Event selected,/ }));
    await screen.findByText('cycle-selected');
    await act(async () =>
      obsolete.resolve(
        event('old', {
          previousVersion: event('obsolete-previous', {
            snapshot: savedSnapshot,
          }),
          changes: [
            {
              path: ['spec', 'owner'],
              op: 'replace',
              before: 'obsolete-owner',
              after: 'obsolete-replacement',
            },
          ],
        }),
      ),
    );

    // Assert
    expect(
      screen.getByRole('region', { name: 'Recorded event details' }),
    ).toHaveFocus();
    expect(api.getEntityVersion).toHaveBeenLastCalledWith({
      entityRef,
      id: 'selected',
    });
    expect(screen.getByText('cycle-selected')).toBeInTheDocument();
    expect(screen.queryByText('cycle-old')).not.toBeInTheDocument();
    expect(
      screen.queryByText(
        /obsolete-owner|obsolete-replacement|obsolete-previous/,
      ),
    ).not.toBeInTheDocument();
  });

  it('renders an exact snapshot for updates but no fabricated snapshot for delete tombstones', async () => {
    // Arrange
    const { api, mount } = setup();
    const snapshot = {
      entityRef,
      kind: 'Component',
      namespace: 'default',
      name: 'example',
      spec: { owner: 'snapshot-owner' },
    };
    api.getEntityTimeline.mockResolvedValue({
      items: [event('update'), event('delete', { op: 'delete' })],
    });
    api.getEntityVersion
      .mockResolvedValueOnce(event('update', { snapshot }))
      .mockResolvedValueOnce(event('delete', { op: 'delete' }));
    mount();

    // Act
    fireEvent.click(await screen.findByRole('row', { name: /^Event update,/ }));
    await screen.findByText(/"snapshot-owner"/);
    fireEvent.click(screen.getByRole('row', { name: /^Event delete,/ }));

    // Assert
    await screen.findByText(
      'Entity deleted. This event is a deletion record and has no snapshot.',
    );
    expect(screen.queryByText('Raw snapshot')).not.toBeInTheDocument();
    expect(screen.queryByText(/"snapshot-owner"/)).not.toBeInTheDocument();
    expect(
      screen.getByText(
        'The last recorded snapshot before deletion is unavailable.',
      ),
    ).toBeInTheDocument();
    expect(
      within(screen.getByRole('grid')).getByRole('gridcell', {
        name: 'delete',
      }),
    ).toBeInTheDocument();
  });
});
