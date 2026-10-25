/** @jsxRuntime automatic */
import '@testing-library/jest-dom';
import { render, screen, within } from '@testing-library/react';
import type {
  HistoryEntitySnapshot,
  HistoryJsonObject,
} from '@kunickiaj/backstage-plugin-catalog-history-common';
import { HistorySnapshot } from './HistorySnapshot';

const identity = {
  entityRef: 'component:default/recorded',
  kind: 'Component',
  namespace: 'default',
  name: 'recorded',
};

function definition(region: HTMLElement, name: string) {
  const term = within(region).getByText(name, { selector: 'dt' });
  const value = term.nextElementSibling;
  if (!(value instanceof HTMLElement)) throw new Error(`Missing ${name}`);
  expect(value.tagName).toBe('DD');
  expect(term.closest('dl')).not.toBeNull();
  return value;
}

describe('HistorySnapshot', () => {
  it('renders captured fields and ordered memberships in named semantic sections', () => {
    // Arrange: captured fields deliberately disagree with spec and relations.
    const snapshot: HistoryEntitySnapshot = {
      ...identity,
      owner: 'group:other/captured-owner',
      memberOf: ['group:other/z', 'group:other/a'],
      parent: 'system:other/captured-parent',
      orphan: false,
      metadata: { title: 'Captured title' },
      spec: { owner: 'different-spec-owner' },
      relations: [{ type: 'ownedBy', targetRef: 'different-relation-owner' }],
      statusItems: [{ type: 'capture', level: 'warning', message: 'Recorded' }],
    };

    // Act
    const { container } = render(<HistorySnapshot snapshot={snapshot} />);

    // Assert
    for (const name of [
      'Recorded entity fields',
      'Metadata',
      'Spec',
      'Relations',
      'Status items',
    ]) {
      const region = screen.getByRole('region', { name });
      expect(within(region).getByRole('heading', { name })).toBeInTheDocument();
    }
    const fields = screen.getByRole('region', {
      name: 'Recorded entity fields',
    });
    expect(definition(fields, 'Owner')).toHaveTextContent(snapshot.owner!);
    expect(definition(fields, 'Parent')).toHaveTextContent(snapshot.parent!);
    expect(definition(fields, 'Orphan')).toHaveTextContent(/^No$/);
    expect(
      within(definition(fields, 'Memberships'))
        .getAllByRole('listitem')
        .map(item => item.textContent),
    ).toEqual(snapshot.memberOf);
    expect(fields).not.toHaveTextContent('different-spec-owner');
    expect(fields).not.toHaveTextContent('different-relation-owner');
    expect(container.querySelector('input, select, textarea, a')).toBeNull();
  });

  it('does not infer missing top-level fields from spec, relations, or annotations', () => {
    // Arrange
    const snapshot = {
      ...identity,
      spec: {
        owner: 'spec-owner',
        memberOf: ['spec-group'],
        parent: 'spec-parent',
      },
      metadata: { annotations: { 'backstage.io/orphan': 'false' } },
      relations: [{ type: 'childOf', targetRef: 'relation-parent' }],
    };

    // Act
    render(<HistorySnapshot snapshot={snapshot} />);

    // Assert
    const fields = screen.getByRole('region', {
      name: 'Recorded entity fields',
    });
    for (const name of ['Owner', 'Memberships', 'Parent', 'Orphan']) {
      expect(definition(fields, name)).toHaveTextContent(/^Not recorded$/);
    }
    expect(fields).not.toHaveTextContent(
      /spec-owner|spec-group|spec-parent|relation-parent/,
    );
    expect(within(fields).queryByText('No')).not.toBeInTheDocument();
    expect(within(fields).queryByRole('list')).not.toBeInTheDocument();
  });

  it.each([
    { orphan: true, label: 'Yes' },
    { orphan: false, label: 'No' },
    { orphan: undefined, label: 'Not recorded' },
  ])('distinguishes orphan $orphan as $label', ({ orphan, label }) => {
    // Arrange
    const snapshot = { ...identity, orphan };

    // Act
    render(<HistorySnapshot snapshot={snapshot} />);

    // Assert
    expect(
      definition(
        screen.getByRole('region', { name: 'Recorded entity fields' }),
        'Orphan',
      ),
    ).toHaveTextContent(new RegExp(`^${label}$`));
  });

  it('distinguishes explicitly empty captured strings and memberships from missing fields', () => {
    // Arrange
    const snapshot = { ...identity, owner: '', parent: '', memberOf: [] };

    // Act
    render(<HistorySnapshot snapshot={snapshot} />);

    // Assert
    const fields = screen.getByRole('region', {
      name: 'Recorded entity fields',
    });
    expect(definition(fields, 'Owner')).toHaveTextContent(/^Empty string$/);
    expect(definition(fields, 'Parent')).toHaveTextContent(/^Empty string$/);
    expect(definition(fields, 'Memberships')).toHaveTextContent(
      /^No memberships recorded$/,
    );
    expect(definition(fields, 'Orphan')).toHaveTextContent(/^Not recorded$/);
  });

  it('keeps every category visible when only snapshot identity was recorded', () => {
    // Arrange
    const snapshot = identity;

    // Act
    render(<HistorySnapshot snapshot={snapshot} />);

    // Assert
    expect(screen.getAllByRole('region')).toHaveLength(5);
    expect(screen.getByRole('region', { name: 'Metadata' })).toHaveTextContent(
      'Metadata was not recorded.',
    );
    expect(screen.getByRole('region', { name: 'Spec' })).toHaveTextContent(
      'Spec was not recorded.',
    );
    for (const name of ['Relations', 'Status items']) {
      expect(screen.getByRole('region', { name })).toHaveTextContent(
        'Not recorded',
      );
      expect(
        within(screen.getByRole('region', { name })).queryByRole('list'),
      ).not.toBeInTheDocument();
    }
  });

  it('identifies known-empty objects and arrays rather than calling them unrecorded', () => {
    // Arrange
    const snapshot = {
      ...identity,
      metadata: {},
      spec: {},
      relations: [],
      statusItems: [],
    };

    // Act
    render(<HistorySnapshot snapshot={snapshot} />);

    // Assert
    for (const [name, message] of [
      ['Metadata', 'No metadata fields recorded'],
      ['Spec', 'No spec fields recorded'],
      ['Relations', 'No relations recorded'],
      ['Status items', 'No status items recorded'],
    ]) {
      const region = screen.getByRole('region', { name });
      expect(region).toHaveTextContent(message);
      expect(region).not.toHaveTextContent(/was not recorded|Not recorded/);
    }
  });

  it.each(['metadata', 'spec'] as const)(
    'preserves scalar and nested JSON values in %s field definitions',
    property => {
      // Arrange
      const values = {
        zero: 0,
        disabled: false,
        absent: null,
        blank: '',
        '': 'empty-key',
        nested: { array: [0, false, null, '', { extra: 'retained' }] },
      };
      const snapshot = { ...identity, [property]: values };

      // Act
      const { container } = render(<HistorySnapshot snapshot={snapshot} />);

      // Assert
      const name = property === 'metadata' ? 'Metadata' : 'Spec';
      const region = screen.getByRole('region', { name });
      expect(definition(region, 'zero')).toHaveTextContent(/^0$/);
      expect(definition(region, 'disabled')).toHaveTextContent(/^false$/);
      expect(definition(region, 'absent')).toHaveTextContent(/^null$/);
      expect(definition(region, 'blank')).toHaveTextContent(/^""$/);
      expect(definition(region, 'Empty string (field name)')).toHaveTextContent(
        '"empty-key"',
      );
      const json = definition(region, 'nested').querySelector('pre')!;
      expect(JSON.parse(json.textContent!)).toEqual(values.nested);
      expect(json).toHaveAttribute('tabindex', '0');
      json.focus();
      expect(json).toHaveFocus();
      expect(container).not.toHaveTextContent('[object Object]');
    },
  );

  it('retains relation and status record order, extra keys, errors and empty records', () => {
    // Arrange
    const relations: HistoryJsonObject[] = [
      {
        type: 'dependsOn',
        targetRef: 'resource:default/one',
        extra: { count: 0 },
      },
      { type: 'ownedBy', targetRef: 'group:default/two' },
      {},
    ];
    const statusItems: HistoryJsonObject[] = [
      {
        type: 'processing',
        level: 'error',
        message: 'Failed at capture',
        errors: [{ name: 'SavedError', message: 'Original error' }],
        retryable: false,
      },
      {},
    ];

    // Act
    const { container } = render(
      <HistorySnapshot snapshot={{ ...identity, relations, statusItems }} />,
    );

    // Assert
    const relationItems = within(
      screen.getByRole('region', { name: 'Relations' }),
    ).getAllByRole('listitem');
    expect(relationItems).toHaveLength(3);
    expect(definition(relationItems[0], 'type')).toHaveTextContent(
      '"dependsOn"',
    );
    expect(definition(relationItems[0], 'targetRef')).toHaveTextContent(
      '"resource:default/one"',
    );
    expect(
      JSON.parse(definition(relationItems[0], 'extra').textContent!),
    ).toEqual({ count: 0 });
    expect(definition(relationItems[1], 'targetRef')).toHaveTextContent(
      '"group:default/two"',
    );
    expect(relationItems[2]).toHaveTextContent('No fields recorded');
    const status = within(
      screen.getByRole('region', { name: 'Status items' }),
    ).getAllByRole('listitem');
    for (const key of ['type', 'level', 'message', 'retryable'] as const) {
      expect(definition(status[0], key)).toHaveTextContent(
        JSON.stringify(statusItems[0][key]),
      );
    }
    expect(JSON.parse(definition(status[0], 'errors').textContent!)).toEqual(
      statusItems[0].errors,
    );
    expect(status[1]).toHaveTextContent('No fields recorded');
    expect(container).not.toHaveTextContent('[object Object]');
  });

  it('renders untrusted field names, values and references as literal text without active DOM', () => {
    // Arrange
    const html = '<img src=x onerror="alert(1)">';
    const script = '<script>alert(2)</script>';
    // eslint-disable-next-line no-script-url -- Verify saved untrusted URLs remain inert text.
    const url = 'javascript:alert(3)';
    const snapshot = {
      ...identity,
      owner: html,
      memberOf: [url],
      parent: script,
      metadata: { [html]: script },
      spec: { payload: html, nested: { url } },
      relations: [{ type: script, targetRef: url }],
      statusItems: [{ message: html, errors: [{ message: script }] }],
    };

    // Act
    const { container } = render(<HistorySnapshot snapshot={snapshot} />);

    // Assert
    const fields = screen.getByRole('region', {
      name: 'Recorded entity fields',
    });
    expect(definition(fields, 'Owner')).toHaveTextContent(html);
    expect(definition(fields, 'Parent')).toHaveTextContent(script);
    expect(definition(fields, 'Memberships')).toHaveTextContent(url);
    expect(
      definition(screen.getByRole('region', { name: 'Metadata' }), html),
    ).toHaveTextContent(JSON.stringify(script));
    expect(
      definition(screen.getByRole('region', { name: 'Spec' }), 'payload'),
    ).toHaveTextContent(JSON.stringify(html));
    expect(
      screen.getByRole('region', { name: 'Status items' }),
    ).toHaveTextContent(JSON.stringify(html));
    expect(screen.getByRole('region', { name: 'Relations' })).toHaveTextContent(
      JSON.stringify(url),
    );
    expect(
      container.querySelector(
        'img, script, a, iframe, form, [href], [src], [onclick], [onerror]',
      ),
    ).toBeNull();
  });
});
