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
  it('focuses the detail region immediately while the selected event is loading', async () => {
    // Arrange: moving focus must not wait for the detail request to finish.
    const { api, mount } = setup();
    const detail = deferred<HistoryEntityVersionResponse>();
    api.getEntityTimeline.mockResolvedValue({ items: [event('selected')] });
    api.getEntityVersion.mockReturnValue(detail.promise);
    mount();
    const button = await screen.findByRole('button', {
      name: 'View event selected',
    });
    button.focus();

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
    const button = await screen.findByRole('button', {
      name: 'View event selected',
    });
    fireEvent.click(button);
    await screen.findByText('cycle-selected');
    const provider = screen.getByRole('textbox', { name: 'Provider' });
    provider.focus();
    expect(provider).toHaveFocus();

    // Act
    fireEvent.click(button);

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
      await screen.findByRole('button', { name: 'View event selected' }),
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
      await screen.findByRole('button', { name: 'View event selected' }),
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
    await screen.findByRole('button', { name: 'View event newest' });
    fireEvent.click(screen.getByRole('button', { name: 'Load older' }));

    // Assert
    await screen.findByRole('button', { name: 'View event older' });
    const rows = screen.getAllByRole('row').slice(1);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent('2026-10-23T12:00:00.000Z');
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
      screen.getByRole('button', { name: 'View event newest' }),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await screen.findByRole('button', { name: 'View event older' });
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
    fireEvent.click(
      await screen.findByRole('button', { name: 'View event old' }),
    );
    await screen.findByRole('heading', { name: 'Recorded event' });

    // Act
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));

    // Assert
    await screen.findByRole('button', { name: 'View event fresh' });
    expect(api.getEntityTimeline).toHaveBeenLastCalledWith({
      entityRef,
      limit: 25,
      cursor: undefined,
    });
    expect(
      screen.queryByRole('button', { name: 'View event old' }),
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
    fireEvent.change(screen.getByRole('textbox', { name: 'Provider' }), {
      target: { value: ' chosen-provider ' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Apply filters' }));
    await screen.findByRole('button', { name: 'View event filtered' });
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
      screen.queryByRole('button', { name: 'View event old' }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'View event obsolete' }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Load older' }),
    ).not.toBeInTheDocument();
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
    await screen.findByRole('button', { name: 'View event second-A' });

    // Act
    for (const id of ['first-A', 'B', 'second-A']) {
      fireEvent.click(screen.getByRole('button', { name: `View event ${id}` }));
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
    fireEvent.click(
      await screen.findByRole('button', { name: 'View event old' }),
    );
    expect(screen.getByText('Loading recorded event…')).toBeInTheDocument();

    // Act
    screen.getByRole('button', { name: 'View event selected' }).focus();
    fireEvent.click(
      screen.getByRole('button', { name: 'View event selected' }),
    );
    await screen.findByText('cycle-selected');
    await act(async () => obsolete.resolve(event('old')));

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
    fireEvent.click(
      await screen.findByRole('button', { name: 'View event update' }),
    );
    await screen.findByText(/"snapshot-owner"/);
    fireEvent.click(screen.getByRole('button', { name: 'View event delete' }));

    // Assert
    await screen.findByText(
      'Entity deleted. This event is a deletion record and has no snapshot.',
    );
    expect(screen.queryByText('Raw snapshot')).not.toBeInTheDocument();
    expect(screen.queryByText(/"snapshot-owner"/)).not.toBeInTheDocument();
    expect(
      within(screen.getByRole('table')).getByText('delete', { selector: 'td' }),
    ).toBeInTheDocument();
  });
});
