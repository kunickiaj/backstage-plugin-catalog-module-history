import { createFixtureApi } from './fixture-api';
import { previewChanges, previewEntityRef, previewRecords } from './fixtures';

describe('development fixture API', () => {
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
    expect(rows[2].summary).toEqual({ ownerChanged: true });
    await expect(etagRead).rejects.toMatchObject({ status: 404 });
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
