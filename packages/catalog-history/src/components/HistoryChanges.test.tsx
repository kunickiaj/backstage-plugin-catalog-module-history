/** @jsxRuntime automatic */
import '@testing-library/jest-dom';
import { render, screen, within } from '@testing-library/react';
import { HistoryChanges } from './HistoryChanges';

describe('HistoryChanges', () => {
  it('shows escaped paths and React-escaped before/after values without rendering HTML', () => {
    // Arrange
    const before = '<img src=x onerror="alert(1)">';
    const after = '<script>alert(2)</script>';

    // Act
    const { container } = render(
      <HistoryChanges
        changes={[
          { path: ['metadata', 'a/b~c'], op: 'replace', before, after },
        ]}
      />,
    );

    // Assert
    const region = screen.getByRole('region', {
      name: 'Changes from previous event',
    });
    expect(within(region).getByText('/metadata/a~1b~0c')).toBeInTheDocument();
    expect(
      within(region).getByText('Before').nextElementSibling,
    ).toHaveTextContent(JSON.stringify(before));
    expect(
      within(region).getByText('After').nextElementSibling,
    ).toHaveTextContent(JSON.stringify(after));
    expect(container.querySelector('img, script')).toBeNull();
  });

  it('distinguishes absent values from null and preserves whole-array values', () => {
    // Arrange
    const changes = [
      { path: [], op: 'add' as const, after: null },
      { path: ['relations'], op: 'remove' as const, before: ['a', 'b'] },
    ];

    // Act
    render(<HistoryChanges changes={changes} />);

    // Assert
    expect(screen.getByText('(root)')).toBeInTheDocument();
    expect(screen.getAllByText('Not present')).toHaveLength(2);
    expect(screen.getByText('null')).toBeInTheDocument();
    expect(screen.getByText(/\[\s*"a",\s*"b"\s*\]/)).toBeInTheDocument();
  });

  it.each([
    {
      changes: undefined,
      message: 'No previous saved snapshot is available for comparison.',
      absent: 'No saved field differences.',
    },
    {
      changes: [],
      message: 'No saved field differences.',
      absent: 'No previous saved snapshot is available for comparison.',
    },
  ])(
    'explains comparison availability: $message',
    ({ changes, message, absent }) => {
      // Arrange
      const props = { changes };

      // Act
      render(<HistoryChanges {...props} />);

      // Assert
      expect(screen.getByText(message)).toBeInTheDocument();
      expect(screen.queryByText(absent)).not.toBeInTheDocument();
      expect(screen.queryByText('Before')).not.toBeInTheDocument();
    },
  );
});
