import type { HistoryEntitySnapshot } from '@kunickiaj/backstage-plugin-catalog-history-common';
import { summarizeSnapshotFields } from '../diffSnapshots';

const known = {
  owner: '',
  relations: [],
  statusItems: [],
  orphan: false,
} satisfies Partial<HistoryEntitySnapshot>;

describe('summarizeSnapshotFields', () => {
  it('reports all four changed fields', () => {
    // Arrange: empty values are recorded values, not missing payloads.
    const after = {
      owner: 'group:default/platform',
      relations: [{ type: 'ownedBy', targetRef: 'group:default/platform' }],
      statusItems: [{ type: 'test', level: 'error', message: 'failed' }],
      orphan: true,
    };

    // Act
    const summary = summarizeSnapshotFields(known, after);

    // Assert
    expect(summary).toEqual({
      ownerChanged: true,
      relationsChanged: true,
      statusChanged: true,
      orphanChanged: true,
    });
  });

  it('reports all four unchanged fields, including empty values and false', () => {
    // Arrange
    const after = { ...known, relations: [], statusItems: [] };

    // Act
    const summary = summarizeSnapshotFields(known, after);

    // Assert
    expect(summary).toEqual({
      ownerChanged: false,
      relationsChanged: false,
      statusChanged: false,
      orphanChanged: false,
    });
  });

  it.each(['owner', 'relations', 'statusItems', 'orphan'] as const)(
    'omits only %s when either side is unknown',
    field => {
      // Arrange
      const flag = {
        owner: 'ownerChanged',
        relations: 'relationsChanged',
        statusItems: 'statusChanged',
        orphan: 'orphanChanged',
      }[field];
      const partial = { ...known, [field]: undefined };
      const expected: Record<string, boolean> = {
        ownerChanged: false,
        relationsChanged: false,
        statusChanged: false,
        orphanChanged: false,
      };
      delete expected[flag];

      // Act
      const beforeUnknown = summarizeSnapshotFields(partial, known);
      const afterUnknown = summarizeSnapshotFields(known, partial);

      // Assert
      expect(beforeUnknown).toEqual(expected);
      expect(afterUnknown).toEqual(expected);
    },
  );

  it.each([
    [undefined, known],
    [known, undefined],
    [undefined, undefined],
    [{}, known],
    [known, {}],
  ])('returns no flags without comparable fields (%j, %j)', (before, after) => {
    // Arrange: missing snapshots and empty snapshots carry no known fields.
    const inputs = { before, after };

    // Act
    const summary = summarizeSnapshotFields(inputs.before, inputs.after);

    // Assert
    expect(summary).toEqual({});
  });

  it('ignores nested object key order', () => {
    // Arrange
    const before = {
      relations: [
        { type: 'ownedBy', target: { namespace: 'default', name: 'a' } },
      ],
      statusItems: [
        { type: 'test', error: { name: 'Error', message: 'failed' } },
      ],
    };
    const after = {
      relations: [
        { target: { name: 'a', namespace: 'default' }, type: 'ownedBy' },
      ],
      statusItems: [
        { error: { message: 'failed', name: 'Error' }, type: 'test' },
      ],
    };

    // Act
    const summary = summarizeSnapshotFields(before, after);

    // Assert
    expect(summary).toEqual({ relationsChanged: false, statusChanged: false });
  });

  it('treats relation and status array order as part of the saved value', () => {
    // Arrange
    const before = {
      relations: [{ type: 'a' }, { type: 'b' }],
      statusItems: [{ type: 'a' }, { type: 'b' }],
    };
    const after = {
      relations: [...before.relations].reverse(),
      statusItems: [...before.statusItems].reverse(),
    };

    // Act
    const summary = summarizeSnapshotFields(before, after);

    // Assert
    expect(summary).toEqual({ relationsChanged: true, statusChanged: true });
  });
});
