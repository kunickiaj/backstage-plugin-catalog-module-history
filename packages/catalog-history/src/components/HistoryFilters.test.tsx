/** @jsxRuntime automatic */
import '@testing-library/jest-dom';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { HistoryFilters } from './HistoryFilters';
import type { HistoryProviderSearchResponse } from '@kunickiaj/backstage-plugin-catalog-history-common';
import { CatalogHistoryApiError } from '../api/CatalogHistoryApi';

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

describe('HistoryFilters provider discovery', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  function client(
    getProviders = jest.fn().mockResolvedValue({ items: [' Raw%_\\ Name '] }),
  ) {
    return {
      getProviders,
      getEntityTimeline: jest.fn(),
      getEntityVersion: jest.fn(),
    };
  }

  async function advance(milliseconds = 300) {
    await act(async () => {
      jest.advanceTimersByTime(milliseconds);
    });
  }

  async function select(name = ' Raw%_\\ Name ') {
    const input = screen.getByRole('combobox', { name: 'Provider' });
    fireEvent.focus(input);
    await advance(0);
    fireEvent.keyDown(input, { key: 'ArrowDown', code: 'ArrowDown' });
    fireEvent.click(screen.getByRole('option', { name: name.trim() }));
  }

  it.each([
    {
      label: 'Source',
      option: 'processing',
      expected: { source: 'processing' },
    },
    { label: 'Operation', option: 'delete', expected: { op: 'delete' } },
  ])(
    'flushes the raw chosen name, never an unfinished prefix, when $label changes',
    async ({ label, option, expected }) => {
      // Arrange
      const onApply = jest.fn();
      render(<HistoryFilters api={client()} onApply={onApply} />);
      await select();
      expect(onApply).toHaveBeenLastCalledWith(
        expect.objectContaining({ provider: ' Raw%_\\ Name ' }),
      );
      fireEvent.change(screen.getByRole('combobox', { name: 'Provider' }), {
        target: { value: 'unfinished-prefix' },
      });
      await advance();
      expect(onApply).toHaveBeenCalledTimes(1);
      // Act
      fireEvent.click(
        screen.getByRole('button', { name: new RegExp(`${label}$`) }),
      );
      fireEvent.click(screen.getByRole('option', { name: option }));
      // Assert
      expect(onApply).toHaveBeenCalledTimes(2);
      expect(onApply).toHaveBeenLastCalledWith(
        expect.objectContaining({ provider: ' Raw%_\\ Name ', ...expected }),
      );
      await advance();
      expect(onApply).toHaveBeenCalledTimes(2);
    },
  );

  it('preserves raw selection through date flushing and clears only on explicit empty input', async () => {
    // Arrange
    const onApply = jest.fn();
    render(<HistoryFilters api={client()} onApply={onApply} />);
    await select();
    fireEvent.change(screen.getByRole('combobox', { name: 'Provider' }), {
      target: { value: 'unfinished' },
    });
    // Act
    fireEvent.change(screen.getByLabelText('Recorded after (local time)'), {
      target: { value: '2026-10-23T12:00' },
    });
    // Assert
    expect(onApply).toHaveBeenLastCalledWith(
      expect.objectContaining({
        provider: ' Raw%_\\ Name ',
        changedAfter: new Date('2026-10-23T12:00').toISOString(),
      }),
    );
    fireEvent.change(screen.getByRole('combobox', { name: 'Provider' }), {
      target: { value: '' },
    });
    expect(onApply).toHaveBeenLastCalledWith(
      expect.objectContaining({ provider: undefined }),
    );
  });

  it('uses applied context rather than invalid date/entity drafts for provider discovery', async () => {
    // Arrange
    const api = client();
    const onApply = jest.fn();
    const appliedFilters = {
      source: 'processing' as const,
      provider: 'already-exact',
      kind: 'Component',
      op: 'delete' as const,
      entityRef: 'component:default/applied',
      changedAfter: '2026-10-01T00:00:00.000Z',
    };
    render(
      <HistoryFilters
        scope="all"
        api={api}
        appliedFilters={appliedFilters}
        entityRef="component:default/fixed"
        onApply={onApply}
      />,
    );
    fireEvent.change(screen.getByLabelText('Recorded after (local time)'), {
      target: { value: '2026-10-24T12:00' },
    });
    fireEvent.change(screen.getByLabelText('Recorded before (local time)'), {
      target: { value: '2026-10-23T12:00' },
    });
    fireEvent.change(
      screen.getByRole('textbox', { name: 'Entity reference' }),
      { target: { value: 'invalid ref' } },
    );
    // Act
    fireEvent.focus(screen.getByRole('combobox', { name: 'Provider' }));
    await advance(0);
    // Assert
    expect(api.getProviders).toHaveBeenLastCalledWith({
      source: 'processing',
      entityRef: 'component:default/fixed',
      kind: 'Component',
      op: 'delete',
      changedAfter: appliedFilters.changedAfter,
      prefix: undefined,
      limit: 25,
    });
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Enter a valid entity reference and kind',
    );
    expect(screen.getByText(/Current provider filter:/)).toHaveTextContent(
      'already-exact',
    );
  });

  it('retains atomic validation when a known provider is chosen during a reversed date range', async () => {
    // Arrange
    const onApply = jest.fn();
    render(<HistoryFilters api={client()} onApply={onApply} />);
    fireEvent.change(screen.getByLabelText('Recorded after (local time)'), {
      target: { value: '2026-10-24T12:00' },
    });
    fireEvent.change(screen.getByLabelText('Recorded before (local time)'), {
      target: { value: '2026-10-23T12:00' },
    });
    // Act
    await select();
    // Assert
    expect(onApply).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('alert')).toHaveTextContent(dateError);
    fireEvent.change(screen.getByLabelText('Recorded before (local time)'), {
      target: { value: '2026-10-25T12:00' },
    });
    expect(onApply).toHaveBeenLastCalledWith(
      expect.objectContaining({ provider: ' Raw%_\\ Name ' }),
    );
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('restores exact trimmed 300ms typing after an unsupported response without auto-applying the prefix', async () => {
    // Arrange
    const api = client(
      jest.fn().mockRejectedValue(new CatalogHistoryApiError(501)),
    );
    const onApply = jest.fn();
    render(<HistoryFilters api={api} onApply={onApply} />);
    fireEvent.focus(screen.getByRole('combobox', { name: 'Provider' }));
    fireEvent.change(screen.getByRole('combobox', { name: 'Provider' }), {
      target: { value: 'unfinished' },
    });
    await advance();
    expect(onApply).not.toHaveBeenCalled();
    // Act
    fireEvent.change(screen.getByRole('textbox', { name: 'Provider' }), {
      target: { value: ' exact name ' },
    });
    await advance(299);
    expect(onApply).not.toHaveBeenCalled();
    await advance(1);
    // Assert
    expect(onApply).toHaveBeenCalledTimes(1);
    expect(onApply).toHaveBeenLastCalledWith(
      expect.objectContaining({ provider: 'exact name' }),
    );
    expect(api.getProviders).toHaveBeenCalledTimes(1);
  });

  it.each(['success', 'unsupported'] as const)(
    'reset discards a pending %s response even before any selection',
    async outcome => {
      // Arrange
      let resolve!: (page: HistoryProviderSearchResponse) => void;
      let reject!: (error: unknown) => void;
      const pending = new Promise<HistoryProviderSearchResponse>((yes, no) => {
        resolve = yes;
        reject = no;
      });
      const api = client(
        jest.fn().mockReturnValueOnce(pending).mockResolvedValue({ items: [] }),
      );
      const onApply = jest.fn();
      render(<HistoryFilters api={api} onApply={onApply} />);
      fireEvent.focus(screen.getByRole('combobox', { name: 'Provider' }));
      await advance(0);
      fireEvent.change(screen.getByRole('combobox', { name: 'Provider' }), {
        target: { value: 'pending' },
      });
      // Act
      fireEvent.click(screen.getByRole('button', { name: 'Reset filters' }));
      await advance();
      await act(async () => {
        if (outcome === 'success')
          resolve({ items: ['obsolete'], nextCursor: 'old' });
        else reject(new CatalogHistoryApiError(404));
      });
      // Assert
      expect(api.getProviders).toHaveBeenCalledTimes(1);
      expect(onApply).toHaveBeenCalledTimes(1);
      expect(onApply).toHaveBeenLastCalledWith({});
      expect(screen.getByRole('combobox', { name: 'Provider' })).toHaveValue(
        '',
      );
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
      expect(
        screen.queryByText('Type more to narrow.'),
      ).not.toBeInTheDocument();
    },
  );

  it('reset removes a chosen provider and allows a fresh search', async () => {
    // Arrange
    const api = client();
    const onApply = jest.fn();
    render(<HistoryFilters api={api} onApply={onApply} />);
    await select();
    // Act
    fireEvent.click(screen.getByRole('button', { name: 'Reset filters' }));
    await select();
    // Assert
    expect(onApply).toHaveBeenCalledTimes(3);
    expect(onApply.mock.calls[1][0]).toEqual({});
    expect(onApply).toHaveBeenLastCalledWith(
      expect.objectContaining({ provider: ' Raw%_\\ Name ' }),
    );
  });
});
