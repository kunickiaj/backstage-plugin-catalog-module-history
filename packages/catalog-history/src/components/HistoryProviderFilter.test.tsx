/** @jsxRuntime automatic */
import '@testing-library/jest-dom';
import { act, fireEvent, render, screen } from '@testing-library/react';
import type { HistoryProviderSearchResponse } from '@kunickiaj/backstage-plugin-catalog-history-common';
import { CatalogHistoryApiError } from '../api/CatalogHistoryApi';
import type { CatalogHistoryApi } from '../api/CatalogHistoryApi';
import { HistoryProviderFilter } from './HistoryProviderFilter';
import { deferred } from '../__testUtils__/deferred';

function api(getProviders = jest.fn().mockResolvedValue({ items: [] })) {
  return {
    getProviders,
    getEntityTimeline: jest.fn(),
    getEntityVersion: jest.fn(),
  };
}

function setup(
  overrides: Partial<Parameters<typeof HistoryProviderFilter>[0]> = {},
) {
  const props = {
    api: api(),
    context: {},
    value: '',
    onSelect: jest.fn(),
    onLegacyChange: jest.fn(),
    ...overrides,
  };
  const view = render(<HistoryProviderFilter {...props} />);
  return { ...view, props };
}

async function advance(milliseconds = 300) {
  await act(async () => {
    jest.advanceTimersByTime(milliseconds);
  });
}

async function open() {
  fireEvent.focus(screen.getByRole('combobox', { name: 'Provider' }));
  await advance(0);
}

describe('HistoryProviderFilter', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it.each([
    undefined,
    { getEntityTimeline: jest.fn(), getEntityVersion: jest.fn() },
  ])(
    'keeps the accessible exact-name textbox when discovery is absent',
    missing => {
      // Arrange
      const { props } = setup({ api: missing });
      // Act
      fireEvent.change(screen.getByRole('textbox', { name: 'Provider' }), {
        target: { value: ' exact ' },
      });
      // Assert
      expect(
        screen.getByRole('textbox', { name: 'Provider' }),
      ).toHaveAccessibleDescription(
        'Exact provider name; suggestions unavailable.',
      );
      expect(props.onLegacyChange).toHaveBeenCalledWith(' exact ');
      expect(props.onSelect).not.toHaveBeenCalled();
    },
  );

  it('loads only on focus, with applied context, first-page limit and the API receiver', async () => {
    // Arrange
    const context = {
      source: 'processing' as const,
      entityRef: 'component:default/example',
      kind: 'Component',
      op: 'delete' as const,
      changedAfter: '2026-10-01T00:00:00.000Z',
      changedBefore: '2026-10-02T00:00:00.000Z',
    };
    const client = api(
      jest.fn(function providers(this: CatalogHistoryApi) {
        expect(this).toBe(client);
        return Promise.resolve({ items: ['retained-only'] });
      }),
    );
    setup({ api: client, context });
    // Act
    await advance();
    expect(client.getProviders).not.toHaveBeenCalled();
    await open();
    // Assert
    expect(client.getProviders).toHaveBeenCalledTimes(1);
    expect(client.getProviders).toHaveBeenCalledWith({
      ...context,
      prefix: undefined,
      limit: 25,
    });
  });

  it('debounces literal raw prefixes without applying typed text', async () => {
    // Arrange
    const { props } = setup({ appliedProvider: 'old-provider' });
    await open();
    const input = screen.getByRole('combobox', { name: 'Provider' });
    // Act
    fireEvent.change(input, { target: { value: 'discarded' } });
    await advance(200);
    fireEvent.change(input, { target: { value: ' MiX%_\\ ' } });
    await advance(299);
    expect(props.api.getProviders).toHaveBeenCalledTimes(1);
    await advance(1);
    // Assert
    expect(props.api.getProviders).toHaveBeenLastCalledWith({
      prefix: ' MiX%_\\ ',
      limit: 25,
    });
    expect(props.onSelect).not.toHaveBeenCalled();
    expect(props.onLegacyChange).not.toHaveBeenCalled();
    expect(screen.getByText(/Current provider filter:/)).toHaveTextContent(
      '"old-provider"',
    );
  });

  it.each([
    ' Raw Name ',
    '   ',
    'MiXeD%_\\"',
    '<a href="javascript:alert(1)">name</a>',
  ])('selects the original server name %j as inert text', async name => {
    // Arrange
    const { props, container } = setup({
      api: api(jest.fn().mockResolvedValue({ items: [name] })),
    });
    // Act
    await open();
    fireEvent.keyDown(screen.getByRole('combobox', { name: 'Provider' }), {
      key: 'ArrowDown',
      code: 'ArrowDown',
    });
    await advance(0);
    fireEvent.click(screen.getByRole('option'));
    // Assert
    expect(props.onSelect).toHaveBeenCalledWith(name);
    expect(container.querySelector('a, script')).toBeNull();
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });

  it('does not locally filter server options and keeps special/case variant keys distinct', async () => {
    // Arrange
    const names = [
      'A',
      'a',
      ' A ',
      'a%_',
      'a\\',
      'a"',
      'unrelated-retained-provider',
    ];
    setup({ api: api(jest.fn().mockResolvedValue({ items: names })) });
    await open();
    // Act
    fireEvent.change(screen.getByRole('combobox', { name: 'Provider' }), {
      target: { value: 'prefix' },
    });
    await advance();
    fireEvent.keyDown(screen.getByRole('combobox', { name: 'Provider' }), {
      key: 'ArrowDown',
      code: 'ArrowDown',
    });
    // Assert
    expect(screen.getAllByRole('option')).toHaveLength(names.length);
    expect(
      new Set(screen.getAllByRole('option').map(option => option.id)).size,
    ).toBe(names.length);
  });

  it('chooses a known provider using ArrowDown and Enter without committing a custom query', async () => {
    // Arrange
    const { props } = setup({
      api: api(jest.fn().mockResolvedValue({ items: ['Keyboard Provider'] })),
    });
    await open();
    const input = screen.getByRole('combobox', { name: 'Provider' });
    // Act
    fireEvent.keyDown(input, { key: 'ArrowDown', code: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'Enter', code: 'Enter' });
    // Assert
    expect(props.onSelect).toHaveBeenCalledWith('Keyboard Provider');
    expect(input).toHaveValue('Keyboard Provider');
  });

  it.each([
    { source: 'processing' as const },
    { entityRef: 'component:default/new' },
    { changedBefore: '2026-10-24T00:00:00.000Z' },
  ])(
    'ignores stale successful choices after context changes to %j',
    async context => {
      // Arrange
      const pending = deferred<HistoryProviderSearchResponse>();
      const client = api(
        jest
          .fn()
          .mockReturnValueOnce(pending.promise)
          .mockResolvedValue({ items: ['current'] }),
      );
      const { props, rerender } = setup({ api: client });
      await open();
      // Act
      rerender(<HistoryProviderFilter {...props} context={context} />);
      await advance();
      await act(async () =>
        pending.resolve({ items: ['stale'], nextCursor: 'old-cursor' }),
      );
      fireEvent.keyDown(screen.getByRole('combobox', { name: 'Provider' }), {
        key: 'ArrowDown',
        code: 'ArrowDown',
      });
      // Assert
      expect(
        screen.getByRole('option', { name: 'current' }),
      ).toBeInTheDocument();
      expect(
        screen.queryByRole('option', { name: 'stale' }),
      ).not.toBeInTheDocument();
      expect(
        screen.queryByText('More matches. Type more to narrow.'),
      ).not.toBeInTheDocument();
      expect(props.onSelect).not.toHaveBeenCalled();
    },
  );

  it('gives a whitespace-only provider a readable escaped label while selecting its raw name', async () => {
    // Arrange
    const { props } = setup({
      api: api(jest.fn().mockResolvedValue({ items: ['   '] })),
    });
    // Act
    await open();
    fireEvent.keyDown(screen.getByRole('combobox', { name: 'Provider' }), {
      key: 'ArrowDown',
      code: 'ArrowDown',
    });
    const option = screen.getByRole('option');
    // Assert
    expect(option).toHaveAccessibleName(/\S/);
    expect(option).toHaveTextContent(JSON.stringify('   '), {
      normalizeWhitespace: false,
    });
    fireEvent.click(option);
    expect(props.onSelect).toHaveBeenCalledWith('   ');
  });

  it('ignores a stale successful prefix response while the latest search is still pending', async () => {
    // Arrange
    const old = deferred<HistoryProviderSearchResponse>();
    const latest = deferred<HistoryProviderSearchResponse>();
    const { props } = setup({
      api: api(
        jest
          .fn()
          .mockReturnValueOnce(old.promise)
          .mockReturnValue(latest.promise),
      ),
    });
    await open();
    // Act
    fireEvent.change(screen.getByRole('combobox', { name: 'Provider' }), {
      target: { value: 'latest' },
    });
    await advance();
    await act(async () => old.resolve({ items: ['stale'] }));
    // Assert
    expect(
      screen.queryByRole('option', { name: 'stale' }),
    ).not.toBeInTheDocument();
    expect(props.onSelect).not.toHaveBeenCalled();
    await act(async () => latest.resolve({ items: ['latest-result'] }));
    fireEvent.keyDown(screen.getByRole('combobox', { name: 'Provider' }), {
      key: 'ArrowDown',
      code: 'ArrowDown',
    });
    expect(
      screen.getByRole('option', { name: 'latest-result' }),
    ).toBeInTheDocument();
  });

  it('ignores custom text on Enter and blur, but clears an applied selection', async () => {
    // Arrange
    const { props } = setup({ value: 'old', appliedProvider: 'old' });
    await open();
    const input = screen.getByRole('combobox', { name: 'Provider' });
    // Act
    fireEvent.change(input, { target: { value: 'not-a-choice' } });
    await advance();
    fireEvent.keyDown(input, { key: 'Enter', code: 'Enter' });
    fireEvent.blur(input);
    expect(props.onSelect).not.toHaveBeenCalled();
    fireEvent.change(input, { target: { value: '' } });
    // Assert
    expect(props.onSelect).toHaveBeenCalledTimes(1);
    expect(props.onSelect).toHaveBeenCalledWith(undefined);
  });

  it('disables empty backend names instead of applying an empty provider', async () => {
    // Arrange
    const { props } = setup({
      api: api(jest.fn().mockResolvedValue({ items: [''] })),
    });
    // Act
    await open();
    fireEvent.keyDown(screen.getByRole('combobox', { name: 'Provider' }), {
      key: 'ArrowDown',
      code: 'ArrowDown',
    });
    const option = screen.getByRole('option', {
      name: 'Empty provider name (not selectable)',
    });
    fireEvent.click(option);
    // Assert
    expect(option).toHaveAttribute('aria-disabled', 'true');
    expect(props.onSelect).not.toHaveBeenCalled();
  });

  it('keeps empty successful results supported', async () => {
    // Arrange
    const { props } = setup();
    // Act
    await open();
    fireEvent.change(screen.getByRole('combobox', { name: 'Provider' }), {
      target: { value: 'absent' },
    });
    await advance();
    // Assert
    expect(
      screen.getByRole('combobox', { name: 'Provider' }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('textbox', { name: 'Provider' }),
    ).not.toBeInTheDocument();
    expect(props.onSelect).not.toHaveBeenCalled();
  });

  it('says when no provider matches the prefix', async () => {
    // Arrange
    setup();
    // Act
    await open();
    fireEvent.change(screen.getByRole('combobox', { name: 'Provider' }), {
      target: { value: 'absent' },
    });
    await advance();
    // Assert
    expect(screen.getByText('No matching providers.')).toBeInTheDocument();
  });

  it('clears the provider like the entity and kind pickers', async () => {
    // Arrange
    const { props } = setup({ value: 'old', appliedProvider: 'old' });
    // Act
    fireEvent.click(screen.getByRole('button', { name: 'Clear provider' }));
    // Assert
    expect(props.onSelect).toHaveBeenCalledWith(undefined);
    expect(screen.getByRole('combobox', { name: 'Provider' })).toHaveValue('');
    expect(
      screen.queryByRole('button', { name: 'Clear provider' }),
    ).not.toBeInTheDocument();
  });

  it('reuses a finished search on reopen but retries a failed one', async () => {
    // Arrange
    const getProviders = jest
      .fn()
      .mockRejectedValueOnce(new CatalogHistoryApiError(500))
      .mockResolvedValue({ items: ['one'] });
    setup({ api: api(getProviders) });
    const input = () => screen.getByRole('combobox', { name: 'Provider' });
    const expand = async () => {
      fireEvent.keyDown(input(), { key: 'ArrowDown', code: 'ArrowDown' });
      await advance(0);
    };
    const reopen = async () => {
      fireEvent.keyDown(input(), { key: 'Escape', code: 'Escape' });
      await advance(0);
      await expand();
    };
    // Act
    await open();
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    await expand();
    await reopen();
    await reopen();
    // Assert: the failure was retried once, then the success was reused.
    expect(getProviders).toHaveBeenCalledTimes(2);
    expect(
      screen.queryByRole('alert', { hidden: true }),
    ).not.toBeInTheDocument();
  });

  it('keeps focus in the field after Clear', async () => {
    // Arrange
    setup({ value: 'old', appliedProvider: 'old' });
    // Act
    fireEvent.click(screen.getByRole('button', { name: 'Clear provider' }));
    // Assert
    expect(screen.getByRole('combobox', { name: 'Provider' })).toHaveFocus();
  });

  it('reports loading while a search is pending', async () => {
    // Arrange
    const pending = deferred<HistoryProviderSearchResponse>();
    setup({ api: api(jest.fn().mockReturnValue(pending.promise)) });
    // Act
    await open();
    // Assert
    expect(
      screen.queryByText('No matching providers.'),
    ).not.toBeInTheDocument();
    await act(async () => pending.resolve({ items: [] }));
    expect(screen.getByText('No matching providers.')).toBeInTheDocument();
  });

  it('shows a narrow-prefix hint without following the next cursor', async () => {
    // Arrange
    const { props } = setup({
      api: api(
        jest.fn().mockResolvedValue({ items: ['one'], nextCursor: 'opaque' }),
      ),
    });
    // Act
    await open();
    await advance(1000);
    // Assert
    expect(
      screen.getByText('More matches. Type more to narrow.'),
    ).toBeInTheDocument();
    expect(props.api.getProviders).toHaveBeenCalledTimes(1);
    expect(props.api.getProviders).toHaveBeenCalledWith({
      prefix: undefined,
      limit: 25,
    });
  });

  it.each([404, 501])(
    'falls back only for typed HTTP %s and retains unfinished text without applying',
    async status => {
      // Arrange
      const pending = deferred<HistoryProviderSearchResponse>();
      const { props } = setup({
        api: api(jest.fn().mockReturnValue(pending.promise)),
      });
      await open();
      const input = screen.getByRole('combobox', { name: 'Provider' });
      fireEvent.change(input, { target: { value: 'unfinished' } });
      await advance();
      act(() => input.focus());
      // Act
      await act(async () => pending.reject(new CatalogHistoryApiError(status)));
      // Assert
      expect(screen.getByRole('textbox', { name: 'Provider' })).toHaveValue(
        'unfinished',
      );
      expect(screen.getByRole('textbox', { name: 'Provider' })).toHaveFocus();
      expect(props.onSelect).not.toHaveBeenCalled();
      expect(props.onLegacyChange).not.toHaveBeenCalled();
    },
  );

  it.each([401, 403, 500, 'network', 'misleading-status'])(
    'keeps discovery supported and hides raw failures for %s',
    async status => {
      // Arrange
      const error =
        typeof status === 'number'
          ? new CatalogHistoryApiError(status)
          : Object.assign(new Error('SECRET raw HTTP 404 body'), {
              status: 404,
            });
      const { props } = setup({ api: api(jest.fn().mockRejectedValue(error)) });
      // Act
      await open();
      // Assert
      expect(
        screen.getByRole('combobox', { name: 'Provider' }),
      ).toBeInTheDocument();
      expect(screen.getByRole('alert')).toHaveTextContent(
        status === 401 || status === 403 ? /access/i : /could not be loaded/i,
      );
      expect(screen.getByRole('alert')).not.toHaveTextContent('SECRET');
      expect(screen.getByRole('button', { name: 'Retry' })).toHaveAttribute(
        'type',
        'button',
      );
      expect(props.onSelect).not.toHaveBeenCalled();
    },
  );

  it('catches synchronous custom API failures and retries with the current prefix/context', async () => {
    // Arrange
    const client = api(
      jest.fn(() => {
        throw new Error('SECRET');
      }),
    );
    const { props, rerender } = setup({ api: client });
    await open();
    // Act
    fireEvent.change(screen.getByRole('combobox', { name: 'Provider' }), {
      target: { value: ' current ' },
    });
    rerender(
      <HistoryProviderFilter {...props} context={{ source: 'processing' }} />,
    );
    await advance();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await advance();
    // Assert
    expect(client.getProviders).toHaveBeenLastCalledWith({
      source: 'processing',
      prefix: ' current ',
      limit: 25,
    });
    expect(screen.getByRole('alert')).not.toHaveTextContent('SECRET');
    expect(props.onSelect).not.toHaveBeenCalled();
  });

  it.each(['prefix', 'context', 'api'] as const)(
    'ignores late unsupported errors after a new %s',
    async change => {
      // Arrange
      const pending = deferred<HistoryProviderSearchResponse>();
      const client = api(
        jest
          .fn()
          .mockReturnValueOnce(pending.promise)
          .mockResolvedValue({ items: ['current'] }),
      );
      const { props, rerender } = setup({ api: client });
      await open();
      // Act
      if (change === 'prefix')
        fireEvent.change(screen.getByRole('combobox', { name: 'Provider' }), {
          target: { value: 'new' },
        });
      if (change === 'context')
        rerender(
          <HistoryProviderFilter
            {...props}
            context={{
              entityRef: 'component:default/new',
              changedAfter: '2026-10-01T00:00:00.000Z',
            }}
          />,
        );
      if (change === 'api')
        rerender(
          <HistoryProviderFilter
            {...props}
            api={api(jest.fn().mockResolvedValue({ items: ['current'] }))}
          />,
        );
      await advance();
      await act(async () => pending.reject(new CatalogHistoryApiError(404)));
      // Assert
      expect(
        screen.getByRole('combobox', { name: 'Provider' }),
      ).toBeInTheDocument();
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
      expect(props.onSelect).not.toHaveBeenCalled();
    },
  );

  it('resets known unsupported state for a replacement API object', async () => {
    // Arrange
    const { props, rerender } = setup({
      api: api(jest.fn().mockRejectedValue(new CatalogHistoryApiError(501))),
    });
    await open();
    expect(
      screen.getByRole('textbox', { name: 'Provider' }),
    ).toBeInTheDocument();
    const replacement = api();
    // Act
    rerender(<HistoryProviderFilter {...props} api={replacement} />);
    await open();
    // Assert
    expect(replacement.getProviders).toHaveBeenCalledTimes(1);
    expect(
      screen.getByRole('combobox', { name: 'Provider' }),
    ).toBeInTheDocument();
  });

  it('does not steal focus when unsupported discovery finishes after focus left', async () => {
    // Arrange
    const pending = deferred<HistoryProviderSearchResponse>();
    setup({ api: api(jest.fn().mockReturnValue(pending.promise)) });
    const outside = document.createElement('button');
    document.body.append(outside);
    await open();
    act(() => outside.focus());
    fireEvent.blur(screen.getByRole('combobox', { name: 'Provider' }), {
      relatedTarget: outside,
    });
    // Act
    await act(async () => pending.reject(new CatalogHistoryApiError(404)));
    // Assert
    expect(outside).toHaveFocus();
    outside.remove();
  });

  it('cancels discovery debounce and ignores responses after unmount', async () => {
    // Arrange
    const pending = deferred<HistoryProviderSearchResponse>();
    const { props, unmount } = setup({
      api: api(jest.fn().mockReturnValue(pending.promise)),
    });
    await open();
    fireEvent.change(screen.getByRole('combobox', { name: 'Provider' }), {
      target: { value: 'pending' },
    });
    // Act
    unmount();
    await advance();
    await act(async () => pending.resolve({ items: ['late'] }));
    // Assert
    expect(props.api.getProviders).toHaveBeenCalledTimes(1);
    expect(props.onSelect).not.toHaveBeenCalled();
  });
});
