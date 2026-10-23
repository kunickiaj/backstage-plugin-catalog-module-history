/** @jsxRuntime automatic */
import '@testing-library/jest-dom';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { HistoryFilters } from './HistoryFilters';

const dateError =
  'Enter valid dates, with recorded after no later than recorded before.';

describe('HistoryFilters', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it.each([
    [' Example ', 'component:default/example'],
    ['Group:Teams/Retired-Team', 'group:teams/retired-team'],
  ])('normalizes exact entity reference %s after 300ms', (input, expected) => {
    // Arrange
    const onApply = jest.fn();
    render(<HistoryFilters scope="all" onApply={onApply} />);
    // Act
    fireEvent.change(
      screen.getByRole('textbox', { name: 'Entity reference' }),
      { target: { value: input } },
    );
    act(() => jest.advanceTimersByTime(299));
    expect(onApply).not.toHaveBeenCalled();
    act(() => jest.advanceTimersByTime(1));
    // Assert
    expect(onApply).toHaveBeenCalledTimes(1);
    expect(onApply).toHaveBeenLastCalledWith(
      expect.objectContaining({ entityRef: expected }),
    );
  });

  it('accepts mixed-case kind, trims it, and cancels pending entity filters on reset', () => {
    // Arrange
    const onApply = jest.fn();
    render(<HistoryFilters scope="all" onApply={onApply} />);
    // Act
    fireEvent.change(screen.getByRole('textbox', { name: 'Kind' }), {
      target: { value: ' gRoUp ' },
    });
    act(() => jest.advanceTimersByTime(300));
    expect(onApply).toHaveBeenLastCalledWith(
      expect.objectContaining({ kind: 'gRoUp' }),
    );
    fireEvent.change(
      screen.getByRole('textbox', { name: 'Entity reference' }),
      { target: { value: 'pending' } },
    );
    fireEvent.click(screen.getByRole('button', { name: 'Reset filters' }));
    act(() => jest.advanceTimersByTime(300));
    // Assert
    expect(onApply).toHaveBeenCalledTimes(2);
    expect(onApply).toHaveBeenLastCalledWith({});
    expect(
      screen.getByRole('textbox', { name: 'Entity reference' }),
    ).toHaveValue('');
    expect(screen.getByRole('textbox', { name: 'Kind' })).toHaveValue('');
  });

  it.each([
    ['Entity reference', 'component:default/invalid name'],
    ['Entity reference', 'component:default/'],
    ['Kind', 'invalid kind'],
  ])(
    'rejects invalid %s without applying or retaining an earlier pending edit',
    (label, value) => {
      // Arrange
      const onApply = jest.fn();
      render(<HistoryFilters scope="all" onApply={onApply} />);
      fireEvent.change(screen.getByRole('textbox', { name: 'Provider' }), {
        target: { value: 'pending' },
      });
      // Act
      fireEvent.change(screen.getByRole('textbox', { name: label }), {
        target: { value },
      });
      act(() => jest.advanceTimersByTime(300));
      // Assert
      expect(onApply).not.toHaveBeenCalled();
      expect(screen.getByRole('alert')).toHaveTextContent(
        'Enter a valid entity reference and kind',
      );
      fireEvent.change(screen.getByRole('textbox', { name: label }), {
        target: { value: '' },
      });
      act(() => jest.advanceTimersByTime(300));
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
      expect(onApply).toHaveBeenLastCalledWith(
        expect.objectContaining({ provider: 'pending' }),
      );
    },
  );

  it('does not apply initial filters or expose an Apply button', () => {
    // Arrange
    const onApply = jest.fn();

    // Act
    render(<HistoryFilters onApply={onApply} />);
    act(() => jest.advanceTimersByTime(300));

    // Assert
    expect(onApply).not.toHaveBeenCalled();
    expect(
      screen.queryByRole('button', { name: /Apply/ }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Reset filters' }),
    ).toBeInTheDocument();
  });

  it('debounces rapid provider typing and applies only the latest trimmed value at 300ms', () => {
    // Arrange
    const onApply = jest.fn();
    render(<HistoryFilters onApply={onApply} />);
    const provider = screen.getByRole('textbox', { name: 'Provider' });

    // Act
    fireEvent.change(provider, { target: { value: 'first' } });
    act(() => jest.advanceTimersByTime(200));
    fireEvent.change(provider, { target: { value: ' latest-provider ' } });
    act(() => jest.advanceTimersByTime(299));

    // Assert: neither the earlier deadline nor 299ms after the last key applies.
    expect(onApply).not.toHaveBeenCalled();
    expect(provider).toHaveValue(' latest-provider ');
    act(() => jest.advanceTimersByTime(1));
    expect(onApply).toHaveBeenCalledTimes(1);
    expect(onApply).toHaveBeenLastCalledWith(
      expect.objectContaining({ provider: 'latest-provider' }),
    );
    fireEvent.change(provider, { target: { value: 'latest-provider' } });
    act(() => jest.advanceTimersByTime(300));
    expect(onApply).toHaveBeenCalledTimes(1);
  });

  it.each([
    {
      label: 'Source',
      option: 'processing',
      expected: { source: 'processing' },
    },
    { label: 'Operation', option: 'delete', expected: { op: 'delete' } },
  ])(
    'applies $label immediately and flushes the pending provider without a duplicate timer call',
    ({ label, option, expected }) => {
      // Arrange: interact with the actual BUI popup rather than mocking Select.
      const onApply = jest.fn();
      render(<HistoryFilters onApply={onApply} />);
      fireEvent.change(screen.getByRole('textbox', { name: 'Provider' }), {
        target: { value: ' pending-provider ' },
      });
      act(() => jest.advanceTimersByTime(100));

      // Act
      fireEvent.click(
        screen.getByRole('button', { name: new RegExp(`${label}$`) }),
      );
      fireEvent.click(screen.getByRole('option', { name: option }));

      // Assert
      expect(onApply).toHaveBeenCalledTimes(1);
      expect(onApply).toHaveBeenLastCalledWith(
        expect.objectContaining({ provider: 'pending-provider', ...expected }),
      );
      act(() => jest.advanceTimersByTime(300));
      expect(onApply).toHaveBeenCalledTimes(1);
    },
  );

  it('applies valid dates immediately, flushes the provider, and permits equal inclusive boundaries', () => {
    // Arrange
    const onApply = jest.fn();
    const boundary = '2026-10-23T12:30';
    render(<HistoryFilters onApply={onApply} />);
    fireEvent.change(screen.getByRole('textbox', { name: 'Provider' }), {
      target: { value: ' directory-provider ' },
    });

    // Act
    fireEvent.change(screen.getByLabelText('Recorded after (local time)'), {
      target: { value: boundary },
    });
    fireEvent.change(screen.getByLabelText('Recorded before (local time)'), {
      target: { value: boundary },
    });

    // Assert: local input becomes an exact ISO timestamp without waiting 300ms.
    expect(onApply).toHaveBeenCalledTimes(2);
    expect(onApply).toHaveBeenLastCalledWith({
      provider: 'directory-provider',
      source: undefined,
      op: undefined,
      changedAfter: new Date(boundary).toISOString(),
      changedBefore: new Date(boundary).toISOString(),
    });
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    act(() => jest.advanceTimersByTime(300));
    expect(onApply).toHaveBeenCalledTimes(2);
  });

  it('preserves the last applied dates for a reversed range and applies once corrected', () => {
    // Arrange
    const onApply = jest.fn();
    render(<HistoryFilters onApply={onApply} />);
    fireEvent.change(screen.getByLabelText('Recorded after (local time)'), {
      target: { value: '2026-10-24T12:00' },
    });
    const lastApplied = onApply.mock.calls[0][0];
    fireEvent.change(screen.getByRole('textbox', { name: 'Provider' }), {
      target: { value: 'not-applied-yet' },
    });

    // Act
    fireEvent.change(screen.getByLabelText('Recorded before (local time)'), {
      target: { value: '2026-10-23T12:00' },
    });
    act(() => jest.advanceTimersByTime(300));

    // Assert
    expect(onApply).toHaveBeenCalledTimes(1);
    expect(onApply).toHaveBeenLastCalledWith(lastApplied);
    expect(screen.getByRole('alert')).toHaveTextContent(dateError);
    fireEvent.change(screen.getByLabelText('Recorded before (local time)'), {
      target: { value: '2026-10-25T12:00' },
    });
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(onApply).toHaveBeenCalledTimes(2);
    expect(onApply).toHaveBeenLastCalledWith(
      expect.objectContaining({
        provider: 'not-applied-yet',
        changedBefore: new Date('2026-10-25T12:00').toISOString(),
      }),
    );
  });

  it('does not clear applied dates when native date editing reports incomplete input', () => {
    // Arrange: jsdom cannot type a partial datetime, so emulate native badInput.
    const onApply = jest.fn();
    render(<HistoryFilters onApply={onApply} />);
    const after = screen.getByLabelText<HTMLInputElement>(
      'Recorded after (local time)',
    );
    fireEvent.change(after, { target: { value: '2026-10-24T12:00' } });
    const lastApplied = onApply.mock.calls[0][0];
    const validity = jest
      .spyOn(after, 'validity', 'get')
      .mockReturnValue({ badInput: true } as ValidityState);

    // Act
    fireEvent.change(after, { target: { value: '' } });
    act(() => jest.advanceTimersByTime(300));
    validity.mockRestore();

    // Assert
    expect(onApply).toHaveBeenCalledTimes(1);
    expect(onApply).toHaveBeenLastCalledWith(lastApplied);
    expect(screen.getByRole('alert')).toHaveTextContent(dateError);
  });

  it('resets draft fields and cancels a pending provider update', () => {
    // Arrange
    const onApply = jest.fn();
    render(<HistoryFilters onApply={onApply} />);
    fireEvent.change(screen.getByLabelText('Recorded after (local time)'), {
      target: { value: '2026-10-24T12:00' },
    });
    fireEvent.change(screen.getByRole('textbox', { name: 'Provider' }), {
      target: { value: 'pending-provider' },
    });

    // Act
    fireEvent.click(screen.getByRole('button', { name: 'Reset filters' }));
    act(() => jest.advanceTimersByTime(300));

    // Assert
    expect(onApply).toHaveBeenCalledTimes(2);
    expect(onApply).toHaveBeenLastCalledWith({});
    expect(screen.getByRole('textbox', { name: 'Provider' })).toHaveValue('');
    expect(screen.getByLabelText('Recorded after (local time)')).toHaveValue(
      '',
    );
    expect(screen.getByLabelText('Recorded before (local time)')).toHaveValue(
      '',
    );
  });

  it('resets invalid date errors without applying the invalid range', () => {
    // Arrange
    const onApply = jest.fn();
    render(<HistoryFilters onApply={onApply} />);
    fireEvent.change(screen.getByLabelText('Recorded after (local time)'), {
      target: { value: '2026-10-24T12:00' },
    });
    fireEvent.change(screen.getByLabelText('Recorded before (local time)'), {
      target: { value: '2026-10-23T12:00' },
    });
    expect(screen.getByRole('alert')).toHaveTextContent(dateError);

    // Act
    fireEvent.click(screen.getByRole('button', { name: 'Reset filters' }));
    act(() => jest.advanceTimersByTime(300));

    // Assert
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(onApply).toHaveBeenCalledTimes(2);
    expect(onApply).toHaveBeenLastCalledWith({});
  });

  it('cancels a pending provider update on unmount', () => {
    // Arrange
    const onApply = jest.fn();
    const { unmount } = render(<HistoryFilters onApply={onApply} />);
    fireEvent.change(screen.getByRole('textbox', { name: 'Provider' }), {
      target: { value: 'pending-provider' },
    });

    // Act
    unmount();
    act(() => jest.advanceTimersByTime(300));

    // Assert
    expect(onApply).not.toHaveBeenCalled();
  });

  it('clears a provider filter after the debounce without submitting whitespace', () => {
    // Arrange
    const onApply = jest.fn();
    render(<HistoryFilters onApply={onApply} />);
    const provider = screen.getByRole('textbox', { name: 'Provider' });
    fireEvent.change(provider, { target: { value: 'directory-provider' } });
    act(() => jest.advanceTimersByTime(300));

    // Act
    fireEvent.change(provider, { target: { value: '   ' } });
    act(() => jest.advanceTimersByTime(299));

    // Assert
    expect(onApply).toHaveBeenCalledTimes(1);
    act(() => jest.advanceTimersByTime(1));
    expect(onApply).toHaveBeenCalledTimes(2);
    expect(onApply).toHaveBeenLastCalledWith({
      source: undefined,
      provider: undefined,
      op: undefined,
      changedAfter: undefined,
      changedBefore: undefined,
    });
  });
});
