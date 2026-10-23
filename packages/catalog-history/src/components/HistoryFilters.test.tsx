/** @jsxRuntime automatic */
import '@testing-library/jest-dom';
import { fireEvent, render, screen } from '@testing-library/react';
import { HistoryFilters } from './HistoryFilters';

describe('HistoryFilters', () => {
  it('applies trimmed provider and equal inclusive date boundaries without changing the draft while typing', () => {
    // Arrange
    const onApply = jest.fn();
    const boundary = '2026-10-23T12:30';
    render(<HistoryFilters onApply={onApply} />);

    // Act
    fireEvent.change(screen.getByRole('textbox', { name: 'Provider' }), {
      target: { value: ' directory-provider ' },
    });
    fireEvent.change(screen.getByLabelText('Recorded after (local time)'), {
      target: { value: boundary },
    });
    fireEvent.change(screen.getByLabelText('Recorded before (local time)'), {
      target: { value: boundary },
    });

    // Assert: applying is explicit, and the timestamps represent the entered local time.
    expect(onApply).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Apply filters' }));
    expect(onApply).toHaveBeenCalledWith({
      provider: 'directory-provider',
      source: undefined,
      op: undefined,
      changedAfter: new Date(boundary).toISOString(),
      changedBefore: new Date(boundary).toISOString(),
    });
  });

  it('rejects a reversed date range without applying filters', () => {
    // Arrange
    const onApply = jest.fn();
    render(<HistoryFilters onApply={onApply} />);
    fireEvent.change(screen.getByLabelText('Recorded after (local time)'), {
      target: { value: '2026-10-24T12:00' },
    });
    fireEvent.change(screen.getByLabelText('Recorded before (local time)'), {
      target: { value: '2026-10-23T12:00' },
    });

    // Act
    fireEvent.click(screen.getByRole('button', { name: 'Apply filters' }));

    // Assert
    expect(onApply).not.toHaveBeenCalled();
    expect(
      screen.getByText(
        'Enter valid dates, with recorded after no later than recorded before.',
      ),
    ).toBeInTheDocument();
  });

  it('resets draft fields and removes active filters', () => {
    // Arrange
    const onApply = jest.fn();
    render(<HistoryFilters onApply={onApply} />);
    fireEvent.change(screen.getByRole('textbox', { name: 'Provider' }), {
      target: { value: 'directory-provider' },
    });
    fireEvent.change(screen.getByLabelText('Recorded after (local time)'), {
      target: { value: '2026-10-24T12:00' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Apply filters' }));

    // Act
    fireEvent.click(screen.getByRole('button', { name: 'Reset filters' }));

    // Assert
    expect(onApply).toHaveBeenLastCalledWith({});
    expect(screen.getByRole('textbox', { name: 'Provider' })).toHaveValue('');
    expect(screen.getByLabelText('Recorded after (local time)')).toHaveValue(
      '',
    );
  });
});
