/** @jsxRuntime automatic */
import '@testing-library/jest-dom';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import type { HistoryEntityVersionResponse } from '@kunickiaj/backstage-plugin-catalog-history-common';
import {
  type CatalogHistoryApi,
  CatalogHistoryApiError,
} from '../api/CatalogHistoryApi';
import { HistoryDetail } from './HistoryDetail';

const entityRef = 'component:default/recorded';
const snapshot = {
  entityRef,
  kind: 'Component',
  namespace: 'default',
  name: 'recorded',
  owner: 'group:default/captured-owner',
  orphan: false,
  spec: { owner: 'spec-only-owner', replicas: 0 },
};

function event(
  overrides: Partial<HistoryEntityVersionResponse> = {},
): HistoryEntityVersionResponse {
  return {
    id: 'selected',
    entityRef,
    cycleId: 'captured-cycle',
    source: 'processing',
    provider: 'captured-provider',
    op: 'update',
    changedAt: '2026-10-23T12:00:00.000Z',
    etag: 'captured-etag',
    summary: {},
    snapshot,
    ...overrides,
  };
}

function setup() {
  const api: jest.Mocked<CatalogHistoryApi> = {
    getEntityTimeline: jest.fn(),
    getEntityVersion: jest.fn(),
  };
  return { api, props: { api, entityRef, id: 'selected' } };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(res => {
    resolve = res;
  });
  return { promise, resolve };
}

describe('HistoryDetail', () => {
  it.each(['insert', 'update'] as const)(
    'shows only the selected %s snapshot alongside exact provenance and raw JSON',
    async op => {
      // Arrange
      const { api, props } = setup();
      api.getEntityVersion.mockResolvedValue(
        event({ op, summary: { ownerChanged: true } }),
      );

      // Act
      const { container } = render(<HistoryDetail {...props} />);
      const fields = await screen.findByRole('region', {
        name: 'Recorded entity fields',
      });

      // Assert
      expect(
        within(fields).getByText('captured-owner', { exact: false }),
      ).toHaveTextContent('group:default/captured-owner');
      expect(screen.getByRole('region', { name: 'Spec' })).toHaveTextContent(
        '"spec-only-owner"',
      );
      for (const text of [
        'selected',
        entityRef,
        'captured-cycle',
        'processing',
        'captured-provider',
        'captured-etag',
      ]) {
        expect(screen.getByText(text)).toBeInTheDocument();
      }
      expect(container.querySelector('time')).toHaveAttribute(
        'datetime',
        '2026-10-23T12:00:00.000Z',
      );
      const raw = screen.getByText('Raw snapshot').closest('details')!;
      expect(raw).toHaveAttribute('open');
      expect(JSON.parse(raw.querySelector('pre')!.textContent!)).toEqual(
        snapshot,
      );
      const summary = screen.getByText('Change summary').closest('details')!;
      fireEvent.click(within(summary).getByText('Change summary'));
      expect(JSON.parse(summary.querySelector('pre')!.textContent!)).toEqual({
        ownerChanged: true,
      });
      expect(api.getEntityVersion.mock.calls).toEqual([
        [{ entityRef, id: 'selected' }],
      ]);
      expect(api.getEntityTimeline).not.toHaveBeenCalled();
      expect(screen.queryByText(/\blive\b/i)).not.toBeInTheDocument();
    },
  );

  it.each([
    {
      changes: undefined,
      message: 'No previous saved snapshot is available for comparison.',
      open: true,
    },
    { changes: [], message: 'No saved field differences.', open: false },
  ])(
    'preserves comparison availability and raw disclosure default: $message',
    async ({ changes, message, open }) => {
      // Arrange
      const { api, props } = setup();
      api.getEntityVersion.mockResolvedValue(event({ changes }));

      // Act
      render(<HistoryDetail {...props} />);
      await screen.findByText(message);

      // Assert
      const raw = screen.getByText('Raw snapshot').closest('details')!;
      expect(raw.open).toBe(open);
      if (!open) fireEvent.click(within(raw).getByText('Raw snapshot'));
      expect(raw).toHaveAttribute('open');
      expect(
        within(raw).getByText(/"group:default\/captured-owner"/),
      ).toBeVisible();
      expect(
        screen.getByRole('region', { name: 'Recorded entity fields' }),
      ).toBeInTheDocument();
    },
  );

  it('preserves previous-event changes while presenting current fields separately', async () => {
    // Arrange
    const { api, props } = setup();
    api.getEntityVersion.mockResolvedValue(
      event({
        previousVersion: event({
          id: 'prior',
          snapshot: { ...snapshot, owner: 'previous-owner' },
        }),
        changes: [
          {
            path: ['owner'],
            op: 'replace',
            before: 'previous-owner',
            after: snapshot.owner,
          },
        ],
      }),
    );

    // Act
    render(<HistoryDetail {...props} />);
    const changes = await screen.findByRole('region', {
      name: 'Changes from previous event',
    });

    // Assert
    expect(within(changes).getByText('/owner')).toBeInTheDocument();
    expect(
      within(changes).getByText('Before').nextElementSibling,
    ).toHaveTextContent('"previous-owner"');
    expect(
      within(changes).getByText('After').nextElementSibling,
    ).toHaveTextContent(JSON.stringify(snapshot.owner));
    const fields = screen.getByRole('region', {
      name: 'Recorded entity fields',
    });
    expect(fields).toHaveTextContent(snapshot.owner);
    expect(fields).not.toHaveTextContent('previous-owner');
    expect(
      screen.getByText('Raw snapshot').closest('details'),
    ).not.toHaveAttribute('open');
  });

  it('does not invent structured fields when an older response omits its snapshot', async () => {
    // Arrange
    const { api, props } = setup();
    api.getEntityVersion.mockResolvedValue(event({ snapshot: undefined }));

    // Act
    render(<HistoryDetail {...props} />);
    await screen.findByText('No snapshot was recorded for this event.');

    // Assert
    expect(
      screen.queryByRole('region', { name: 'Recorded entity fields' }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText('Raw snapshot')).not.toBeInTheDocument();
    expect(
      screen.getByText(
        'No previous saved snapshot is available for comparison.',
      ),
    ).toBeInTheDocument();
    expect(
      screen.queryByText('No saved field differences.'),
    ).not.toBeInTheDocument();
  });

  it('shows a deletion tombstone and only the previous snapshot under its own provenance', async () => {
    // Arrange: an accidental current snapshot must never appear as deleted state.
    const { api, props } = setup();
    const previous = event({
      id: 'prior',
      cycleId: 'prior-cycle',
      changedAt: '2026-10-22T12:00:00.000Z',
      snapshot: { ...snapshot, owner: 'last-recorded-owner' },
    });
    api.getEntityVersion.mockResolvedValue(
      event({
        op: 'delete',
        snapshot: { ...snapshot, owner: 'invalid-delete-owner' },
        previousVersion: previous,
      }),
    );

    // Act
    render(<HistoryDetail {...props} />);
    const prior = await screen.findByRole('region', {
      name: 'Last recorded snapshot before deletion',
    });

    // Assert
    expect(
      screen.getByText(
        'Entity deleted. This event is a deletion record and has no snapshot.',
      ),
    ).toBeInTheDocument();
    expect(
      within(prior).getByText(
        /same source and provider, not the deletion payload/,
      ),
    ).toBeInTheDocument();
    expect(within(prior).getByText('prior')).toBeInTheDocument();
    expect(within(prior).getByText('prior-cycle')).toBeInTheDocument();
    expect(within(prior).getByText('captured-provider')).toBeInTheDocument();
    expect(prior.querySelector('time')).toHaveAttribute(
      'datetime',
      previous.changedAt,
    );
    expect(
      within(prior).getByRole('region', { name: 'Recorded entity fields' }),
    ).toHaveTextContent('last-recorded-owner');
    expect(
      screen.getAllByRole('region', { name: 'Recorded entity fields' }),
    ).toHaveLength(1);
    expect(JSON.parse(prior.querySelector('pre')!.textContent!)).toEqual(
      previous.snapshot,
    );
    expect(screen.queryByText(/invalid-delete-owner/)).not.toBeInTheDocument();
    expect(screen.queryByText('Raw snapshot')).not.toBeInTheDocument();
    expect(
      screen.queryByRole('region', { name: 'Changes from previous event' }),
    ).not.toBeInTheDocument();
  });

  it.each([undefined, event({ id: 'prior', snapshot: undefined })])(
    'keeps a deletion without a previous snapshot unavailable even if its own snapshot exists',
    async previousVersion => {
      // Arrange
      const { api, props } = setup();
      api.getEntityVersion.mockResolvedValue(
        event({ op: 'delete', previousVersion }),
      );

      // Act
      render(<HistoryDetail {...props} />);
      await screen.findByText(
        'The last recorded snapshot before deletion is unavailable.',
      );

      // Assert
      expect(
        screen.queryByRole('region', { name: 'Recorded entity fields' }),
      ).not.toBeInTheDocument();
      expect(screen.queryByText(/captured-owner/)).not.toBeInTheDocument();
      expect(screen.queryByText('Raw snapshot')).not.toBeInTheDocument();
    },
  );

  it.each([
    { id: 'wrong-id' },
    { entityRef: 'component:default/wrong-entity' },
  ])(
    'rejects mismatched detail identity $id $entityRef before displaying structured data',
    async mismatch => {
      // Arrange
      const { api, props } = setup();
      api.getEntityVersion.mockResolvedValue(event(mismatch));

      // Act
      render(<HistoryDetail {...props} />);
      await screen.findByText('History could not be loaded. Try again.');

      // Assert
      expect(
        screen.queryByRole('region', { name: 'Recorded entity fields' }),
      ).not.toBeInTheDocument();
      expect(screen.queryByText(/captured-owner/)).not.toBeInTheDocument();
    },
  );

  it('retries the same exact event after a safe error and displays its structured snapshot', async () => {
    // Arrange
    const { api, props } = setup();
    api.getEntityVersion
      .mockRejectedValueOnce(new CatalogHistoryApiError(404))
      .mockResolvedValueOnce(event());
    render(<HistoryDetail {...props} />);
    await screen.findByText(
      'This recorded event is no longer available. Refresh the timeline.',
    );

    // Act
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));

    // Assert
    expect(
      await screen.findByRole('region', { name: 'Recorded entity fields' }),
    ).toHaveTextContent(snapshot.owner);
    expect(api.getEntityVersion.mock.calls).toEqual([
      [{ entityRef, id: 'selected' }],
      [{ entityRef, id: 'selected' }],
    ]);
    expect(api.getEntityTimeline).not.toHaveBeenCalled();
  });

  it('ignores a late snapshot from the previous selection rather than replacing current structured fields', async () => {
    // Arrange
    const { api, props } = setup();
    const obsolete = deferred<HistoryEntityVersionResponse>();
    api.getEntityVersion
      .mockReturnValueOnce(obsolete.promise)
      .mockResolvedValueOnce(
        event({
          id: 'next',
          snapshot: { ...snapshot, owner: 'next-event-owner' },
        }),
      );
    const view = render(<HistoryDetail {...props} />);
    expect(screen.getByRole('status')).toHaveTextContent(
      'Loading recorded event',
    );

    // Act
    view.rerender(<HistoryDetail {...props} id="next" />);
    await screen.findByRole('region', { name: 'Recorded entity fields' });
    await act(async () =>
      obsolete.resolve(
        event({ snapshot: { ...snapshot, owner: 'obsolete-event-owner' } }),
      ),
    );

    // Assert
    expect(
      screen.getByRole('region', { name: 'Recorded entity fields' }),
    ).toHaveTextContent('next-event-owner');
    expect(screen.queryByText(/obsolete-event-owner/)).not.toBeInTheDocument();
    expect(screen.getByText('next')).toBeInTheDocument();
    expect(api.getEntityVersion.mock.calls).toEqual([
      [{ entityRef, id: 'selected' }],
      [{ entityRef, id: 'next' }],
    ]);
  });
});
