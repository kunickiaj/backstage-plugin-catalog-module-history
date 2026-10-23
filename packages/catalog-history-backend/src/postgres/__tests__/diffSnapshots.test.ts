import type { HistoryEntitySnapshot } from '@kunickiaj/backstage-plugin-catalog-history-common';
import { diffSnapshots } from '../diffSnapshots';

const identity = {
  entityRef: 'component:default/example',
  kind: 'Component',
  namespace: 'default',
  name: 'example',
};

describe('diffSnapshots', () => {
  it('reports sorted nested field paths with exact add, remove, and replace values', () => {
    // Arrange: preserve null, false, and empty values rather than treating them as absent.
    const before: HistoryEntitySnapshot = {
      ...identity,
      metadata: { z: 'removed', nested: { flag: true, nullable: 'old' } },
      spec: { count: 1, list: ['old'] },
    };
    const after: HistoryEntitySnapshot = {
      ...identity,
      metadata: { nested: { nullable: null, flag: false }, added: '' },
      spec: { count: 0, list: [] },
    };

    // Act
    const changes = diffSnapshots(before, after);

    // Assert
    expect(changes).toEqual([
      { path: ['metadata', 'added'], op: 'add', after: '' },
      {
        path: ['metadata', 'nested', 'flag'],
        op: 'replace',
        before: true,
        after: false,
      },
      {
        path: ['metadata', 'nested', 'nullable'],
        op: 'replace',
        before: 'old',
        after: null,
      },
      { path: ['metadata', 'z'], op: 'remove', before: 'removed' },
      { path: ['spec', 'count'], op: 'replace', before: 1, after: 0 },
      { path: ['spec', 'list'], op: 'replace', before: ['old'], after: [] },
    ]);
  });

  it('compares all recorded payload columns but excludes identity and etag', () => {
    // Arrange
    const before: HistoryEntitySnapshot = { ...identity, etag: 'a' };
    const after: HistoryEntitySnapshot = {
      entityRef: 'group:other/renamed',
      kind: 'Group',
      namespace: 'other',
      name: 'renamed',
      etag: 'b',
      displayName: '',
      email: 'mail@example.org',
      memberOf: [],
      metadata: {},
      orphan: false,
      owner: 'group:default/team',
      parent: 'group:default/parent',
      relations: [],
      spec: {},
      statusItems: [],
    };

    // Act
    const changes = diffSnapshots(before, after);

    // Assert
    expect(changes).toEqual([
      { path: ['displayName'], op: 'add', after: '' },
      { path: ['email'], op: 'add', after: 'mail@example.org' },
      { path: ['memberOf'], op: 'add', after: [] },
      { path: ['metadata'], op: 'add', after: {} },
      { path: ['orphan'], op: 'add', after: false },
      { path: ['owner'], op: 'add', after: 'group:default/team' },
      { path: ['parent'], op: 'add', after: 'group:default/parent' },
      { path: ['relations'], op: 'add', after: [] },
      { path: ['spec'], op: 'add', after: {} },
      { path: ['statusItems'], op: 'add', after: [] },
    ]);
  });

  it('ignores identity, etag, undefined optional fields, and nested object key order', () => {
    // Arrange
    const before = {
      ...identity,
      etag: 'a',
      owner: undefined,
      spec: {
        nested: { a: 1, b: 2 },
        array: [{ a: 1, nested: { x: 1, y: 2 } }],
      },
    };
    const after = {
      ...identity,
      name: 'renamed',
      etag: 'b',
      spec: {
        array: [{ nested: { y: 2, x: 1 }, a: 1 }],
        nested: { b: 2, a: 1 },
      },
    };

    // Act
    const changes = diffSnapshots(before, after);

    // Assert
    expect(changes).toEqual([]);
  });

  it('replaces arrays as a whole when values or their order change', () => {
    // Arrange
    const before = {
      ...identity,
      relations: [{ targetRef: 'a' }, { targetRef: 'b' }],
      statusItems: [],
    };
    const after = {
      ...identity,
      relations: [{ targetRef: 'b' }, { targetRef: 'a' }],
      statusItems: [{ level: 'error' }],
    };

    // Act
    const changes = diffSnapshots(before, after);

    // Assert
    expect(changes).toEqual([
      {
        path: ['relations'],
        op: 'replace',
        before: before.relations,
        after: after.relations,
      },
      {
        path: ['statusItems'],
        op: 'replace',
        before: [],
        after: after.statusItems,
      },
    ]);
  });

  it('removes recorded payload fields for deletion without removing identity', () => {
    // Arrange
    const before = {
      ...identity,
      etag: 'a',
      metadata: { value: null },
      orphan: false,
      spec: {},
    };

    // Act
    const changes = diffSnapshots(before, undefined);

    // Assert
    expect(changes).toEqual([
      { path: ['metadata'], op: 'remove', before: { value: null } },
      { path: ['orphan'], op: 'remove', before: false },
      { path: ['spec'], op: 'remove', before: {} },
    ]);
  });

  it('returns no removals when a deleted snapshot contains only identity', () => {
    // Arrange
    const before = { ...identity, etag: 'a' };

    // Act
    const changes = diffSnapshots(before, undefined);

    // Assert
    expect(changes).toEqual([]);
  });
});
