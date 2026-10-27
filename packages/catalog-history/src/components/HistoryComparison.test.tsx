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
import type {
  HistoryEntityDiffResponse,
  HistoryEntityVersion,
  HistoryTimelineItem,
} from '@kunickiaj/backstage-plugin-catalog-history-common';
import {
  type CatalogHistoryApi,
  CatalogHistoryApiError,
} from '../api/CatalogHistoryApi';
import { HistoryComparison } from './HistoryComparison';
import { HistoryTimeline } from './HistoryTimeline';

const entityRef = 'component:default/example';
const target = { entityRef, fromId: '1', toId: '2' };

function version(
  id: string,
  overrides: Partial<HistoryEntityVersion> = {},
): HistoryEntityVersion {
  return {
    id,
    entityRef,
    cycleId: `cycle-${id}`,
    source: 'provider',
    provider: 'directory',
    op: 'update',
    changedAt: `2026-10-0${id}T00:00:00.000Z`,
    summary: {},
    snapshot: {
      entityRef,
      kind: 'Component',
      namespace: 'default',
      name: 'example',
    },
    ...overrides,
  };
}

function diff(
  overrides: Partial<HistoryEntityDiffResponse> = {},
): HistoryEntityDiffResponse {
  return {
    entityRef,
    from: version('1'),
    to: version('2'),
    changes: [
      {
        path: ['owner'],
        op: 'replace',
        before: 'group:default/a',
        after: 'group:default/b',
      },
    ],
    ...overrides,
  };
}

function api(response: Promise<HistoryEntityDiffResponse>) {
  const mock: jest.Mocked<
    CatalogHistoryApi & Required<Pick<CatalogHistoryApi, 'getEntityDiff'>>
  > = {
    getEntityTimeline: jest.fn(),
    getEntityVersion: jest.fn(),
    getEntityDiff: jest.fn().mockReturnValue(response),
  };
  return mock;
}

describe('HistoryComparison', () => {
  it('shows both provenances and the changes from the first event to the second', async () => {
    // Arrange
    const history = api(Promise.resolve(diff()));
    // Act
    render(
      <HistoryComparison
        api={history}
        target={target}
        onSwap={jest.fn()}
        onExit={jest.fn()}
      />,
    );
    // Assert
    const changes = await screen.findByRole('region', {
      name: 'Changes between these events',
    });
    expect(within(changes).getByText('/owner')).toBeInTheDocument();
    expect(
      within(screen.getByRole('region', { name: 'First event' })).getByText(
        '1',
      ),
    ).toBeInTheDocument();
    expect(
      within(screen.getByRole('region', { name: 'Second event' })).getByText(
        '2',
      ),
    ).toBeInTheDocument();
    expect(history.getEntityDiff).toHaveBeenCalledWith({
      entityRef,
      from: { kind: 'history-row', id: '1' },
      to: { kind: 'history-row', id: '2' },
    });
    expect(
      screen.queryByText('These events come from different capture layers'),
    ).not.toBeInTheDocument();
  });

  it('flags a comparison across capture layers', async () => {
    // Arrange
    const history = api(
      Promise.resolve(diff({ to: version('2', { source: 'processing' }) })),
    );
    // Act
    render(
      <HistoryComparison
        api={history}
        target={target}
        onSwap={jest.fn()}
        onExit={jest.fn()}
      />,
    );
    // Assert
    expect(
      await screen.findByText(
        'These events come from different capture layers',
      ),
    ).toBeInTheDocument();
  });

  it.each([
    ['from', 'appears as added'],
    ['to', 'appears as removed'],
    ['both', 'neither has saved fields'],
  ] as const)('explains a deletion on the %s side', async (side, text) => {
    // Arrange
    const deleted = { op: 'delete' as const, snapshot: undefined };
    const history = api(
      Promise.resolve(
        diff({
          from: version('1', side === 'to' ? {} : deleted),
          to: version('2', side === 'from' ? {} : deleted),
          changes: [],
        }),
      ),
    );
    // Act
    render(
      <HistoryComparison
        api={history}
        target={target}
        onSwap={jest.fn()}
        onExit={jest.fn()}
      />,
    );
    // Assert
    expect(await screen.findByText(new RegExp(text))).toBeInTheDocument();
  });

  it.each([
    [404, 'no longer available, or this installation does not support'],
    [501, 'not available on this backend'],
    [403, 'do not have permission'],
    [401, 'Sign in again'],
  ])('explains HTTP %i', async (status, text) => {
    // Arrange
    const history = api(Promise.reject(new CatalogHistoryApiError(status)));
    // Act
    render(
      <HistoryComparison
        api={history}
        target={target}
        onSwap={jest.fn()}
        onExit={jest.fn()}
      />,
    );
    // Assert
    expect(await screen.findByRole('alert')).toHaveTextContent(
      new RegExp(text),
    );
  });

  it('explains a shared comparison on an API that cannot compare events', async () => {
    // Arrange
    const history: CatalogHistoryApi = {
      getEntityTimeline: jest.fn(),
      getEntityVersion: jest.fn(),
    };
    // Act
    render(
      <HistoryComparison
        api={history}
        target={target}
        onSwap={jest.fn()}
        onExit={jest.fn()}
      />,
    );
    // Assert
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'not available on this backend',
    );
    expect(
      screen.queryByRole('button', { name: 'Retry' }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Exit comparison' }),
    ).toBeInTheDocument();
  });

  it('accepts a response whose entity reference differs only in case', async () => {
    // Arrange: a hand-edited link may use a non-canonical reference.
    const history = api(Promise.resolve(diff()));
    // Act
    render(
      <HistoryComparison
        api={history}
        target={{ ...target, entityRef: 'Component:default/example' }}
        onSwap={jest.fn()}
        onExit={jest.fn()}
      />,
    );
    // Assert
    expect(
      await screen.findByRole('region', {
        name: 'Changes between these events',
      }),
    ).toBeInTheDocument();
  });

  it('ignores a late response for the pair before a swap', async () => {
    // Arrange
    let resolveFirst!: (value: HistoryEntityDiffResponse) => void;
    const history = api(new Promise(resolve => (resolveFirst = resolve)));
    const swapped = { ...target, fromId: '2', toId: '1' };
    const { rerender } = render(
      <HistoryComparison
        api={history}
        target={target}
        onSwap={jest.fn()}
        onExit={jest.fn()}
      />,
    );
    history.getEntityDiff.mockResolvedValueOnce(
      diff({ from: version('2'), to: version('1') }),
    );
    // Act
    rerender(
      <HistoryComparison
        api={history}
        target={swapped}
        onSwap={jest.fn()}
        onExit={jest.fn()}
      />,
    );
    await screen.findByRole('region', { name: 'Changes between these events' });
    await act(async () => resolveFirst(diff()));
    // Assert: the swapped pair stays on screen.
    expect(
      within(screen.getByRole('region', { name: 'First event' })).getByText(
        '2',
      ),
    ).toBeInTheDocument();
  });

  it('rejects a response for a different pair', async () => {
    // Arrange
    const history = api(Promise.resolve(diff({ to: version('3') })));
    // Act
    render(
      <HistoryComparison
        api={history}
        target={target}
        onSwap={jest.fn()}
        onExit={jest.fn()}
      />,
    );
    // Assert
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'could not be loaded',
    );
  });
});

describe('HistoryTimeline comparison', () => {
  function item(id: string, ref = entityRef): HistoryTimelineItem {
    return { ...version(id), entityRef: ref };
  }

  function setup(withDiff = true) {
    const history = api(Promise.resolve(diff()));
    if (!withDiff) delete (history as CatalogHistoryApi).getEntityDiff;
    history.getEntityTimeline.mockResolvedValue({
      items: [item('2'), item('1'), item('3', 'group:default/other')],
    });
    history.getEntityVersion.mockImplementation(async request => ({
      ...version(request.id),
      entityRef: request.entityRef,
    }));
    render(
      <HistoryTimeline api={history} request={{ entityRef, limit: 25 }} />,
    );
    return history;
  }

  async function selectRow(id: string) {
    fireEvent.click(
      await screen.findByRole('row', { name: new RegExp(`^Event ${id},`) }),
    );
  }

  it('compares the selected event with a picked event, older first', async () => {
    // Arrange
    const history = setup();
    await selectRow('2');
    // Act
    fireEvent.click(
      await screen.findByRole('button', { name: 'Compare with another event' }),
    );
    await selectRow('3');
    expect(
      screen.getByText(`Only events of ${entityRef} can be compared.`),
    ).toHaveAttribute('aria-live', 'polite');
    await selectRow('1');
    // Assert
    await screen.findByRole('region', {
      name: 'Changes between these events',
    });
    expect(history.getEntityDiff).toHaveBeenCalledTimes(1);
    expect(history.getEntityDiff).toHaveBeenLastCalledWith({
      entityRef,
      from: { kind: 'history-row', id: '1' },
      to: { kind: 'history-row', id: '2' },
    });
  });

  it('swaps and exits the comparison', async () => {
    // Arrange
    const history = setup();
    await selectRow('2');
    fireEvent.click(
      await screen.findByRole('button', { name: 'Compare with another event' }),
    );
    await selectRow('1');
    await screen.findByRole('button', { name: 'Swap' });
    // Act
    fireEvent.click(screen.getByRole('button', { name: 'Swap' }));
    // Assert
    expect(history.getEntityDiff).toHaveBeenLastCalledWith({
      entityRef,
      from: { kind: 'history-row', id: '2' },
      to: { kind: 'history-row', id: '1' },
    });
    // Act
    fireEvent.click(screen.getByRole('button', { name: 'Exit comparison' }));
    // Assert
    expect(
      await screen.findByRole('button', { name: 'Compare with another event' }),
    ).toBeInTheDocument();
  });

  it('leaves the comparison when another row is selected', async () => {
    // Arrange
    setup();
    await selectRow('2');
    fireEvent.click(
      await screen.findByRole('button', { name: 'Compare with another event' }),
    );
    await selectRow('1');
    await screen.findByRole('heading', {
      name: 'Comparing two recorded events',
    });
    // Act
    await selectRow('2');
    // Assert
    expect(
      await screen.findByRole('heading', { name: 'Recorded event' }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('heading', { name: 'Comparing two recorded events' }),
    ).not.toBeInTheDocument();
  });

  it('keeps keyboard focus in the inspector after Swap and Exit', async () => {
    // Arrange
    setup();
    await selectRow('2');
    fireEvent.click(
      await screen.findByRole('button', { name: 'Compare with another event' }),
    );
    await selectRow('1');
    const swap = await screen.findByRole('button', { name: 'Swap' });
    act(() => swap.focus());
    // Act
    fireEvent.click(swap);
    // Assert: the inspector is not remounted, so Swap keeps focus.
    expect(screen.getByRole('button', { name: 'Swap' })).toHaveFocus();
    // Act
    fireEvent.click(screen.getByRole('button', { name: 'Exit comparison' }));
    // Assert
    expect(
      screen.getByRole('region', { name: 'Recorded event details' }),
    ).toHaveFocus();
  });

  it('moves focus to the pick prompt and back to the inspector on cancel', async () => {
    // Arrange
    setup();
    await selectRow('2');
    const compare = await screen.findByRole('button', {
      name: 'Compare with another event',
    });
    // Act
    fireEvent.click(compare);
    // Assert: the prompt takes focus after the button disappears.
    const cancel = await screen.findByRole('button', {
      name: 'Cancel comparison',
    });
    await waitFor(() =>
      expect(cancel.closest('[tabindex="-1"]')).toHaveFocus(),
    );
    // Act
    fireEvent.click(cancel);
    // Assert
    expect(
      screen.getByRole('region', { name: 'Recorded event details' }),
    ).toHaveFocus();
  });

  it('cancels picking without comparing', async () => {
    // Arrange
    const history = setup();
    await selectRow('2');
    fireEvent.click(
      await screen.findByRole('button', { name: 'Compare with another event' }),
    );
    // Act
    fireEvent.click(screen.getByRole('button', { name: 'Cancel comparison' }));
    await selectRow('1');
    // Assert
    expect(history.getEntityDiff).not.toHaveBeenCalled();
  });

  it('offers no comparison when the API cannot compare events', async () => {
    // Arrange
    setup(false);
    // Act
    await selectRow('2');
    // Assert
    await screen.findByRole('heading', { name: 'Recorded event' });
    expect(
      screen.queryByRole('button', { name: 'Compare with another event' }),
    ).not.toBeInTheDocument();
  });
});
