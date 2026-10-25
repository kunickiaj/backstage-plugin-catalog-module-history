import { createFixtureApi } from './fixture-api';
import {
  crossEntityChanges,
  crossEntityRecords,
  previewChanges,
  previewEntityRef,
  previewRecords,
} from './fixtures';
import type { CatalogHistoryApi } from '../src';

describe('development fixture API', () => {
  it('pages every cross-entity event once, exposing identity but not snapshots', async () => {
    // Arrange
    const api = createFixtureApi() as Required<CatalogHistoryApi>;
    // Act
    const first = await api.getChangeFeed({ limit: 100 });
    const second = await api.getChangeFeed({
      limit: 100,
      cursor: first.nextCursor,
    });
    const third = await api.getChangeFeed({
      limit: 100,
      cursor: second.nextCursor,
    });
    const rows = [...first.items, ...second.items, ...third.items];
    // Assert
    expect(first.items).toHaveLength(5);
    expect(second.items).toHaveLength(5);
    expect(rows.map(row => row.id)).toEqual(
      crossEntityRecords.map(row => row.id),
    );
    expect(new Set(rows.map(row => row.id)).size).toBe(rows.length);
    expect(third.nextCursor).toBeUndefined();
    expect(rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          entityRef: 'group:teams/retired-team',
          kind: 'group',
          namespace: 'teams',
          name: 'retired-team',
          op: 'delete',
        }),
        expect.objectContaining({
          kind: 'api',
          namespace: 'public',
          name: 'example-api',
        }),
        expect.objectContaining({ kind: 'component', namespace: 'sandbox' }),
      ]),
    );
    expect(rows.every(row => !('snapshot' in row))).toBe(true);
  });

  it('matches exact normalized entities and case-insensitive kinds without matching prefixes', async () => {
    // Arrange
    const api = createFixtureApi() as Required<CatalogHistoryApi>;
    // Act
    const group = await api.getChangeFeed({
      entityRef: 'Group:Teams/Retired-Team',
      kind: ' gRoUp ',
      op: 'delete',
    });
    const short = await api.getChangeFeed({ entityRef: 'Example-Service' });
    const prefix = await api.getChangeFeed({
      entityRef: 'group:teams/retired',
    });
    const wrongKind = await api.getChangeFeed({
      entityRef: 'group:teams/retired-team',
      kind: 'Component',
    });
    // Assert
    expect(group.items.map(row => row.id)).toEqual(['synthetic-group-delete']);
    expect(short.items.map(row => row.id)).toEqual(
      previewRecords.slice(0, 5).map(row => row.id),
    );
    expect(prefix.items).toEqual([]);
    expect(wrongKind.items).toEqual([]);
  });

  it('combines feed capture filters and inclusive dates without matching unrelated streams', async () => {
    // Arrange
    const api = createFixtureApi() as Required<CatalogHistoryApi>;
    const request = {
      source: 'provider' as const,
      provider: 'example-discovery',
      kind: 'API',
      op: 'update' as const,
      changedAfter: '2026-10-14T14:00:00.000Z',
      changedBefore: '2026-10-14T14:00:00.000Z',
    };
    // Act
    const matching = await api.getChangeFeed(request);
    const excluded = await api.getChangeFeed({
      ...request,
      provider: 'example',
    });
    const outside = await api.getChangeFeed({
      ...request,
      changedAfter: '2026-10-14T14:00:00.001Z',
    });
    // Assert
    expect(matching.items.map(row => row.id)).toEqual(['synthetic-api-update']);
    expect(excluded.items).toEqual([]);
    expect(outside.items).toEqual([]);
  });

  it.each([0, -1, 1.5, Number.NaN])(
    'rejects invalid global limit %s',
    async limit => {
      // Arrange
      const api = createFixtureApi() as Required<CatalogHistoryApi>;
      // Act
      const result = api.getChangeFeed({ limit });
      // Assert
      await expect(result).rejects.toMatchObject({ status: 400 });
    },
  );

  it('accepts a global one-row page but rejects unknown and differently filtered cursors', async () => {
    // Arrange
    const api = createFixtureApi() as Required<CatalogHistoryApi>;
    // Act
    const page = await api.getChangeFeed({ limit: 1 });
    const unknown = api.getChangeFeed({ cursor: 'unknown' });
    const incompatible = api.getChangeFeed({
      kind: 'API',
      cursor: page.nextCursor,
    });
    // Assert
    expect(page.items.map(row => row.id)).toEqual(['synthetic-group-delete']);
    await expect(unknown).rejects.toMatchObject({ status: 400 });
    await expect(incompatible).rejects.toMatchObject({ status: 400 });
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
  it('pages all ten events newest first with a five-row cap and opaque cursors', async () => {
    // Arrange: use the returned cursor unchanged, without interpreting its format.
    const api = createFixtureApi();

    // Act
    const first = await api.getEntityTimeline({ entityRef: previewEntityRef });
    const oversized = await api.getEntityTimeline({
      entityRef: previewEntityRef,
      limit: 100,
    });
    const second = await api.getEntityTimeline({
      entityRef: previewEntityRef,
      limit: 100,
      cursor: first.nextCursor,
    });

    // Assert: no duplicates, skipped rows, snapshots, or extra terminal cursor.
    expect(first.items).toHaveLength(5);
    expect(oversized).toEqual(first);
    expect(first.nextCursor).toEqual(expect.any(String));
    expect(second.items).toHaveLength(5);
    expect([...first.items, ...second.items].map(row => row.id)).toEqual(
      [10, 9, 8, 7, 6, 5, 4, 3, 2, 1].map(day => `synthetic-event-${day}`),
    );
    expect([...first.items, ...second.items]).toEqual(
      expect.arrayContaining(
        previewRecords.map(({ snapshot: _snapshot, ...row }) => row),
      ),
    );
    expect(second.nextCursor).toBeUndefined();
  });

  it.each([
    {
      filter: { source: 'processing' as const },
      excludedProvider: 'example-discovery',
      days: [9, 2],
    },
    {
      filter: { provider: 'example-bootstrap' },
      excludedProvider: 'example',
      days: [1],
    },
    {
      filter: { op: 'delete' as const },
      excludedProvider: 'example-bootstrap',
      days: [7],
    },
  ])(
    'applies the exact filter $filter',
    async ({ filter, excludedProvider, days }) => {
      // Arrange
      const api = createFixtureApi();

      // Act
      const matching = await api.getEntityTimeline({
        entityRef: previewEntityRef,
        ...filter,
      });
      const nonmatching = await api.getEntityTimeline({
        entityRef: previewEntityRef,
        ...filter,
        provider: excludedProvider,
      });

      // Assert: filters exclude unrelated rows, and provider prefixes do not match.
      expect(matching.items.map(row => row.id)).toEqual(
        days.map(day => `synthetic-event-${day}`),
      );
      expect(nonmatching).toEqual({ items: [], nextCursor: undefined });
    },
  );

  it('combines filters and includes both timestamp boundaries', async () => {
    // Arrange
    const api = createFixtureApi();
    const request = {
      entityRef: previewEntityRef,
      source: 'provider' as const,
      provider: 'example-discovery',
      op: 'update' as const,
      changedAfter: '2026-10-03T12:00:00.000Z',
      changedBefore: '2026-10-05T12:00:00.000Z',
    };

    // Act
    const interval = await api.getEntityTimeline(request);
    const instant = await api.getEntityTimeline({
      ...request,
      changedBefore: request.changedAfter,
    });
    const empty = await api.getEntityTimeline({
      ...request,
      changedAfter: '2026-10-05T12:00:00.001Z',
    });

    // Assert
    expect(interval.items.map(row => row.id)).toEqual([
      'synthetic-event-5',
      'synthetic-event-4',
      'synthetic-event-3',
    ]);
    expect(instant.items.map(row => row.id)).toEqual(['synthetic-event-3']);
    expect(empty).toEqual({ items: [], nextCursor: undefined });
  });

  it('returns an empty timeline and rejects exact reads for another entity', async () => {
    // Arrange
    const api = createFixtureApi();
    const entityRef = 'component:default/not-the-preview';

    // Act
    const timeline = await api.getEntityTimeline({ entityRef });
    const detail = api.getEntityVersion({ entityRef, id: 'synthetic-event-3' });

    // Assert
    expect(timeline).toEqual({ items: [], nextCursor: undefined });
    await expect(detail).rejects.toMatchObject({ status: 404 });
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

  it.each([0, -1, 1.5, Number.NaN])('rejects invalid limit %s', async limit => {
    // Arrange
    const api = createFixtureApi();

    // Act
    const result = api.getEntityTimeline({
      entityRef: previewEntityRef,
      limit,
    });

    // Assert
    await expect(result).rejects.toMatchObject({ status: 400 });
  });

  it('accepts a one-row page but rejects an unknown cursor', async () => {
    // Arrange
    const api = createFixtureApi();

    // Act
    const page = await api.getEntityTimeline({
      entityRef: previewEntityRef,
      limit: 1,
    });
    const invalid = api.getEntityTimeline({
      entityRef: previewEntityRef,
      cursor: 'not-a-fixture-cursor',
    });

    // Assert
    expect(page.items.map(row => row.id)).toEqual(['synthetic-event-10']);
    await expect(invalid).rejects.toMatchObject({ status: 400 });
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
