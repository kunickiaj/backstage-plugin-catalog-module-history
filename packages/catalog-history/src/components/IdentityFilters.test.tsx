/** @jsxRuntime automatic */
import '@testing-library/jest-dom';
import { useState } from 'react';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import type {
  HistoryEntityIdentity,
  HistoryEntitySearchResponse,
  HistoryKindSearchResponse,
} from '@kunickiaj/backstage-plugin-catalog-history-common';
import { CatalogHistoryApiError } from '../api/CatalogHistoryApi';
import type { CatalogHistoryApi } from '../api/CatalogHistoryApi';
import { HistoryFilters } from './HistoryFilters';
import type { HistoryFiltersValue } from './HistoryFilters';
import { HistoryEntityFilter } from './HistoryEntityFilter';

const entity: HistoryEntityIdentity = {
  entityRef: 'component:default/retired',
  name: 'retired',
  kind: 'Component',
  namespace: 'default',
};
const group: HistoryEntityIdentity = {
  entityRef: 'group:teams/retired',
  name: 'retired',
  kind: 'Group',
  namespace: 'teams',
};

function client() {
  return {
    getEntities: jest.fn().mockResolvedValue({ items: [entity, group] }),
    getKinds: jest.fn().mockResolvedValue({ items: ['Component', 'Group'] }),
    getProviders: jest.fn().mockResolvedValue({ items: [' Raw%_\\ Name '] }),
    getEntityTimeline: jest.fn(),
    getEntityVersion: jest.fn(),
  };
}

// Mirror the real parent's applied-state feedback, without mocking BUI controls.
function Filters(props: {
  api: CatalogHistoryApi;
  onApply: jest.Mock;
  initial?: HistoryFiltersValue;
}) {
  const [applied, setApplied] = useState(props.initial ?? {});
  return (
    <HistoryFilters
      scope="all"
      api={props.api}
      appliedFilters={applied}
      onApply={value => {
        props.onApply(value);
        setApplied(value);
      }}
    />
  );
}

function setup(
  api: CatalogHistoryApi = client(),
  initial?: HistoryFiltersValue,
) {
  const onApply = jest.fn();
  const view = render(
    <Filters api={api} onApply={onApply} initial={initial} />,
  );
  return { ...view, onApply };
}

async function advance(milliseconds = 300) {
  await act(async () => {
    jest.advanceTimersByTime(milliseconds);
  });
}

function input(label: 'Entity' | 'Kind' | 'Provider') {
  return screen.getByRole('combobox', { name: label });
}

async function open(label: 'Entity' | 'Kind' | 'Provider') {
  closeMenus();
  fireEvent.focus(input(label));
  await advance(0);
  fireEvent.keyDown(input(label), { key: 'ArrowDown', code: 'ArrowDown' });
}

function closeMenus() {
  for (const field of document.querySelectorAll(
    'input[aria-expanded="true"]',
  )) {
    fireEvent.keyDown(field, { key: 'Escape', code: 'Escape' });
  }
}

function button(name: string) {
  closeMenus();
  return screen.getByRole('button', { name });
}

async function choose(label: 'Entity' | 'Kind' | 'Provider', name: string) {
  await open(label);
  fireEvent.click(screen.getByRole('option', { name }));
}

function edit(label: 'Entity' | 'Kind' | 'Provider', value: string) {
  fireEvent.change(input(label), { target: { value } });
}

function select(label: 'Source' | 'Operation', value: string) {
  closeMenus();
  fireEvent.click(
    screen.getByRole('button', { name: new RegExp(`${label}$`) }),
  );
  fireEvent.click(screen.getByRole('option', { name: value }));
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

describe('HistoryFilters retained identity selection', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('loads metadata lazily and selects the exact returned identity and kind in one update', async () => {
    // Arrange
    const api = client();
    const { onApply } = setup(api);
    await advance();
    expect(api.getEntities).not.toHaveBeenCalled();
    expect(api.getKinds).not.toHaveBeenCalled();
    // Act
    await choose('Entity', 'retired — Group / teams');
    // Assert
    expect(api.getEntities).toHaveBeenCalledWith({
      prefix: undefined,
      limit: 25,
    });
    expect(onApply).toHaveBeenCalledTimes(1);
    expect(onApply).toHaveBeenLastCalledWith(
      expect.objectContaining({ entityRef: group.entityRef, kind: 'Group' }),
    );
    expect(input('Kind')).toHaveValue('Group');
    expect(api.getEntityVersion).not.toHaveBeenCalled();
    expect(api.getEntityTimeline).not.toHaveBeenCalled();
  });

  it('distinguishes same-name entities across both namespace and kind', async () => {
    // Arrange
    const api = client();
    api.getEntities.mockResolvedValue({
      items: [
        entity,
        group,
        { ...entity, entityRef: 'component:other/retired', namespace: 'other' },
      ],
    });
    const { onApply } = setup(api);
    // Act
    await open('Entity');
    // Assert
    const options = screen.getAllByRole('option');
    expect(options).toHaveLength(3);
    expect(new Set(options.map(option => option.id)).size).toBe(3);
    expect(
      screen.getByRole('option', { name: 'retired — Component / default' }),
    ).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole('option', { name: 'retired — Component / other' }),
    );
    expect(onApply).toHaveBeenLastCalledWith(
      expect.objectContaining({
        entityRef: 'component:other/retired',
        kind: 'Component',
      }),
    );
  });

  it('debounces raw literal name prefixes without normalizing them as references', async () => {
    // Arrange
    const api = client();
    const { onApply } = setup(api);
    await open('Entity');
    // Act
    edit('Entity', 'discarded');
    await advance(200);
    edit('Entity', ' MiX%_\\ ');
    await advance(299);
    expect(api.getEntities).toHaveBeenCalledTimes(1);
    await advance(1);
    // Assert
    expect(api.getEntities).toHaveBeenLastCalledWith({
      prefix: ' MiX%_\\ ',
      limit: 25,
    });
    expect(onApply).not.toHaveBeenCalled();
    expect(api.getEntityVersion).not.toHaveBeenCalled();
  });

  it('does not commit an unknown entity prefix on Enter, blur, or unrelated filter flushing', async () => {
    // Arrange
    const api = client();
    api.getEntities.mockResolvedValue({ items: [] });
    const { onApply } = setup(api);
    await open('Entity');
    // Act
    edit('Entity', 'not-a-returned-identity');
    await advance();
    fireEvent.keyDown(input('Entity'), { key: 'Enter', code: 'Enter' });
    fireEvent.blur(input('Entity'));
    expect(onApply).not.toHaveBeenCalled();
    select('Operation', 'delete');
    // Assert
    expect(onApply).toHaveBeenCalledTimes(1);
    expect(onApply.mock.calls[0][0].entityRef).toBeUndefined();
    expect(onApply.mock.calls[0][0].op).toBe('delete');
  });

  it('selects a returned entity with ArrowDown and Enter without submitting the form', async () => {
    // Arrange
    const api = client();
    api.getEntities.mockResolvedValue({ items: [entity] });
    const { onApply } = setup(api);
    // Act
    await open('Entity');
    fireEvent.keyDown(input('Entity'), { key: 'Enter', code: 'Enter' });
    await advance();
    // Assert
    expect(onApply).toHaveBeenCalledTimes(1);
    expect(onApply).toHaveBeenCalledWith(
      expect.objectContaining({
        entityRef: entity.entityRef,
        kind: entity.kind,
      }),
    );
  });

  it('retains the applied identity while editing and while another filter flushes', async () => {
    // Arrange
    const { onApply } = setup();
    await choose('Entity', 'retired — Component / default');
    // Act
    edit('Entity', 'unfinished');
    await advance();
    // Assert
    expect(screen.getByText(/Current entity filter:/)).toHaveTextContent(
      entity.entityRef,
    );
    expect(onApply).toHaveBeenCalledTimes(1);
    select('Source', 'processing');
    expect(onApply).toHaveBeenCalledTimes(2);
    expect(onApply).toHaveBeenLastCalledWith(
      expect.objectContaining({
        entityRef: entity.entityRef,
        kind: entity.kind,
        source: 'processing',
      }),
    );
  });

  it('clears Entity while retaining the selected Kind and its display', async () => {
    // Arrange
    const { onApply } = setup();
    await choose('Entity', 'retired — Group / teams');
    // Act
    edit('Entity', '');
    await advance();
    // Assert
    expect(onApply).toHaveBeenCalledTimes(2);
    expect(onApply).toHaveBeenLastCalledWith(
      expect.objectContaining({ kind: 'Group' }),
    );
    expect(onApply.mock.calls[1][0].entityRef).toBeUndefined();
    expect(input('Entity')).toHaveValue('');
    expect(input('Kind')).toHaveValue('Group');
  });

  it('uses an empty prefix on first focus with an externally applied selection', async () => {
    // Arrange
    const api = client();
    render(
      <HistoryEntityFilter
        api={api}
        context={{ kind: entity.kind }}
        selected={entity}
        appliedEntityRef={entity.entityRef}
        value={entity.entityRef}
        onSelect={jest.fn()}
        onLegacyChange={jest.fn()}
      />,
    );
    // Act
    await open('Entity');
    // Assert
    expect(api.getEntities).toHaveBeenCalledTimes(1);
    expect(api.getEntities).toHaveBeenCalledWith({
      kind: 'Component',
      prefix: undefined,
      limit: 25,
    });
    expect(input('Entity')).toHaveValue('retired');
  });

  it('keeps server options that do not match the typed prefix and hints only when another page exists', async () => {
    // Arrange
    const api = client();
    api.getEntities.mockResolvedValue({
      items: [entity],
      nextCursor: 'opaque',
    });
    setup(api);
    await open('Entity');
    // Act
    edit('Entity', 'unrelated-prefix');
    await advance();
    fireEvent.keyDown(input('Entity'), { key: 'ArrowDown', code: 'ArrowDown' });
    // Assert
    expect(
      screen.getByRole('option', { name: 'retired — Component / default' }),
    ).toBeInTheDocument();
    expect(screen.getByText(/type more to narrow/i)).toBeInTheDocument();
    expect(api.getEntities).toHaveBeenCalledTimes(2);
    expect(
      api.getEntities.mock.calls.every(([request]) => !request.cursor),
    ).toBe(true);
    expect(
      screen.queryByRole('button', { name: /load more entities/i }),
    ).not.toBeInTheDocument();
  });

  it.each(['', '   ', '<a href="javascript:alert(1)">retired</a>'])(
    'renders unusual identity name %j as readable inert text without snapshot lookups',
    async name => {
      // Arrange
      const api = client();
      api.getEntities.mockResolvedValue({ items: [{ ...entity, name }] });
      const { container } = setup(api);
      // Act
      await open('Entity');
      // Assert
      const option = screen.getByRole('option');
      expect(option).toHaveAccessibleName(/Component.*default/);
      expect(option).toHaveTextContent(/\S/);
      expect(option).toHaveTextContent(
        name.trim() ? name : JSON.stringify(name),
        {
          normalizeWhitespace: false,
        },
      );
      expect(container.querySelector('a, img, script')).toBeNull();
      expect(screen.queryByRole('link')).not.toBeInTheDocument();
      expect(api.getEntityVersion).not.toHaveBeenCalled();
    },
  );

  it('deduplicates repeated canonical identities without losing selectable choices', async () => {
    // Arrange
    const api = client();
    api.getEntities.mockResolvedValue({ items: [entity, entity, group] });
    const { onApply } = setup(api);
    // Act
    await choose('Entity', 'retired — Group / teams');
    // Assert
    expect(onApply).toHaveBeenCalledTimes(1);
    expect(onApply).toHaveBeenLastCalledWith(
      expect.objectContaining({ entityRef: group.entityRef }),
    );
  });

  it('selects an empty stored name using its canonical reference without warnings or prefix edits', async () => {
    // Arrange: empty display metadata must not become an empty selection callback.
    const api = client();
    api.getEntities.mockResolvedValue({ items: [{ ...entity, name: '' }] });
    const warn = jest.spyOn(console, 'warn');
    try {
      const { onApply } = setup(api);
      // Act
      await choose('Entity', '"" — Component / default');
      await advance();
      // Assert
      expect(onApply).toHaveBeenCalledTimes(1);
      expect(onApply).toHaveBeenCalledWith(
        expect.objectContaining({
          entityRef: entity.entityRef,
          kind: 'Component',
        }),
      );
      expect(input('Entity')).toHaveValue(entity.entityRef);
      expect(input('Kind')).toHaveValue('Component');
      expect(
        api.getEntities.mock.calls.every(
          ([request]) => request.prefix === undefined,
        ),
      ).toBe(true);
      expect(warn.mock.calls.flat().join(' ')).not.toMatch(/textValue/i);
    } finally {
      warn.mockRestore();
    }
  });

  it('selects a long stored display name using its short canonical reference', async () => {
    // Arrange: retained display metadata need not fit entity-reference syntax.
    const api = client();
    const name = 'x'.repeat(6890);
    api.getEntities.mockResolvedValue({
      items: [
        {
          entityRef: 'component:default/wide',
          kind: 'Component',
          namespace: 'default',
          name,
        },
      ],
    });
    const { onApply } = setup(api);
    // Act
    await open('Entity');
    const option = screen.getByRole('option', {
      name: `${name} — Component / default`,
    });
    expect(option).not.toHaveAttribute('aria-disabled', 'true');
    fireEvent.click(option);
    await advance();
    // Assert
    expect(onApply).toHaveBeenCalledTimes(1);
    expect(onApply).toHaveBeenCalledWith(
      expect.objectContaining({
        entityRef: 'component:default/wide',
        kind: 'Component',
      }),
    );
    expect(input('Entity')).toHaveValue(name);
    expect(input('Entity')).not.toHaveAttribute('maxlength');
    expect(
      api.getEntities.mock.calls.every(([request]) => request.prefix !== name),
    ).toBe(true);
    expect(api.getEntityVersion).not.toHaveBeenCalled();
  });

  it.each(['garbage', 'Component:default/retired'])(
    'disables a custom response identity with a noncanonical reference %j',
    async entityRef => {
      // Arrange: malformed custom API responses must not bypass exact-ref validation.
      const api = client();
      api.getEntities.mockResolvedValue({ items: [{ ...entity, entityRef }] });
      const { onApply } = setup(api);
      // Act
      await open('Entity');
      const option = screen.getByRole('option', {
        name: 'retired — Component / default',
      });
      fireEvent.click(option);
      await advance();
      // Assert
      expect(option).toHaveAttribute('aria-disabled', 'true');
      expect(onApply).not.toHaveBeenCalled();
    },
  );
});

describe('HistoryFilters retained kinds and atomic identity changes', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('merges a lowercase retained entity kind with the original API kind spelling without prefix edits', async () => {
    // Arrange: deleted identities can carry lowercase kinds unlike older captures.
    const api = client();
    const entityRef = 'group:default/platform';
    api.getEntities.mockResolvedValue({
      items: [
        { entityRef, kind: 'group', namespace: 'default', name: 'platform' },
      ],
    });
    api.getKinds.mockResolvedValue({ items: ['Component', 'Group'] });
    const { onApply } = setup(api);
    await choose('Entity', 'platform — group / default');
    expect(input('Kind')).toHaveValue('group');
    // Act
    await open('Kind');
    await advance();
    const kinds = within(screen.getByRole('listbox', { name: /Kind/ }));
    // Assert
    expect(kinds.getAllByRole('option', { name: /^group$/i })).toHaveLength(1);
    expect(kinds.getByRole('option', { name: 'Group' })).toBeInTheDocument();
    expect(onApply).toHaveBeenCalledTimes(1);
    expect(onApply).toHaveBeenLastCalledWith(
      expect.objectContaining({ entityRef, kind: 'group' }),
    );
    expect(api.getKinds.mock.calls).toEqual([
      [{ prefix: undefined, limit: 25 }],
    ]);
    // Editing makes this a new selection rather than re-clicking the selected key.
    edit('Kind', 'Gro');
    await advance();
    fireEvent.keyDown(input('Kind'), { key: 'ArrowDown', code: 'ArrowDown' });
    fireEvent.click(
      within(screen.getByRole('listbox', { name: /Kind/ })).getByRole(
        'option',
        { name: 'Group' },
      ),
    );
    await advance();
    expect(onApply).toHaveBeenCalledTimes(2);
    expect(onApply).toHaveBeenLastCalledWith(
      expect.objectContaining({ entityRef, kind: 'Group' }),
    );
    expect(input('Entity')).toHaveValue('platform');
    expect(api.getKinds.mock.calls).toEqual([
      [{ prefix: undefined, limit: 25 }],
      [{ prefix: 'Gro', limit: 25 }],
    ]);
    expect(api.getEntityVersion).not.toHaveBeenCalled();
  });

  it('queries kinds lazily without any applied entity or event context', async () => {
    // Arrange
    const api = client();
    setup(api, {
      entityRef: entity.entityRef,
      kind: 'Component',
      source: 'processing',
      provider: ' Raw%_\\ Name ',
      op: 'delete',
      changedAfter: '2026-10-01T00:00:00.000Z',
      changedBefore: '2026-10-02T00:00:00.000Z',
    });
    await advance();
    expect(api.getKinds).not.toHaveBeenCalled();
    // Act
    await open('Kind');
    edit('Kind', ' CuStOm%_\\ ');
    await advance(299);
    expect(api.getKinds).toHaveBeenCalledTimes(1);
    await advance(1);
    // Assert
    expect(api.getKinds.mock.calls).toEqual([
      [{ prefix: undefined, limit: 25 }],
      [{ prefix: ' CuStOm%_\\ ', limit: 25 }],
    ]);
  });

  it('does not apply kind search text on Enter, blur, or another filter change', async () => {
    // Arrange
    const { onApply } = setup();
    await open('Kind');
    // Act
    edit('Kind', 'not-returned');
    await advance();
    fireEvent.keyDown(input('Kind'), { key: 'Enter', code: 'Enter' });
    fireEvent.blur(input('Kind'));
    expect(onApply).not.toHaveBeenCalled();
    select('Source', 'processing');
    // Assert
    expect(onApply).toHaveBeenCalledTimes(1);
    expect(onApply.mock.calls[0][0].kind).toBeUndefined();
  });

  it('clears an incompatible entity atomically when a different kind is selected', async () => {
    // Arrange
    const { onApply } = setup();
    await choose('Entity', 'retired — Component / default');
    // Act
    await choose('Kind', 'Group');
    // Assert
    expect(onApply).toHaveBeenCalledTimes(2);
    expect(onApply).toHaveBeenLastCalledWith(
      expect.objectContaining({ kind: 'Group' }),
    );
    expect(onApply.mock.calls[1][0].entityRef).toBeUndefined();
    expect(input('Entity')).toHaveValue('');
    expect(input('Kind')).toHaveValue('Group');
  });

  it('retains a matching entity when the selected kind differs only in case', async () => {
    // Arrange
    const api = client();
    api.getKinds.mockResolvedValue({ items: ['cOmPoNeNt'] });
    const { onApply } = setup(api);
    await choose('Entity', 'retired — Component / default');
    // Act
    await open('Kind');
    edit('Kind', 'cOm');
    await advance();
    fireEvent.keyDown(input('Kind'), { key: 'ArrowDown', code: 'ArrowDown' });
    fireEvent.click(screen.getByRole('option', { name: 'cOmPoNeNt' }));
    // Assert
    expect(onApply).toHaveBeenLastCalledWith(
      expect.objectContaining({
        kind: 'cOmPoNeNt',
        entityRef: entity.entityRef,
      }),
    );
    expect(input('Entity')).toHaveValue('retired');
  });

  it.each(['All kinds', 'clear'])(
    'removes only Kind using %s and retains Entity',
    async action => {
      // Arrange
      const { onApply } = setup();
      await choose('Entity', 'retired — Component / default');
      // Act
      if (action === 'clear') edit('Kind', '');
      else await choose('Kind', 'All kinds');
      await advance();
      // Assert
      expect(onApply).toHaveBeenCalledTimes(2);
      expect(onApply).toHaveBeenLastCalledWith(
        expect.objectContaining({
          kind: undefined,
          entityRef: entity.entityRef,
        }),
      );
      expect(input('Entity')).toHaveValue('retired');
    },
  );

  it('keeps the static All kinds key distinct from a raw backend kind with that name', async () => {
    // Arrange
    const api = client();
    api.getKinds.mockResolvedValue({ items: ['All kinds', 'all', '__all__'] });
    const { onApply } = setup(api);
    // Act
    await open('Kind');
    // Assert
    const options = screen.getAllByRole('option');
    expect(options).toHaveLength(4);
    expect(new Set(options.map(option => option.id)).size).toBe(4);
    fireEvent.click(screen.getByRole('option', { name: 'all' }));
    expect(onApply).toHaveBeenLastCalledWith(
      expect.objectContaining({ kind: 'all' }),
    );
  });

  it.each(['Entity', 'Kind'] as const)(
    'keeps a raw selected provider unchanged through %s selection, all kinds, entity clear, source and date changes',
    async control => {
      // Arrange
      const { onApply } = setup();
      await choose('Provider', 'Raw%_\\ Name');
      // Act
      if (control === 'Entity')
        await choose('Entity', 'retired — Component / default');
      else await choose('Kind', 'Component');
      await choose('Kind', 'All kinds');
      if (control === 'Entity') edit('Entity', '');
      select('Source', 'processing');
      fireEvent.change(screen.getByLabelText('Recorded after (local time)'), {
        target: { value: '2026-10-23T12:00' },
      });
      // Assert
      for (const [value] of onApply.mock.calls)
        expect(value.provider).toBe(' Raw%_\\ Name ');
    },
  );

  it('updates both displays when a later Entity selection changes its kind', async () => {
    // Arrange
    const { onApply } = setup();
    await choose('Kind', 'Component');
    // Act
    await choose('Entity', 'retired — Group / teams');
    // Assert
    expect(input('Kind')).toHaveValue('Group');
    expect(input('Entity')).toHaveValue('retired');
    expect(onApply).toHaveBeenCalledTimes(2);
    expect(onApply).toHaveBeenLastCalledWith(
      expect.objectContaining({ kind: 'Group', entityRef: group.entityRef }),
    );
  });

  it.each(['Entity', 'Kind'] as const)(
    'blocks %s selection during invalid dates, then applies the coherent draft once corrected',
    async control => {
      // Arrange
      const { onApply } = setup();
      fireEvent.change(screen.getByLabelText('Recorded after (local time)'), {
        target: { value: '2026-10-24T12:00' },
      });
      fireEvent.change(screen.getByLabelText('Recorded before (local time)'), {
        target: { value: '2026-10-23T12:00' },
      });
      // Act
      await choose(
        control,
        control === 'Entity' ? 'retired — Group / teams' : 'Group',
      );
      // Assert
      expect(onApply).toHaveBeenCalledTimes(1);
      expect(screen.getByRole('alert')).toHaveTextContent('Enter valid dates');
      fireEvent.change(screen.getByLabelText('Recorded before (local time)'), {
        target: { value: '2026-10-25T12:00' },
      });
      expect(onApply).toHaveBeenCalledTimes(2);
      expect(onApply).toHaveBeenLastCalledWith(
        expect.objectContaining({
          kind: 'Group',
          changedAfter: new Date('2026-10-24T12:00').toISOString(),
          changedBefore: new Date('2026-10-25T12:00').toISOString(),
        }),
      );
      expect(onApply.mock.calls[1][0].entityRef).toBe(
        control === 'Entity' ? group.entityRef : undefined,
      );
    },
  );

  it('sends applied Entity context only, never an invalid date draft or selected entity reference', async () => {
    // Arrange
    const api = client();
    const applied = {
      kind: 'Component',
      source: 'processing' as const,
      provider: ' Raw%_\\ Name ',
      entityRef: entity.entityRef,
      op: 'delete' as const,
      changedAfter: '2026-10-01T00:00:00.000Z',
      changedBefore: '2026-10-02T00:00:00.000Z',
    };
    render(
      <HistoryFilters
        scope="all"
        api={api}
        appliedFilters={applied}
        onApply={jest.fn()}
      />,
    );
    const before = screen.getByLabelText<HTMLInputElement>(
      'Recorded before (local time)',
    );
    const validity = jest
      .spyOn(before, 'validity', 'get')
      .mockReturnValue({ badInput: true } as ValidityState);
    fireEvent.change(screen.getByLabelText('Recorded before (local time)'), {
      target: { value: '2026-09-23T12:00' },
    });
    // Act
    await open('Entity');
    validity.mockRestore();
    // Assert
    expect(api.getEntities).toHaveBeenCalledWith({
      kind: applied.kind,
      source: applied.source,
      provider: applied.provider,
      op: applied.op,
      changedAfter: applied.changedAfter,
      changedBefore: applied.changedBefore,
      prefix: undefined,
      limit: 25,
    });
    expect(api.getEntities.mock.calls[0][0]).not.toHaveProperty('entityRef');
    expect(api.getEntities.mock.calls[0][0]).not.toHaveProperty('owner');
  });
});

describe('HistoryFilters kind pagination', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('loads later retained kinds only on explicit request, appends, and deduplicates', async () => {
    // Arrange
    const api = client();
    const first = Array.from({ length: 25 }, (_, index) => `Custom${index}`);
    api.getKinds
      .mockResolvedValueOnce({ items: first, nextCursor: 'opaque+/=' })
      .mockResolvedValue({ items: ['Custom24', 'Custom25'] });
    const { onApply } = setup(api);
    await open('Kind');
    expect(api.getKinds).toHaveBeenCalledTimes(1);
    // Act
    const more = button('Load more kinds');
    expect(more).toHaveAttribute('type', 'button');
    fireEvent.click(more);
    await advance(0);
    fireEvent.keyDown(input('Kind'), { key: 'ArrowDown', code: 'ArrowDown' });
    // Assert
    expect(api.getKinds.mock.calls).toEqual([
      [{ prefix: undefined, limit: 25 }],
      [{ prefix: undefined, limit: 25, cursor: 'opaque+/=' }],
    ]);
    expect(screen.getAllByRole('option')).toHaveLength(27);
    expect(screen.getAllByRole('option', { name: 'Custom24' })).toHaveLength(1);
    expect(screen.getByRole('option', { name: 'Custom0' })).toBeInTheDocument();
    expect(onApply).not.toHaveBeenCalled();
    expect(
      screen.queryByRole('button', { name: 'Load more kinds' }),
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('option', { name: 'Custom25' }));
    expect(onApply).toHaveBeenCalledTimes(1);
    expect(onApply).toHaveBeenLastCalledWith(
      expect.objectContaining({ kind: 'Custom25' }),
    );
  });

  it('retries the failed later-page cursor and raw prefix without discarding the first page', async () => {
    // Arrange
    const api = client();
    api.getKinds.mockResolvedValue({
      items: ['CustomA'],
      nextCursor: 'page-2',
    });
    const { onApply } = setup(api);
    await open('Kind');
    edit('Kind', ' CuStOm ');
    await advance();
    api.getKinds.mockRejectedValueOnce(
      new Error('<script>private backend body</script>'),
    );
    // Act
    fireEvent.click(button('Load more kinds'));
    await advance(0);
    // Assert
    expect(onApply).not.toHaveBeenCalled();
    fireEvent.keyDown(input('Kind'), { key: 'ArrowDown', code: 'ArrowDown' });
    expect(screen.getByRole('option', { name: 'CustomA' })).toBeInTheDocument();
    closeMenus();
    expect(screen.getByRole('alert')).not.toHaveTextContent(
      'private backend body',
    );
    api.getKinds.mockResolvedValue({ items: ['CustomB'] });
    fireEvent.click(button('Retry'));
    await advance(0);
    expect(api.getKinds).toHaveBeenCalledTimes(4);
    expect(api.getKinds.mock.calls.slice(-2)).toEqual([
      [{ prefix: ' CuStOm ', limit: 25, cursor: 'page-2' }],
      [{ prefix: ' CuStOm ', limit: 25, cursor: 'page-2' }],
    ]);
    fireEvent.keyDown(input('Kind'), { key: 'ArrowDown', code: 'ArrowDown' });
    expect(screen.getByRole('option', { name: 'CustomA' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'CustomB' })).toBeInTheDocument();
  });

  it.each(['', 'new'])(
    'ignores a pending later page immediately when the prefix changes to %j',
    async prefix => {
      // Arrange
      const api = client();
      const page = deferred<HistoryKindSearchResponse>();
      api.getKinds.mockResolvedValue({
        items: ['OldFirst'],
        nextCursor: 'old-next',
      });
      setup(api);
      await open('Kind');
      edit('Kind', 'old');
      await advance();
      api.getKinds
        .mockReturnValueOnce(page.promise)
        .mockResolvedValue({ items: ['NewFirst'] });
      fireEvent.click(button('Load more kinds'));
      await advance(0);
      // Act
      edit('Kind', prefix);
      await act(async () =>
        page.resolve({ items: ['OldLater'], nextCursor: 'obsolete' }),
      );
      // Assert: stale choices disappear before the next debounce finishes.
      expect(
        screen.queryByRole('option', { name: 'OldLater' }),
      ).not.toBeInTheDocument();
      expect(
        screen.queryByRole('option', { name: 'OldFirst' }),
      ).not.toBeInTheDocument();
      await advance();
      fireEvent.keyDown(input('Kind'), { key: 'ArrowDown', code: 'ArrowDown' });
      expect(
        screen.getByRole('option', { name: 'NewFirst' }),
      ).toBeInTheDocument();
      expect(api.getKinds).toHaveBeenLastCalledWith({
        prefix: prefix || undefined,
        limit: 25,
      });
    },
  );
});

describe.each(['Entity', 'Kind'] as const)(
  'HistoryFilters %s discovery lifecycle',
  control => {
    beforeEach(() => jest.useFakeTimers());
    afterEach(() => jest.useRealTimers());

    function method(api: ReturnType<typeof client>) {
      return control === 'Entity' ? api.getEntities : api.getKinds;
    }

    function page() {
      return control === 'Entity'
        ? { items: [entity] }
        : { items: ['Component'] };
    }

    function legacy() {
      return screen.getByRole('textbox', {
        name: control === 'Entity' ? 'Entity reference' : 'Kind',
      });
    }

    it('keeps each optional discovery method independent', async () => {
      // Arrange
      const api: CatalogHistoryApi = client();
      if (control === 'Entity') delete api.getEntities;
      else delete api.getKinds;
      const { onApply } = setup(api);
      // Act
      fireEvent.change(legacy(), {
        target: { value: control === 'Entity' ? ' Example ' : ' gRoUp ' },
      });
      await advance(299);
      expect(onApply).not.toHaveBeenCalled();
      await advance(1);
      // Assert
      expect(
        input(control === 'Entity' ? 'Kind' : 'Entity'),
      ).toBeInTheDocument();
      expect(onApply).toHaveBeenCalledTimes(1);
      expect(onApply).toHaveBeenLastCalledWith(
        expect.objectContaining(
          control === 'Entity'
            ? { entityRef: 'component:default/example' }
            : { kind: 'gRoUp' },
        ),
      );
    });

    it.each([404, 501])(
      'falls back only its own control for HTTP %i without applying the search prefix',
      async status => {
        // Arrange
        const api = client();
        method(api).mockRejectedValue(new CatalogHistoryApiError(status));
        const { onApply } = setup(api);
        fireEvent.focus(input(control));
        edit(control, 'unfinished');
        // Act
        await advance();
        // Assert
        expect(legacy()).toHaveValue('unfinished');
        expect(
          input(control === 'Entity' ? 'Kind' : 'Entity'),
        ).toBeInTheDocument();
        expect(onApply).not.toHaveBeenCalled();
        select('Source', 'processing');
        expect(onApply).toHaveBeenCalledTimes(1);
        expect(
          onApply.mock.calls[0][0][control === 'Entity' ? 'entityRef' : 'kind'],
        ).toBeUndefined();
        fireEvent.change(legacy(), {
          target: { value: control === 'Entity' ? ' NewExact ' : ' Group ' },
        });
        await advance(299);
        expect(onApply).toHaveBeenCalledTimes(1);
        await advance(1);
        expect(onApply).toHaveBeenCalledTimes(2);
        expect(onApply).toHaveBeenLastCalledWith(
          expect.objectContaining(
            control === 'Entity'
              ? { entityRef: 'component:default/newexact' }
              : { kind: 'Group' },
          ),
        );
      },
    );

    it('keeps successful empty results supported and retains All kinds', async () => {
      // Arrange
      const api = client();
      method(api).mockResolvedValue({ items: [] });
      setup(api);
      // Act
      await open(control);
      // Assert
      expect(input(control)).toBeInTheDocument();
      expect(
        screen.queryByRole('textbox', {
          name: control === 'Entity' ? 'Entity reference' : 'Kind',
        }),
      ).not.toBeInTheDocument();
      expect(
        screen.queryAllByRole('option', { name: 'All kinds' }),
      ).toHaveLength(control === 'Kind' ? 1 : 0);
    });

    it.each([401, 403, 500, 'network', 'synchronous'] as const)(
      'keeps %s failures safe and retryable rather than treating them as unsupported',
      async failure => {
        // Arrange
        const api = client();
        const error =
          typeof failure === 'number'
            ? new CatalogHistoryApiError(failure)
            : new Error('<a>private backend body</a>');
        if (failure === 'synchronous')
          method(api).mockImplementationOnce(() => {
            throw error;
          });
        else method(api).mockRejectedValueOnce(error);
        const { onApply, container } = setup(api);
        // Act
        await open(control);
        // Assert
        closeMenus();
        expect(input(control)).toBeInTheDocument();
        expect(screen.getByRole('alert')).not.toHaveTextContent(
          'private backend body',
        );
        expect(container.querySelector('a, script')).toBeNull();
        expect(onApply).not.toHaveBeenCalled();
        method(api).mockResolvedValue(page());
        const retry = screen.getByRole('button', { name: 'Retry' });
        expect(retry).toHaveAttribute('type', 'button');
        fireEvent.click(retry);
        await advance(0);
        expect(method(api)).toHaveBeenCalledTimes(2);
        expect(screen.queryByRole('alert')).not.toBeInTheDocument();
      },
    );

    it.each([
      null,
      {},
      { items: null },
      { items: [42] },
      { items: [], nextCursor: 42 },
    ])(
      'rejects malformed discovery response %j without falling back',
      async response => {
        // Arrange
        const api = client();
        method(api).mockResolvedValue(response);
        setup(api);
        // Act
        await open(control);
        // Assert
        closeMenus();
        expect(input(control)).toBeInTheDocument();
        expect(screen.getByRole('alert')).toBeInTheDocument();
        expect(
          screen.getByRole('button', { name: 'Retry' }),
        ).toBeInTheDocument();
      },
    );

    it('removes old options immediately and shows loading before the debounce deadline', async () => {
      // Arrange
      const api = client();
      method(api).mockResolvedValue(page());
      setup(api);
      await open(control);
      // Act
      edit(control, 'new-prefix');
      // Assert
      expect(
        screen.queryByRole('option', {
          name:
            control === 'Entity'
              ? 'retired — Component / default'
              : 'Component',
        }),
      ).not.toBeInTheDocument();
      expect(
        screen.queryByText(/no (results|matches)/i),
      ).not.toBeInTheDocument();
      expect(method(api)).toHaveBeenCalledTimes(1);
      await advance(299);
      expect(method(api)).toHaveBeenCalledTimes(1);
      await advance(1);
      expect(method(api)).toHaveBeenCalledTimes(2);
    });

    it.each(['success', 'unsupported', 'error'] as const)(
      'ignores a stale %s response after the raw prefix changes',
      async outcome => {
        // Arrange
        const api = client();
        const pending = deferred<
          HistoryEntitySearchResponse | HistoryKindSearchResponse
        >();
        method(api)
          .mockReturnValueOnce(pending.promise)
          .mockResolvedValue({ items: [] });
        const { onApply } = setup(api);
        await open(control);
        // Act
        edit(control, 'new-prefix');
        await act(async () => {
          if (outcome === 'success') pending.resolve(page());
          else
            pending.reject(
              outcome === 'unsupported'
                ? new CatalogHistoryApiError(404)
                : new Error('old error'),
            );
        });
        // Assert
        expect(input(control)).toBeInTheDocument();
        expect(screen.queryByRole('alert')).not.toBeInTheDocument();
        expect(
          screen.queryByRole('option', {
            name:
              control === 'Entity'
                ? 'retired — Component / default'
                : 'Component',
          }),
        ).not.toBeInTheDocument();
        expect(onApply).not.toHaveBeenCalled();
        await advance();
        expect(method(api)).toHaveBeenLastCalledWith({
          prefix: 'new-prefix',
          limit: 25,
        });
      },
    );

    it.each(['success', 'unsupported'] as const)(
      'reset discards pending %s responses and cancels unfinished query timers',
      async outcome => {
        // Arrange
        const api = client();
        const pending = deferred<
          HistoryEntitySearchResponse | HistoryKindSearchResponse
        >();
        method(api)
          .mockReturnValueOnce(pending.promise)
          .mockResolvedValue({ items: [] });
        const { onApply } = setup(api);
        await open(control);
        edit(control, 'pending');
        // Act
        fireEvent.click(button('Reset filters'));
        await advance();
        await act(async () => {
          if (outcome === 'success') pending.resolve(page());
          else pending.reject(new CatalogHistoryApiError(501));
        });
        // Assert
        expect(method(api)).toHaveBeenCalledTimes(1);
        expect(onApply).toHaveBeenCalledTimes(1);
        expect(onApply).toHaveBeenLastCalledWith({});
        expect(input('Entity')).toHaveValue('');
        expect(input('Kind')).toHaveValue('All kinds');
        expect(screen.queryByRole('alert')).not.toBeInTheDocument();
      },
    );

    it('unmount cancels query timers and ignores a late failure', async () => {
      // Arrange
      const api = client();
      const pending = deferred<
        HistoryEntitySearchResponse | HistoryKindSearchResponse
      >();
      method(api).mockReturnValue(pending.promise);
      const { unmount, onApply } = setup(api);
      await open(control);
      edit(control, 'pending');
      // Act
      unmount();
      await advance();
      await act(async () => pending.reject(new CatalogHistoryApiError(404)));
      // Assert
      expect(method(api)).toHaveBeenCalledTimes(1);
      expect(onApply).not.toHaveBeenCalled();
    });

    it('replaces the API without reusing cached choices or accepting old unsupported errors', async () => {
      // Arrange
      const api = client();
      const next = client();
      const pending = deferred<
        HistoryEntitySearchResponse | HistoryKindSearchResponse
      >();
      method(api).mockReturnValue(pending.promise);
      method(next).mockResolvedValue(page());
      const { rerender, onApply } = setup(api);
      await open(control);
      // Act
      rerender(<Filters api={next} onApply={onApply} />);
      await advance();
      await act(async () => pending.reject(new CatalogHistoryApiError(404)));
      // Assert
      expect(input(control)).toBeInTheDocument();
      expect(method(next)).toHaveBeenCalledTimes(1);
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
      expect(onApply).not.toHaveBeenCalled();
    });

    it('preserves the API method receiver', async () => {
      // Arrange
      const api = client();
      setup(api);
      // Act
      await open(control);
      // Assert
      expect(method(api).mock.contexts[0]).toBe(api);
      expect(method(api)).toHaveBeenCalledTimes(1);
    });

    it('preserves typed fallback text and focus when the field is still focused', async () => {
      // Arrange
      const api = client();
      const pending = deferred<
        HistoryEntitySearchResponse | HistoryKindSearchResponse
      >();
      method(api).mockReturnValue(pending.promise);
      const { onApply } = setup(api);
      act(() => input(control).focus());
      edit(control, 'unfinished');
      await advance();
      // Act
      await act(async () => pending.reject(new CatalogHistoryApiError(501)));
      // Assert
      expect(legacy()).toHaveValue('unfinished');
      expect(legacy()).toHaveFocus();
      expect(onApply).not.toHaveBeenCalled();
    });

    it('does not steal focus when an unsupported response arrives after focus moved away', async () => {
      // Arrange
      const api = client();
      const pending = deferred<
        HistoryEntitySearchResponse | HistoryKindSearchResponse
      >();
      method(api).mockReturnValue(pending.promise);
      const { onApply } = setup(api);
      const elsewhere = screen.getByRole('button', { name: 'Reset filters' });
      act(() => input(control).focus());
      edit(control, 'unfinished');
      await advance();
      // Act
      act(() => elsewhere.focus());
      await act(async () => pending.reject(new CatalogHistoryApiError(501)));
      // Assert
      expect(elsewhere).toHaveFocus();
      expect(screen.getByDisplayValue('unfinished')).toBeInTheDocument();
      expect(onApply).not.toHaveBeenCalled();
    });
  },
);

describe('HistoryFilters applied Entity context generations', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it.each([
    { kind: 'Group' },
    { source: 'processing' as const },
    { provider: ' Raw replacement ' },
    { op: 'delete' as const },
    { changedAfter: '2026-10-01T00:00:00.000Z' },
    { changedBefore: '2026-10-24T00:00:00.000Z' },
  ])(
    'ignores stale unsupported responses after context changes to %j',
    async context => {
      // Arrange
      const api = client();
      const pending = deferred<HistoryEntitySearchResponse>();
      api.getEntities
        .mockReturnValueOnce(pending.promise)
        .mockResolvedValue({ items: [group] });
      const onApply = jest.fn();
      const { rerender } = render(
        <HistoryFilters
          scope="all"
          api={api}
          onApply={onApply}
          appliedFilters={{}}
        />,
      );
      await open('Entity');
      // Act
      rerender(
        <HistoryFilters
          scope="all"
          api={api}
          onApply={onApply}
          appliedFilters={context}
        />,
      );
      await advance();
      await act(async () => pending.reject(new CatalogHistoryApiError(404)));
      fireEvent.keyDown(input('Entity'), {
        key: 'ArrowDown',
        code: 'ArrowDown',
      });
      // Assert
      expect(input('Entity')).toBeInTheDocument();
      expect(
        screen.getByRole('option', { name: 'retired — Group / teams' }),
      ).toBeInTheDocument();
      expect(api.getEntities).toHaveBeenLastCalledWith({
        ...context,
        prefix: undefined,
        limit: 25,
      });
      expect(onApply).not.toHaveBeenCalled();
    },
  );

  it('hides old successful options while refreshed context results are pending', async () => {
    // Arrange
    const api = client();
    const pending = deferred<HistoryEntitySearchResponse>();
    api.getEntities
      .mockResolvedValueOnce({ items: [entity], nextCursor: 'old' })
      .mockReturnValue(pending.promise);
    const onApply = jest.fn();
    const { rerender } = render(
      <HistoryFilters scope="all" api={api} onApply={onApply} />,
    );
    await open('Entity');
    expect(
      screen.getByRole('option', { name: 'retired — Component / default' }),
    ).toBeInTheDocument();
    // Act
    rerender(
      <HistoryFilters
        scope="all"
        api={api}
        onApply={onApply}
        appliedFilters={{ provider: 'new-provider' }}
      />,
    );
    // Assert
    expect(
      screen.queryByRole('option', { name: 'retired — Component / default' }),
    ).not.toBeInTheDocument();
    closeMenus();
    expect(screen.queryByText(/type more to narrow/i)).not.toBeInTheDocument();
    await act(async () => pending.resolve({ items: [group] }));
    expect(onApply).not.toHaveBeenCalled();
  });

  it('does not refetch for equal applied context objects or fetch eagerly on mount', async () => {
    // Arrange
    const api = client();
    const onApply = jest.fn();
    const { rerender } = render(
      <HistoryFilters
        scope="all"
        api={api}
        onApply={onApply}
        appliedFilters={{ source: 'processing' }}
      />,
    );
    // Act
    rerender(
      <HistoryFilters
        scope="all"
        api={api}
        onApply={onApply}
        appliedFilters={{ source: 'processing' }}
      />,
    );
    await advance();
    // Assert
    expect(api.getEntities).not.toHaveBeenCalled();
    expect(api.getKinds).not.toHaveBeenCalled();
    expect(onApply).not.toHaveBeenCalled();
    await open('Entity');
    rerender(
      <HistoryFilters
        scope="all"
        api={api}
        onApply={onApply}
        appliedFilters={{ source: 'processing' }}
      />,
    );
    await advance();
    expect(api.getEntities).toHaveBeenCalledTimes(1);
  });

  it('does not resurrect a selected identity after reset and an unrelated change', async () => {
    // Arrange
    const { onApply } = setup();
    await choose('Entity', 'retired — Group / teams');
    // Act
    fireEvent.click(button('Reset filters'));
    select('Source', 'processing');
    await advance();
    // Assert
    expect(input('Entity')).toHaveValue('');
    expect(input('Kind')).toHaveValue('All kinds');
    expect(onApply).toHaveBeenCalledTimes(3);
    expect(onApply.mock.calls[1][0]).toEqual({});
    expect(onApply.mock.calls[2][0].entityRef).toBeUndefined();
    expect(onApply.mock.calls[2][0].kind).toBeUndefined();
  });

  it('retains entity-kind compatibility checks after legacy Provider editing', async () => {
    // Arrange
    const api = client();
    const withoutProviderDiscovery: CatalogHistoryApi = {
      ...api,
      getProviders: undefined,
    };
    const { onApply } = setup(withoutProviderDiscovery);
    await choose('Entity', 'retired — Component / default');
    // Act
    fireEvent.change(screen.getByRole('textbox', { name: 'Provider' }), {
      target: { value: ' directory-provider ' },
    });
    await advance();
    await choose('Kind', 'Group');
    // Assert
    expect(onApply).toHaveBeenCalledTimes(3);
    expect(onApply.mock.calls[1][0]).toEqual(
      expect.objectContaining({
        entityRef: entity.entityRef,
        kind: 'Component',
        provider: 'directory-provider',
      }),
    );
    expect(onApply.mock.calls[2][0]).toEqual(
      expect.objectContaining({
        kind: 'Group',
        provider: 'directory-provider',
      }),
    );
    expect(onApply.mock.calls[2][0].entityRef).toBeUndefined();
    expect(input('Entity')).toHaveValue('');
    expect(input('Kind')).toHaveValue('Group');
  });

  it.each(['reset', 'API replacement', 'unmount'] as const)(
    'ignores a pending later kind page after %s',
    async action => {
      // Arrange
      const api = client();
      const pending = deferred<HistoryKindSearchResponse>();
      api.getKinds
        .mockResolvedValueOnce({ items: ['OldFirst'], nextCursor: 'next' })
        .mockReturnValue(pending.promise);
      const { onApply, rerender, unmount } = setup(api);
      await open('Kind');
      fireEvent.click(button('Load more kinds'));
      await advance(0);
      // Act
      if (action === 'reset') fireEvent.click(button('Reset filters'));
      if (action === 'API replacement') {
        const next = client();
        next.getKinds.mockResolvedValue({ items: ['NewFirst'] });
        rerender(<Filters api={next} onApply={onApply} />);
        await advance();
      }
      if (action === 'unmount') unmount();
      await act(async () =>
        pending.resolve({ items: ['OldLater'], nextCursor: 'obsolete' }),
      );
      // Assert
      expect(
        screen.queryByRole('option', { name: 'OldLater' }),
      ).not.toBeInTheDocument();
      expect(screen.queryByText('OldLater')).not.toBeInTheDocument();
      expect(
        screen.queryByRole('button', { name: 'Load more kinds' }),
      ).not.toBeInTheDocument();
      expect(onApply).toHaveBeenCalledTimes(action === 'reset' ? 1 : 0);
    },
  );
});
