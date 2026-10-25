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
  describe('entity and kind discovery', () => {
    it('reads all retained identities rather than the five loaded events and returns only identity fields', async () => {
      // Arrange: finite ASCII fixtures do not model database locale ordering.
      const api = createFixtureApi();
      // Act
      const feed = await api.getChangeFeed!({});
      const entities = await api.getEntities!({});
      const oversized = await api.getEntities!({ limit: 101 });
      const kinds = await api.getKinds!({});
      // Assert
      expect(feed.items).toHaveLength(5);
      expect(feed.items.map(row => row.entityRef)).not.toContain(
        previewEntityRef,
      );
      expect(entities).toEqual({
        items: [
          {
            entityRef: 'api:public/example-api',
            kind: 'API',
            namespace: 'public',
            name: 'example-api',
          },
          {
            entityRef: previewEntityRef,
            kind: 'Component',
            namespace: 'default',
            name: 'example-service',
          },
          {
            entityRef: 'component:sandbox/example-worker',
            kind: 'Component',
            namespace: 'sandbox',
            name: 'example-worker',
          },
          {
            entityRef: 'group:teams/retired-team',
            kind: 'group',
            namespace: 'teams',
            name: 'retired-team',
          },
        ],
        nextCursor: undefined,
      });
      expect(oversized).toEqual(entities);
      expect(kinds).toEqual({
        items: ['API', 'Component', 'Group'],
        nextCursor: undefined,
      });
      expect(await api.getKinds!({ limit: 101 })).toEqual(kinds);
      expect(await api.getChangeFeed!({})).toEqual(feed);
    });

    it('matches literal case-insensitive NAME prefixes and never reference substrings', async () => {
      // Arrange
      const api = createFixtureApi();
      // Act
      const entities = await api.getEntities!({ prefix: 'EXAMPLE-' });
      const kinds = await api.getKinds!({ prefix: 'gR' });
      // Assert
      expect(entities.items.map(item => item.name)).toEqual([
        'example-api',
        'example-service',
        'example-worker',
      ]);
      expect(kinds.items).toEqual(['Group']);
      expect(await api.getEntities!({ prefix: 'component:default/' })).toEqual({
        items: [],
        nextCursor: undefined,
      });
    });

    it.each(['%', '_', '\\', ' example', 'EXAMPLE ', 'service'])(
      'does not trim or wildcard entity/kind prefix %j',
      async prefix => {
        // Arrange
        const api = createFixtureApi();
        // Act
        const entities = await api.getEntities!({ prefix });
        const kinds = await api.getKinds!({ prefix });
        // Assert
        expect(entities).toEqual({ items: [], nextCursor: undefined });
        expect(kinds).toEqual({ items: [], nextCursor: undefined });
      },
    );

    it.each([
      {
        context: { source: 'processing' as const },
        names: ['example-service'],
      },
      {
        context: {
          kind: ' aPi ',
          source: 'provider' as const,
          provider: 'example-discovery',
          op: 'update' as const,
          changedAfter: '2026-10-14T14:00:00.000Z',
          changedBefore: '2026-10-14T14:00:00.000Z',
        },
        names: ['example-api'],
      },
      {
        context: { provider: 'example-bootstrap', op: 'insert' as const },
        names: ['example-service'],
      },
      {
        context: { op: 'delete' as const },
        names: ['example-service', 'retired-team'],
      },
    ])(
      'filters retained observations before deduplicating identities: $context',
      async ({ context, names }) => {
        // Arrange
        const api = createFixtureApi();
        // Act
        const matching = await api.getEntities!(context);
        const excluded = await api.getEntities!({
          ...context,
          provider: 'example',
        });
        // Assert
        expect(matching.items.map(item => item.name)).toEqual(names);
        expect(excluded.items).toEqual([]);
      },
    );

    it('uses the latest matching snapshot or parsed deletion identity, not an unrelated later row', async () => {
      // Arrange
      const api = createFixtureApi();
      // Act
      const inserted = await api.getEntities!({
        prefix: 'retired',
        op: 'insert',
      });
      const deleted = await api.getEntities!({
        prefix: 'retired',
        op: 'delete',
      });
      const outside = await api.getEntities!({
        prefix: 'retired',
        changedAfter: '2026-10-15T14:00:00.001Z',
      });
      // Assert
      expect(inserted.items).toEqual([
        {
          entityRef: 'group:teams/retired-team',
          kind: 'Group',
          namespace: 'teams',
          name: 'retired-team',
        },
      ]);
      expect(deleted.items).toEqual([
        {
          entityRef: 'group:teams/retired-team',
          kind: 'group',
          namespace: 'teams',
          name: 'retired-team',
        },
      ]);
      expect(outside.items).toEqual([]);
    });

    it('keeps kind discovery global even when unsupported history context is supplied at runtime', async () => {
      // Arrange
      const api = createFixtureApi();
      const context = {
        prefix: '',
        entityRef: 'component:default/missing',
        kind: 'Missing',
        provider: 'missing',
        source: 'processing',
        op: 'delete',
        changedAfter: '2099-01-01T00:00:00.000Z',
      };
      // Act
      const result = await api.getKinds!(context);
      // Assert
      expect(result.items).toEqual(['API', 'Component', 'Group']);
      expect((await api.getKinds!({ prefix: 'missing' })).items).toEqual([]);
    });

    it.each(['getEntities', 'getKinds'] as const)(
      'pages %s with opaque cursors, allowing a changed page size',
      async method => {
        // Arrange
        const api = createFixtureApi();
        // Act
        const all = await api[method]!({});
        const first = await api[method]!({ limit: 1 });
        const second = await api[method]!({
          limit: 1,
          cursor: first.nextCursor,
        });
        const rest = await api[method]!({
          limit: 100,
          cursor: second.nextCursor,
        });
        // Assert
        expect(first.items).toHaveLength(1);
        expect(first.nextCursor).toEqual(expect.any(String));
        expect(second.items).toHaveLength(1);
        expect(second.nextCursor).toEqual(expect.any(String));
        expect([...first.items, ...second.items, ...rest.items]).toEqual(
          all.items,
        );
        expect(rest.nextCursor).toBeUndefined();
      },
    );

    it.each([
      { prefix: 'example' },
      { kind: 'Component' },
      { source: 'provider' as const },
      { provider: 'example-discovery' },
      { op: 'insert' as const },
      { changedAfter: '2026-10-01T00:00:00.000Z' },
      { changedBefore: '2026-10-20T00:00:00.000Z' },
    ])(
      'rejects an entity cursor after changing context $context',
      async context => {
        // Arrange
        const api = createFixtureApi();
        const first = await api.getEntities!({ limit: 1 });
        // Act
        const result = api.getEntities!({
          ...context,
          cursor: first.nextCursor,
        });
        // Assert
        await expect(result).rejects.toMatchObject({ status: 400 });
      },
    );

    it.each(['getEntities', 'getKinds'] as const)(
      'rejects invalid limits and non-string prefixes for %s',
      async method => {
        // Arrange
        const api = createFixtureApi();
        // Act / Assert: await each rejection before creating another request.
        for (const limit of [0, -1, 1.5, Number.NaN]) {
          await expect(api[method]!({ limit })).rejects.toMatchObject({
            status: 400,
          });
        }
        await expect(
          api[method]!({ prefix: 42 as unknown as string }),
        ).rejects.toMatchObject({ status: 400 });
        await expect(api[method]!({ cursor: 'unknown' })).rejects.toMatchObject(
          { status: 400 },
        );
      },
    );

    it('rejects kind cursors with another prefix and all cross-route discovery/event cursor reuse', async () => {
      // Arrange
      const api = createFixtureApi();
      const entities = await api.getEntities!({ limit: 1 });
      const kinds = await api.getKinds!({ limit: 1 });
      const providers = await api.getProviders!({ limit: 1 });
      const events = await api.getChangeFeed!({ limit: 1 });
      // Act / Assert
      await expect(
        api.getKinds!({ prefix: 'c', cursor: kinds.nextCursor }),
      ).rejects.toMatchObject({ status: 400 });
      for (const cursor of [
        providers.nextCursor,
        events.nextCursor,
        kinds.nextCursor,
      ]) {
        await expect(api.getEntities!({ cursor })).rejects.toMatchObject({
          status: 400,
        });
      }
      for (const cursor of [
        providers.nextCursor,
        events.nextCursor,
        entities.nextCursor,
      ]) {
        await expect(api.getKinds!({ cursor })).rejects.toMatchObject({
          status: 400,
        });
      }
      for (const cursor of [entities.nextCursor, kinds.nextCursor]) {
        await expect(api.getProviders!({ cursor })).rejects.toMatchObject({
          status: 400,
        });
        await expect(api.getChangeFeed!({ cursor })).rejects.toMatchObject({
          status: 400,
        });
      }
    });
  });

  describe('provider discovery', () => {
    it('discovers retained names outside the first event page without changing event pagination', async () => {
      // Arrange: these static ASCII names are not a database collation oracle.
      const api = createFixtureApi();
      // Act
      const first = await api.getChangeFeed!({});
      const providers = await api.getProviders!({ prefix: 'EXAMPLE' });
      const all = await api.getProviders!({});
      const oversized = await api.getProviders!({ limit: 101 });
      // Assert
      expect(first.items).toHaveLength(5);
      expect(first.items.map(row => row.provider)).not.toContain(
        'example-bootstrap',
      );
      expect(providers.items).toEqual([
        'example-bootstrap',
        'example-discovery',
      ]);
      expect(all).toEqual({
        items: [
          'example-bootstrap',
          'example-discovery',
          'processing',
          'reconciler',
        ],
        nextCursor: undefined,
      });
      expect(oversized).toEqual(all);
      expect(await api.getChangeFeed!({})).toEqual(first);
    });

    it.each([
      { context: { source: 'processing' as const }, names: ['processing'] },
      {
        context: {
          entityRef: 'Example-Service',
          kind: 'Component',
          op: 'insert' as const,
        },
        names: ['example-bootstrap', 'example-discovery'],
      },
      {
        context: {
          entityRef: 'Group:Teams/Retired-Team',
          kind: ' gRoUp ',
          op: 'delete' as const,
        },
        names: ['example-discovery'],
      },
      {
        context: {
          kind: 'API',
          changedAfter: '2026-10-14T14:00:00.000Z',
          changedBefore: '2026-10-14T14:00:00.000Z',
        },
        names: ['example-discovery'],
      },
    ])(
      'scopes retained names before deduplication: $context',
      async ({ context, names }) => {
        // Arrange
        const api = createFixtureApi();
        // Act
        const matching = await api.getProviders!(context);
        const excluded = await api.getProviders!({
          ...context,
          prefix: 'no-such-provider',
        });
        // Assert
        expect(matching.items).toEqual(names);
        expect(excluded.items).toEqual([]);
      },
    );

    it.each(['%', '_', '\\', ' example', 'discovery', 'EXAMPLE '])(
      'treats prefix %j literally without trimming or substring matching',
      async prefix => {
        // Arrange
        const api = createFixtureApi();
        // Act
        const result = await api.getProviders!({ prefix });
        // Assert
        expect(result).toEqual({ items: [], nextCursor: undefined });
      },
    );

    it.each([0, -1, 1.5, Number.NaN])(
      'rejects invalid provider limit %s',
      async limit => {
        // Arrange
        const api = createFixtureApi();
        // Act
        const result = api.getProviders!({ limit });
        // Assert
        await expect(result).rejects.toMatchObject({ status: 400 });
      },
    );

    it('pages distinct names with an opaque cursor and permits a new page size', async () => {
      // Arrange
      const api = createFixtureApi();
      // Act
      const first = await api.getProviders!({ limit: 1 });
      const second = await api.getProviders!({
        limit: 1,
        cursor: first.nextCursor,
      });
      const rest = await api.getProviders!({
        limit: 100,
        cursor: second.nextCursor,
      });
      // Assert
      expect(first.items).toEqual(['example-bootstrap']);
      expect(first.nextCursor).toEqual(expect.any(String));
      expect(second.items).toEqual(['example-discovery']);
      expect(rest).toEqual({
        items: ['processing', 'reconciler'],
        nextCursor: undefined,
      });
    });

    it.each([
      { prefix: 'example' },
      { source: 'provider' as const },
      { entityRef: previewEntityRef },
      { kind: 'Component' },
      { op: 'insert' as const },
      { changedAfter: '2026-10-01T00:00:00.000Z' },
      { changedBefore: '2026-10-20T00:00:00.000Z' },
    ])(
      'rejects reuse of a provider cursor with changed context $context',
      async context => {
        // Arrange
        const api = createFixtureApi();
        const first = await api.getProviders!({ limit: 1 });
        // Act
        const result = api.getProviders!({
          ...context,
          cursor: first.nextCursor,
        });
        // Assert
        await expect(result).rejects.toMatchObject({ status: 400 });
      },
    );

    it('rejects event cursors for provider discovery and provider cursors for event reads', async () => {
      // Arrange
      const api = createFixtureApi();
      const events = await api.getChangeFeed!({ limit: 1 });
      const providers = await api.getProviders!({ limit: 1 });
      // Act / Assert: attach rejection handlers before starting the next read.
      await expect(
        api.getProviders!({ cursor: events.nextCursor }),
      ).rejects.toMatchObject({ status: 400 });
      await expect(
        api.getChangeFeed!({ cursor: providers.nextCursor }),
      ).rejects.toMatchObject({ status: 400 });
      await expect(
        api.getProviders!({ cursor: 'unknown' }),
      ).rejects.toMatchObject({ status: 400 });
    });
  });

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
