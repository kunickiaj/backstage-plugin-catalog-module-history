/** @jsxRuntime automatic */
import '@testing-library/jest-dom';
import { render, screen, within } from '@testing-library/react';
import type { HistoryTimelineSummary } from '@kunickiaj/backstage-plugin-catalog-history-common';
import { HistorySummaryBadges } from './HistorySummaryBadges';

describe('HistorySummaryBadges', () => {
  it('names all recorded changes and renders four read-only items in stable order', () => {
    // Arrange: property order must not determine the visible or spoken order.
    const summary = {
      orphanChanged: true,
      statusChanged: true,
      relationsChanged: true,
      ownerChanged: true,
    };

    // Act
    const { container } = render(<HistorySummaryBadges summary={summary} />);

    // Assert
    const list = screen.getByRole('list', {
      name: 'Recorded field changes: Owner changed, Relations changed, Status changed, Orphan changed',
    });
    expect(
      within(list)
        .getAllByRole('listitem')
        .map(item => item.textContent),
    ).toEqual([
      'Owner changed',
      'Relations changed',
      'Status changed',
      'Orphan changed',
    ]);
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
    expect(
      container.querySelector('[tabindex], button, a, input, select, textarea'),
    ).toBeNull();
  });

  it('includes only positive flags in both the list and its accessible name', () => {
    // Arrange
    const summary = {
      ownerChanged: false,
      relationsChanged: true,
      statusChanged: false,
      orphanChanged: true,
    };

    // Act
    render(<HistorySummaryBadges summary={summary} />);

    // Assert
    const list = screen.getByRole('list', {
      name: 'Recorded field changes: Relations changed, Orphan changed',
    });
    expect(
      within(list)
        .getAllByRole('listitem')
        .map(item => item.textContent),
    ).toEqual(['Relations changed', 'Orphan changed']);
    expect(within(list).queryByText('Owner changed')).not.toBeInTheDocument();
    expect(within(list).queryByText('Status changed')).not.toBeInTheDocument();
  });

  it.each([
    undefined,
    null,
    {},
    {
      ownerChanged: false,
      relationsChanged: false,
      statusChanged: false,
      orphanChanged: false,
    },
    {
      ownerChanged: 'true',
      relationsChanged: 1,
      statusChanged: [],
      orphanChanged: {},
    },
    { unknownChanged: true },
  ])(
    'renders nothing for absent or non-positive runtime summary %j',
    summary => {
      // Arrange: casts model older/custom API payloads, not supported TS inputs.
      const runtimeSummary = summary as HistoryTimelineSummary | undefined;

      // Act
      const { container } = render(
        <HistorySummaryBadges summary={runtimeSummary} />,
      );

      // Assert: missing evidence is not a claim that no fields changed.
      expect(screen.queryByRole('list')).not.toBeInTheDocument();
      expect(screen.queryByText(/no changes/i)).not.toBeInTheDocument();
      expect(container).toBeEmptyDOMElement();
    },
  );

  it('ignores unknown and malformed flags while retaining a known strict true', () => {
    // Arrange
    const summary = {
      ownerChanged: 'true',
      relationsChanged: true,
      statusChanged: 1,
      orphanChanged: null,
      unknownChanged: true,
    } as unknown as HistoryTimelineSummary;

    // Act
    render(<HistorySummaryBadges summary={summary} />);

    // Assert
    const list = screen.getByRole('list', {
      name: 'Recorded field changes: Relations changed',
    });
    expect(within(list).getAllByRole('listitem')).toHaveLength(1);
    expect(within(list).getByText('Relations changed')).toBeVisible();
  });
});
