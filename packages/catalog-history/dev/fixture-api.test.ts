import { createFixtureApi } from './fixture-api';
import {
  crossEntityChanges,
  crossEntityRecords,
  previewChanges,
  previewEntityRef,
  previewRecords,
} from './fixtures';
import type { HistoryPage } from '@kunickiaj/backstage-plugin-catalog-history-common';

// The preview fake only has to feed every view and page through it. Cursor
// and validation rules belong to the real backend's tests.
async function all<T>(
  read: (cursor?: string) => Promise<HistoryPage<T>>,
): Promise<T[]> {
  const items: T[] = [];
  let cursor: string | undefined;
  do {
    const page = await read(cursor);
    items.push(...page.items);
    cursor = page.nextCursor;
  } while (cursor);
  return items;
}

describe('development fixture API', () => {
  it('pages every cross-entity event once in five-row pages without snapshots', async () => {
    // Arrange
    const api = createFixtureApi();
    // Act
    const first = await api.getChangeFeed!({});
    const items = await all(cursor => api.getChangeFeed!({ cursor }));
    // Assert
    expect(first.items).toHaveLength(5);
    expect(items.map(item => item.id)).toEqual(
      crossEntityRecords.map(row => row.id),
    );
    expect(items.every(item => !('snapshot' in item))).toBe(true);
    expect(items[0]).toMatchObject({
      kind: expect.any(String),
      name: expect.any(String),
    });
  });

  it('filters the feed by entity, kind, source, and operation', async () => {
    // Arrange
    const api = createFixtureApi();
    // Act
    const deletes = await all(cursor =>
      api.getChangeFeed!({ op: 'delete', cursor }),
    );
    const groups = await all(cursor =>
      api.getChangeFeed!({ kind: 'group', cursor }),
    );
    // Assert
    expect(deletes.length).toBeGreaterThan(0);
    expect(deletes.every(item => item.op === 'delete')).toBe(true);
    expect(groups.every(item => item.entityRef.startsWith('group:'))).toBe(
      true,
    );
  });

  it('pages the entity timeline five rows at a time', async () => {
    // Arrange
    const api = createFixtureApi();
    // Act
    const items = await all(cursor =>
      api.getEntityTimeline({ entityRef: previewEntityRef, cursor }),
    );
    // Assert
    expect(items.map(item => item.id)).toEqual(
      previewRecords.map(row => row.id),
    );
  });

  it('rejects a cursor it did not issue', async () => {
    // Arrange
    const api = createFixtureApi();
    // Act / Assert
    await expect(
      api.getChangeFeed!({ cursor: 'other:1' }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('lists recording cycles, including an empty heartbeat, and their changes', async () => {
    // Arrange
    const api = createFixtureApi();
    // Act
    const cycles = await all(cursor => api.listCycles!({ limit: 2, cursor }));
    const empty = await api.getCycle!({ cycleId: 'preview-empty-cycle' });
    const withChanges = await api.getCycle!({
      cycleId: crossEntityRecords[0].cycleId,
    });
    // Assert
    expect(new Set(cycles.map(cycle => cycle.cycleId)).size).toBe(
      cycles.length,
    );
    expect(cycles.map(cycle => cycle.cycleId)).toContain('preview-empty-cycle');
    expect(empty.changes.items).toEqual([]);
    expect(withChanges.changes.items.length).toBeGreaterThan(0);
    await expect(api.getCycle!({ cycleId: 'missing' })).rejects.toMatchObject({
      status: 404,
    });
  });

  it('filters cycles by source', async () => {
    // Arrange
    const api = createFixtureApi();
    // Act
    const page = await api.listCycles!({ source: 'reconciler' });
    // Assert
    expect(page.items.length).toBeGreaterThan(0);
    expect(page.items.every(cycle => cycle.source === 'reconciler')).toBe(true);
  });

  it('discovers retained entities, kinds, and providers by prefix', async () => {
    // Arrange
    const api = createFixtureApi();
    // Act
    const entities = await all(cursor =>
      api.getEntities!({ prefix: 'ex', limit: 1, cursor }),
    );
    const kinds = await all(cursor => api.getKinds!({ limit: 1, cursor }));
    const providers = await api.getProviders!({ prefix: 'EX' });
    // Assert
    expect(entities.length).toBeGreaterThan(1);
    expect(entities.every(item => item.name.startsWith('ex'))).toBe(true);
    expect(kinds).toEqual(expect.arrayContaining(['Component', 'Group']));
    expect(providers.items).toContain('example-discovery');
  });

  it('includes deleted entities in discovery', async () => {
    // Arrange
    const api = createFixtureApi();
    // Act
    const page = await api.getEntities!({ prefix: 'retired' });
    // Assert
    expect(page.items.map(item => item.entityRef)).toEqual([
      'group:teams/retired-team',
    ]);
  });

  it('compares two recorded events of one entity', async () => {
    // Arrange
    const api = createFixtureApi();
    // Act
    const diff = await api.getEntityDiff!({
      entityRef: 'api:public/example-api',
      from: { kind: 'history-row', id: 'synthetic-api-insert' },
      to: { kind: 'history-row', id: 'synthetic-api-update' },
    });
    // Assert
    expect(diff.from?.id).toBe('synthetic-api-insert');
    expect(diff.to?.id).toBe('synthetic-api-update');
    expect(diff.changes.length).toBeGreaterThan(0);
    await expect(
      api.getEntityDiff!({
        entityRef: previewEntityRef,
        from: { kind: 'history-row', id: 'synthetic-api-insert' },
        to: { kind: 'history-row', id: 'synthetic-api-update' },
      }),
    ).rejects.toMatchObject({ status: 404 });
  });

  it('keeps deleted group prior state and API deltas in their own entity histories', async () => {
    // Arrange
    const api = createFixtureApi();
    // Act
    const deleted = await api.getEntityVersion({
      entityRef: 'group:teams/retired-team',
      id: 'synthetic-group-delete',
    });
    const updated = await api.getEntityVersion({
      entityRef: 'api:public/example-api',
      id: 'synthetic-api-update',
    });
    const first = await api.getEntityVersion({
      entityRef: 'component:sandbox/example-worker',
      id: 'synthetic-worker-insert',
    });
    const wrongEntity = api.getEntityVersion({
      entityRef: previewEntityRef,
      id: 'synthetic-group-delete',
    });
    // Assert
    expect(deleted).not.toHaveProperty('snapshot');
    expect(deleted.previousVersion).toMatchObject({
      id: 'synthetic-group-insert',
      snapshot: { entityRef: 'group:teams/retired-team' },
    });
    expect(updated.previousVersion).toMatchObject({
      id: 'synthetic-api-insert',
      entityRef: 'api:public/example-api',
    });
    expect(updated.changes).toEqual(crossEntityChanges['synthetic-api-update']);
    expect(first).not.toHaveProperty('previousVersion');
    expect(first).not.toHaveProperty('changes');
    await expect(wrongEntity).rejects.toMatchObject({ status: 404 });
  });
  it('reads the original A-B-A saved events by row ID rather than etag or latest', async () => {
    // Arrange
    const api = createFixtureApi();

    // Act
    const rows = await Promise.all(
      [3, 4, 5].map(day =>
        api.getEntityVersion({
          entityRef: previewEntityRef,
          id: `synthetic-event-${day}`,
        }),
      ),
    );
    const etagRead = api.getEntityVersion({
      entityRef: previewEntityRef,
      id: 'synthetic-a',
    });

    // Assert: repeated A snapshots retain different event identities and summaries.
    expect(rows.map(row => row.id)).toEqual([
      'synthetic-event-3',
      'synthetic-event-4',
      'synthetic-event-5',
    ]);
    expect(rows.map(row => row.etag)).toEqual([
      'synthetic-a',
      'synthetic-b',
      'synthetic-a',
    ]);
    expect(rows[0].snapshot).toEqual(rows[2].snapshot);
    expect(rows[0].summary).toEqual({});
    expect(rows[2].summary).toEqual({
      ownerChanged: true,
      relationsChanged: true,
      statusChanged: false,
    });
    await expect(etagRead).rejects.toMatchObject({ status: 404 });
  });

  it('returns static field evidence on both timeline pages without filling baseline or lifecycle gaps', async () => {
    // Arrange: explicit fixture expectations, not another snapshot diff engine.
    const api = createFixtureApi();

    // Act
    const first = await api.getEntityTimeline({ entityRef: previewEntityRef });
    const second = await api.getEntityTimeline({
      entityRef: previewEntityRef,
      cursor: first.nextCursor,
    });
    const current = await api.getEntityVersion({
      entityRef: previewEntityRef,
      id: 'synthetic-event-10',
    });

    // Assert: only the warning-bearing update has a positive status flag.
    expect(
      [...first.items, ...second.items].map(row => [row.id, row.summary]),
    ).toEqual([
      [
        'synthetic-event-10',
        { ownerChanged: true, relationsChanged: true, statusChanged: true },
      ],
      [
        'synthetic-event-9',
        { ownerChanged: true, relationsChanged: true, statusChanged: false },
      ],
      ['synthetic-event-8', {}],
      ['synthetic-event-7', {}],
      ['synthetic-event-6', {}],
      [
        'synthetic-event-5',
        { ownerChanged: true, relationsChanged: true, statusChanged: false },
      ],
      [
        'synthetic-event-4',
        { ownerChanged: true, relationsChanged: true, statusChanged: false },
      ],
      ['synthetic-event-3', {}],
      ['synthetic-event-2', {}],
      ['synthetic-event-1', {}],
    ]);
    expect(current.summary).toEqual(first.items[0].summary);
    expect(current.snapshot?.statusItems).toEqual([
      {
        type: 'backstage.io/catalog-processing',
        level: 'warning',
        message: 'Synthetic processing warning for preview only',
      },
    ]);
    expect(current.previousVersion?.summary).toEqual({});
  });

  it('returns a delete tombstone without inventing a snapshot', async () => {
    // Arrange
    const api = createFixtureApi();

    // Act
    const row = await api.getEntityVersion({
      entityRef: previewEntityRef,
      id: 'synthetic-event-7',
    });

    // Assert
    expect(row).toMatchObject({ id: 'synthetic-event-7', op: 'delete' });
    expect(row).not.toHaveProperty('snapshot');
    expect(row).not.toHaveProperty('etag');
  });

  it('clones nested detail data so callers cannot mutate fixtures or later reads', async () => {
    // Arrange
    const api = createFixtureApi();
    const request = { entityRef: previewEntityRef, id: 'synthetic-event-10' };
    const original = JSON.parse(JSON.stringify(previewRecords[0]));
    const detail = await api.getEntityVersion(request);
    const originalDetail = JSON.parse(JSON.stringify(detail));
    const originalChanges = JSON.parse(JSON.stringify(previewChanges));
    const originalPrevious = JSON.parse(JSON.stringify(previewRecords[4]));

    // Act: mutate each nested object/array exposed by a saved row.
    detail.summary.statusChanged = false;
    detail.snapshot!.metadata!.description = 'Changed by caller';
    detail.snapshot!.spec!.owner = 'group:default/changed';
    detail.snapshot!.relations![0].targetRef = 'group:default/changed';
    detail.snapshot!.statusItems![0].message = 'Changed by caller';
    detail.previousVersion!.snapshot!.spec!.owner = 'group:default/changed';
    detail.changes![0].path.push('changed');
    detail.changes![0].before = 'Changed by caller';
    const reread = await api.getEntityVersion(request);

    // Assert
    expect(detail).not.toEqual(original);
    expect(previewRecords[0]).toEqual(original);
    expect(previewRecords[4]).toEqual(originalPrevious);
    expect(previewChanges).toEqual(originalChanges);
    expect(reread).toEqual(originalDetail);
  });

  it('compares against the immediate prior event from the same source and provider', async () => {
    // Arrange
    const api = createFixtureApi();

    // Act
    const detail = await api.getEntityVersion({
      entityRef: previewEntityRef,
      id: 'synthetic-event-10',
    });

    // Assert: event 9 is newer than 6 but belongs to another capture stream.
    expect(detail.previousVersion).toEqual(previewRecords[4]);
    expect(detail.changes).toEqual(previewChanges['synthetic-event-10']);
    expect(detail.changes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: ['owner'],
          before: 'group:default/services',
          after: 'group:default/platform',
        }),
        expect.objectContaining({
          path: ['statusItems'],
          before: [],
          after: detail.snapshot!.statusItems,
        }),
      ]),
    );
  });

  it('keeps deletion context separate from the tombstone and does not compare after a deletion', async () => {
    // Arrange
    const api = createFixtureApi();

    // Act
    const deleted = await api.getEntityVersion({
      entityRef: previewEntityRef,
      id: 'synthetic-event-7',
    });
    const inserted = await api.getEntityVersion({
      entityRef: previewEntityRef,
      id: 'synthetic-event-8',
    });
    const first = await api.getEntityVersion({
      entityRef: previewEntityRef,
      id: 'synthetic-event-1',
    });

    // Assert: old clients still see the exact event's fields, not its predecessor's.
    expect(deleted).not.toHaveProperty('snapshot');
    expect(deleted.previousVersion).toEqual(previewRecords[5]);
    expect(deleted.previousVersion!.snapshot).toBeDefined();
    expect(inserted.snapshot).toEqual(previewRecords[2].snapshot);
    expect(inserted.previousVersion!.id).toBe('synthetic-event-7');
    expect(inserted).not.toHaveProperty('changes');
    expect(first).not.toHaveProperty('previousVersion');
    expect(first).not.toHaveProperty('changes');
  });
});
