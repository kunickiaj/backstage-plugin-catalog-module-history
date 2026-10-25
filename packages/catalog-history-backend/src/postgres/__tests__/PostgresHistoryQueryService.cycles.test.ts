import { Buffer } from 'node:buffer';
import { randomUUID } from 'node:crypto';
import { TestDatabases } from '@backstage/backend-test-utils';
import { InputError, NotFoundError } from '@backstage/errors';
import type { HistoryCycleListRequest } from '@kunickiaj/backstage-plugin-catalog-history-common';
import type {
  CycleInput,
  EntityRow,
} from '@kunickiaj/backstage-plugin-catalog-history-node';
import type { Knex } from 'knex';
import { PostgresHistoryStore } from '../PostgresHistoryStore';
import { metricsJournal } from './metricsJournal';

jest.setTimeout(30000);
const at = '2026-10-25T00:00:00.000Z';
const nil = '00000000-0000-0000-0000-000000000000';

function entity(name: string): EntityRow {
  return {
    entityRef: `component:default/${name}`,
    kind: 'Component',
    namespace: 'default',
    name,
    etag: `etag-${name}`,
    metadata: { name, description: 'private-snapshot' },
    spec: { private: 'snapshot' },
  };
}

function cycle(options: Partial<CycleInput> = {}): CycleInput {
  return {
    cycleId: randomUUID(),
    provider: 'fixture',
    source: 'provider',
    mutationType: 'delta',
    startedAt: new Date(at),
    finishedAt: new Date(at),
    inserts: [],
    updates: [],
    deletes: [],
    unchangedCount: 0,
    ...options,
  };
}

function encode(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function payload(cursor: string | undefined): Record<string, unknown> {
  expect(cursor).toEqual(expect.any(String));
  return JSON.parse(Buffer.from(cursor!, 'base64url').toString('utf8'));
}

describe('PostgresHistoryQueryService cycle ledger reads', () => {
  const databases = TestDatabases.create({ ids: ['POSTGRES_16'] });
  let db: Knex;
  let store: PostgresHistoryStore;

  beforeEach(async () => {
    db = await databases.init('POSTGRES_16');
    store = new PostgresHistoryStore(db);
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await db?.destroy();
  });

  it('initializes empty reads and includes full heartbeat cycles without entity observations', async () => {
    // Arrange: exercise the public writer, including a zero-observation heartbeat.
    const empty = await store.query.listCycles({});
    const heartbeat = cycle({ mutationType: 'full', unchangedCount: 500 });
    await store.recordCycle(heartbeat);

    // Act
    const list = await store.query.listCycles({});
    const detail = await store.query.getCycle({ cycleId: heartbeat.cycleId });
    const inserts = await store.query.listCycles({ op: 'insert' });

    // Assert: ledger counts do not depend on retained entity rows.
    expect(empty).toEqual({ items: [], nextCursor: undefined });
    expect(list.items).toEqual([
      {
        cycleId: heartbeat.cycleId,
        provider: 'fixture',
        source: 'provider',
        mutationType: 'full',
        startedAt: at,
        finishedAt: at,
        counts: { inserted: 0, updated: 0, deleted: 0, unchanged: 500 },
      },
    ]);
    expect(detail).toEqual({
      cycle: list.items[0],
      changes: { items: [], nextCursor: undefined },
    });
    expect(inserts.items).toEqual([]);
  });

  it('filters actual source, exact provider, mutation shape, and retained operations together', async () => {
    // Arrange: the same provider name spans every capture layer.
    const inputs = [
      cycle({ source: 'provider', inserts: [entity('p')] }),
      cycle({ source: 'processing', updates: [entity('q')] }),
      cycle({ source: 'reconciler', deletes: ['component:default/deleted'] }),
      cycle({ provider: ' Fixture ', inserts: [entity('spaces')] }),
      cycle({ provider: 'Fixture', inserts: [entity('case')] }),
      cycle({ mutationType: 'full', inserts: [entity('full')] }),
    ];
    for (const input of inputs) await store.recordCycle(input);

    // Act
    const results = await Promise.all(
      inputs.map(input => {
        let op: 'insert' | 'update' | 'delete' = 'insert';
        if (input.updates.length) op = 'update';
        if (input.deletes.length) op = 'delete';
        return store.query.listCycles({
          source: input.source,
          provider: input.provider,
          mutationType: input.mutationType,
          op,
        });
      }),
    );
    const mismatch = await store.query.listCycles({
      source: 'processing',
      op: 'delete',
    });
    const absent = await store.query.listCycles({ provider: ' fixture ' });

    // Assert
    expect(
      results.map(result => result.items.map(item => item.cycleId)),
    ).toEqual(inputs.map(input => [input.cycleId]));
    expect(mismatch.items).toEqual([]);
    expect(absent.items).toEqual([]);
  });

  it('uses separate inclusive start and finish ranges, not finish ordering', async () => {
    // Arrange: finish order deliberately differs from start order.
    const inputs = [
      cycle({
        startedAt: new Date('2026-10-25T00:00:01Z'),
        finishedAt: new Date('2026-10-25T00:00:09Z'),
      }),
      cycle({
        startedAt: new Date('2026-10-25T00:00:02Z'),
        finishedAt: new Date('2026-10-25T00:00:08Z'),
      }),
      cycle({
        startedAt: new Date('2026-10-25T00:00:03Z'),
        finishedAt: new Date('2026-10-25T00:00:07Z'),
      }),
    ];
    for (const input of inputs) await store.recordCycle(input);

    // Act
    const selected = await store.query.listCycles({
      startedAfter: inputs[0].startedAt.toISOString(),
      startedBefore: inputs[1].startedAt.toISOString(),
      finishedAfter: inputs[1].finishedAt.toISOString(),
      finishedBefore: inputs[0].finishedAt.toISOString(),
    });
    const missing = await store.query.listCycles({ finishedBefore: at });

    // Assert
    expect(selected.items.map(item => item.cycleId)).toEqual([
      inputs[1].cycleId,
      inputs[0].cycleId,
    ]);
    expect(missing.items).toEqual([]);
  });

  it('paginates headers by descending native UUID ties, defaults to 25, caps at 100, and changes page size', async () => {
    // Arrange: explicit UUIDs avoid accidental agreement with insertion order.
    const ids = Array.from(
      { length: 105 },
      (_, index) =>
        `00000000-0000-0000-0000-${String(index + 1).padStart(12, '0')}`,
    );
    for (const cycleId of ids) await store.recordCycle(cycle({ cycleId }));

    // Act
    const defaults = await store.query.listCycles({});
    const first = await store.query.listCycles({ limit: 1 });
    const rest = await store.query.listCycles({
      cursor: first.nextCursor,
      limit: 1000,
    });
    const tail = await store.query.listCycles({
      cursor: rest.nextCursor,
      limit: 9,
    });

    // Assert
    expect(defaults.items).toHaveLength(25);
    expect(rest.items).toHaveLength(100);
    expect(
      [...first.items, ...rest.items, ...tail.items].map(item => item.cycleId),
    ).toEqual([...ids].reverse());
    expect(tail.items).toHaveLength(4);
    expect(tail.nextCursor).toBeUndefined();
  });

  it('preserves native microseconds in header anchors and filter contexts', async () => {
    // Arrange: every timestamp rounds to the same JavaScript millisecond.
    const inputs = [cycle(), cycle(), cycle()];
    for (const [index, input] of inputs.entries()) {
      await store.recordCycle(input);
      await db('catalog_history_cycles')
        .where('cycle_id', input.cycleId)
        .update({
          started_at: `2026-10-25T00:00:00.00000${index + 1}Z`,
          finished_at: `2026-10-25T00:00:01.00000${index + 1}Z`,
        });
    }
    const filters = {
      startedAfter: '2026-10-25T00:00:00.000002Z',
      finishedBefore: '2026-10-25T00:00:01.000003Z',
    };

    // Act
    const first = await store.query.listCycles({ ...filters, limit: 1 });
    const second = await store.query.listCycles({
      ...filters,
      cursor: first.nextCursor,
    });

    // Assert
    expect(payload(first.nextCursor).timestamp).toContain('.000003');
    expect([...first.items, ...second.items].map(item => item.cycleId)).toEqual(
      [inputs[2].cycleId, inputs[1].cycleId],
    );
    expect(second.nextCursor).toBeUndefined();
    await expect(
      store.query.listCycles({
        ...filters,
        startedAfter: '2026-10-25T00:00:00.000001Z',
        cursor: first.nextCursor,
      }),
    ).rejects.toBeInstanceOf(InputError);
  });

  it('keeps ledger counts after partial and total removal of retained rows while op filters use EXISTS', async () => {
    // Arrange: deleting owned fixture rows simulates retention, not a purge API.
    const input = cycle({
      inserts: [entity('one'), entity('two')],
      unchangedCount: 7,
    });
    await store.recordCycle(input);
    await db('catalog_history_entities')
      .where({ cycle_id: input.cycleId, name: 'two' })
      .delete();

    // Act
    const partial = await store.query.getCycle({ cycleId: input.cycleId });
    const retained = await store.query.listCycles({ op: 'insert' });
    await db('catalog_history_entities')
      .where('cycle_id', input.cycleId)
      .delete();
    const removed = await store.query.getCycle({ cycleId: input.cycleId });
    const headers = await store.query.listCycles({});
    const filtered = await store.query.listCycles({ op: 'insert' });

    // Assert
    expect(partial.cycle.counts).toEqual({
      inserted: 2,
      updated: 0,
      deleted: 0,
      unchanged: 7,
    });
    expect(partial.changes.items).toHaveLength(1);
    expect(retained.items.map(item => item.cycleId)).toEqual([input.cycleId]);
    expect(removed.cycle).toEqual(partial.cycle);
    expect(removed.changes).toEqual({ items: [], nextCursor: undefined });
    expect(headers.items).toEqual([partial.cycle]);
    expect(filtered.items).toEqual([]);
  });

  it('pages only the requested cycle, preserving stored identity and change fields without snapshots', async () => {
    // Arrange: row fields intentionally differ from both the header and ref spelling.
    const input = cycle({
      inserts: Array.from({ length: 27 }, (_, n) => entity(`item-${n}`)),
      updates: [entity('updated')],
      deletes: ['component:default/deleted'],
      unchangedCount: 500,
    });
    await store.recordCycle(input);
    await store.recordCycle(
      cycle({
        inserts: [entity('unrelated')],
        finishedAt: new Date('2026-10-26T00:00:00Z'),
      }),
    );
    await db('catalog_history_entities')
      .where('cycle_id', input.cycleId)
      .update({
        source: 'processing',
        provider: ' row provider ',
        kind: 'StoredKind',
        namespace: 'StoredNamespace',
        name: 'StoredName',
      });

    // Act
    const defaults = await store.query.getCycle({ cycleId: input.cycleId });
    const first = await store.query.getCycle({
      cycleId: input.cycleId.toUpperCase(),
      limit: 1,
    });
    const rest = await store.query.getCycle({
      cycleId: input.cycleId,
      cursor: first.changes.nextCursor,
      limit: 100,
    });

    // Assert
    expect(defaults.changes.items).toHaveLength(25);
    expect(first.cycle).toEqual(rest.cycle);
    expect(first.cycle).toMatchObject({
      source: 'provider',
      provider: 'fixture',
      counts: { inserted: 27, updated: 1, deleted: 1, unchanged: 500 },
    });
    const items = [...first.changes.items, ...rest.changes.items];
    expect(items).toHaveLength(29);
    expect(new Set(items.map(item => item.id)).size).toBe(29);
    expect(items.map(item => item.op)).toEqual([
      'delete',
      'update',
      ...Array(27).fill('insert'),
    ]);
    for (const item of items) {
      expect(item).toMatchObject({
        cycleId: input.cycleId,
        source: 'processing',
        provider: ' row provider ',
        kind: 'StoredKind',
        namespace: 'StoredNamespace',
        name: 'StoredName',
        summary: {},
      });
      expect(item).not.toHaveProperty('snapshot');
      expect(item).not.toHaveProperty('metadata');
    }
    expect(items[1].etag).toBe('etag-updated');
    expect(items[1].entityRef).toBe('component:default/updated');
    expect(rest.changes.nextCursor).toBeUndefined();
  });

  it('caps detail pages at 100 and returns a final tail without duplicates', async () => {
    // Arrange
    const input = cycle({
      inserts: Array.from({ length: 105 }, (_, index) =>
        entity(`large-${index}`),
      ),
    });
    await store.recordCycle(input);

    // Act
    const first = await store.query.getCycle({
      cycleId: input.cycleId,
      limit: 1000,
    });
    const tail = await store.query.getCycle({
      cycleId: input.cycleId,
      limit: 100,
      cursor: first.changes.nextCursor,
    });

    // Assert
    expect(first.changes.items).toHaveLength(100);
    expect(tail.changes.items).toHaveLength(5);
    expect(
      new Set(
        [...first.changes.items, ...tail.changes.items].map(item => item.id),
      ).size,
    ).toBe(105);
    expect(tail.changes.nextCursor).toBeUndefined();
    expect(tail.cycle.counts.inserted).toBe(105);
    expect(first.cycle).toEqual(tail.cycle);
  });

  it('keeps microsecond change ordering and unsafe bigint IDs lossless through cursor and JSON', async () => {
    // Arrange: reversed IDs distinguish timestamp order from ID order.
    const input = cycle({ inserts: [entity('a'), entity('b'), entity('c')] });
    await store.recordCycle(input);
    const ids = ['9007199254740995', '9007199254740994', '9007199254740993'];
    for (const [index, name] of ['a', 'b', 'c'].entries()) {
      await db('catalog_history_entities')
        .where({ cycle_id: input.cycleId, name })
        .update({
          id: ids[index],
          changed_at:
            index === 0
              ? '2026-10-25T00:00:00.000001Z'
              : '2026-10-25T00:00:00.000002Z',
        });
    }

    // Act
    const first = await store.query.getCycle({
      cycleId: input.cycleId,
      limit: 1,
    });
    const second = await store.query.getCycle({
      cycleId: input.cycleId.toUpperCase(),
      limit: 1,
      cursor: first.changes.nextCursor,
    });
    const third = await store.query.getCycle({
      cycleId: input.cycleId,
      cursor: second.changes.nextCursor,
    });

    // Assert
    expect(payload(first.changes.nextCursor)).toMatchObject({
      id: ids[1],
      timestamp: expect.stringContaining('.000002'),
    });
    const items = [
      ...first.changes.items,
      ...second.changes.items,
      ...third.changes.items,
    ];
    expect(items.map(item => item.id)).toEqual([ids[1], ids[2], ids[0]]);
    expect(
      JSON.parse(JSON.stringify(items)).map((item: { id: string }) => item.id),
    ).toEqual([ids[1], ids[2], ids[0]]);
    expect(third.changes.nextCursor).toBeUndefined();
  });

  it.each([
    '',
    ' ',
    '../cycles',
    'not-a-uuid',
    '00000000-0000-0000-0000-00000000000',
    null,
    12,
    undefined,
  ])('rejects invalid detail ID %p before SQL', async cycleId => {
    // Arrange
    await store.ensureReady();
    const listener = jest.fn();
    db.on('query', listener);
    try {
      // Act / Assert: invalid runtime input must not reach a UUID cast.
      await expect(
        store.query.getCycle({ cycleId: cycleId as string }),
      ).rejects.toBeInstanceOf(InputError);
      expect(listener).not.toHaveBeenCalled();
    } finally {
      db.removeListener('query', listener);
    }
  });

  it.each([nil, 'abcdefab-cdef-0000-0000-abcdefabcdef'])(
    'accepts PostgreSQL UUID shape %s and reports a valid missing ID as NotFound',
    async cycleId => {
      // Arrange
      await store.recordCycle(cycle({ cycleId }));

      // Act
      const detail = await store.query.getCycle({
        cycleId: cycleId.toUpperCase(),
      });

      // Assert
      expect(detail.cycle.cycleId).toBe(cycleId);
      await expect(
        store.query.getCycle({
          cycleId: 'ffffffff-ffff-ffff-ffff-ffffffffffff',
        }),
      ).rejects.toBeInstanceOf(NotFoundError);
    },
  );

  it.each([
    { source: 'bogus' },
    { mutationType: 'bogus' },
    { op: 'bogus' },
    { provider: 12 },
    { startedAfter: 'not-a-date' },
    { finishedBefore: '2026-02-30T00:00:00Z' },
    { startedAfter: '2026-10-26T00:00:00Z', startedBefore: at },
    { finishedAfter: '2026-10-26T00:00:00Z', finishedBefore: at },
    {
      startedAfter: '2026-10-25T00:00:00.000002Z',
      startedBefore: '2026-10-25T00:00:00.000001Z',
    },
    {
      finishedAfter: '2026-10-25T00:00:00.000002Z',
      finishedBefore: '2026-10-25T00:00:00.000001Z',
    },
  ])('rejects invalid list filters %p', async request => {
    // Arrange
    await store.ensureReady();
    // Act / Assert
    await expect(
      store.query.listCycles(request as HistoryCycleListRequest),
    ).rejects.toBeInstanceOf(InputError);
  });

  it('binds every list filter but not page size into the cursor context', async () => {
    // Arrange
    for (let index = 0; index < 2; index += 1)
      await store.recordCycle(cycle({ inserts: [entity(`scope-${index}`)] }));
    const filters: HistoryCycleListRequest = {
      source: 'provider',
      provider: 'fixture',
      mutationType: 'delta',
      op: 'insert',
      startedAfter: at,
      startedBefore: at,
      finishedAfter: at,
      finishedBefore: at,
    };
    const first = await store.query.listCycles({ ...filters, limit: 1 });
    const changes: HistoryCycleListRequest[] = [
      { source: 'processing' },
      { provider: 'Fixture' },
      { mutationType: 'full' },
      { op: 'delete' },
      { startedAfter: '2026-10-24T00:00:00Z' },
      { startedBefore: '2026-10-26T00:00:00Z' },
      { finishedAfter: '2026-10-24T00:00:00Z' },
      { finishedBefore: '2026-10-26T00:00:00Z' },
    ];

    // Act
    const tail = await store.query.listCycles({
      ...filters,
      cursor: first.nextCursor,
      limit: 50,
    });

    // Assert
    expect(tail.items).toHaveLength(1);
    for (const change of changes)
      await expect(
        store.query.listCycles({
          ...filters,
          ...change,
          cursor: first.nextCursor,
        }),
      ).rejects.toBeInstanceOf(InputError);
  });

  it('rejects malformed, cross-route, cross-cycle, and altered cursor payloads with safe InputErrors', async () => {
    // Arrange
    const a = cycle({ inserts: [entity('a'), entity('b')] });
    const b = cycle();
    await store.recordCycle(a);
    await store.recordCycle(b);
    const list = await store.query.listCycles({ limit: 1 });
    const detail = await store.query.getCycle({ cycleId: a.cycleId, limit: 1 });
    const listPayload = payload(list.nextCursor);
    const detailPayload = payload(detail.changes.nextCursor);
    const corruptions = [
      { tag: 'feed' },
      { tag: 'providers' },
      { tag: 'entities' },
      { tag: 'kinds' },
      { tag: 'detail' },
      { version: 2 },
      { version: '1' },
      { scope: 'private-cursor-secret' },
      { timestamp: '2026-02-30 00:00:00+00' },
      { timestamp: 7 },
      { id: 12 },
      { id: 'private-cursor-secret' },
      { extra: true },
    ];

    // Act / Assert
    for (const cursor of [
      '',
      'private-cursor-secret!',
      encode(null),
      encode([]),
      encode({}),
      ...corruptions.map(change => encode({ ...listPayload, ...change })),
      detail.changes.nextCursor!,
    ]) {
      await expect(store.query.listCycles({ cursor })).rejects.toMatchObject({
        name: 'InputError',
        message: 'Invalid history cycles cursor',
        cause: undefined,
      });
    }
    for (const cursor of [
      list.nextCursor!,
      ...corruptions.map(change => encode({ ...detailPayload, ...change })),
      ...['0', '-1', '9223372036854775808'].map(id =>
        encode({ ...detailPayload, id }),
      ),
    ]) {
      await expect(
        store.query.getCycle({ cycleId: a.cycleId, cursor }),
      ).rejects.toMatchObject({
        name: 'InputError',
        message: 'Invalid history cycle-changes cursor',
        cause: undefined,
      });
    }
    await expect(
      store.query.getCycle({
        cycleId: b.cycleId,
        cursor: detail.changes.nextCursor,
      }),
    ).rejects.toBeInstanceOf(InputError);
  });

  it('rejects actual feed, row, provider, entity, and kind cursors on both cycle routes', async () => {
    // Arrange: produce cursors through the existing public APIs, not encoder imports.
    const row = entity('shared');
    const input = cycle({
      inserts: [
        row,
        { ...entity('api'), kind: 'API', entityRef: 'api:default/api' },
      ],
    });
    await store.recordCycle(input);
    await store.recordCycle(cycle({ provider: 'second', updates: [row] }));
    const pages = await Promise.all([
      store.query.getChangeFeed({ limit: 1 }),
      store.query.getEntityTimeline({ entityRef: row.entityRef, limit: 1 }),
      store.query.getEntityVersions({ entityRef: row.entityRef, limit: 1 }),
      store.query.getProviders({ limit: 1 }),
      store.query.getEntities({ limit: 1 }),
      store.query.getKinds({ limit: 1 }),
    ]);

    // Act / Assert
    for (const page of pages) {
      expect(page.nextCursor).toEqual(expect.any(String));
      await expect(
        store.query.listCycles({ cursor: page.nextCursor }),
      ).rejects.toBeInstanceOf(InputError);
      await expect(
        store.query.getCycle({
          cycleId: input.cycleId,
          cursor: page.nextCursor,
        }),
      ).rejects.toBeInstanceOf(InputError);
    }
  });

  it('uses one header-only list SELECT and two metadata-only detail SELECTs without counts or provenance reads', async () => {
    // Arrange: initialization must not pollute SQL observations.
    const input = cycle({ inserts: [entity('sql')] });
    await store.recordCycle(input);
    await store.query.ensureReady();
    const statements: string[] = [];
    const listener = (query: { sql: string }) => {
      if (
        /^select\b/i.test(query.sql) &&
        /catalog_history_(cycles|entities)/.test(query.sql)
      )
        statements.push(query.sql);
    };
    db.on('query', listener);
    try {
      // Act
      await store.query.listCycles({ op: 'insert', limit: 1 });
      const list = statements.splice(0);
      await store.query.getCycle({ cycleId: input.cycleId, limit: 1 });
      const detail = statements.splice(0);
      await expect(
        store.query.getCycle({ cycleId: nil }),
      ).rejects.toBeInstanceOf(NotFoundError);

      // Assert
      expect(list).toHaveLength(1);
      expect(list[0]).toMatch(
        /exists.*changes.*cycle_id.*catalog_history_cycles.*cycle_id.*changes.*op/i,
      );
      expect(detail).toHaveLength(2);
      expect(detail[0]).toContain('catalog_history_cycles');
      expect(detail[1]).toMatch(
        /where "cycle_id" = \$1 order by "changed_at" desc, "id" desc limit \$2/,
      );
      expect(statements).toHaveLength(1);
      for (const sql of [...list, ...detail, ...statements])
        expect(sql).not.toMatch(
          /count\(|select \*|metadata|spec|relations|status_items|distinct on/i,
        );
    } finally {
      db.removeListener('query', listener);
    }
  });

  it('records only fixed cycle operation labels and classifies missing detail as not_found', async () => {
    // Arrange
    const journal = metricsJournal();
    const measured = new PostgresHistoryStore(db, { metrics: journal.metrics });
    const input = cycle({
      provider: 'private-provider',
      inserts: [entity('private-entity')],
    });
    await measured.recordCycle(input);

    // Act
    await measured.query.listCycles({ provider: input.provider });
    await measured.query.getCycle({ cycleId: input.cycleId });
    await expect(
      measured.query.getCycle({ cycleId: nil }),
    ).rejects.toBeInstanceOf(NotFoundError);

    // Assert: detail reports each independently executed database read.
    expect(
      journal
        .values('catalog.history.query.operation.duration')
        .map(point => point.attributes),
    ).toEqual([
      { operation: 'cycles', outcome: 'success' },
      { operation: 'cycle_detail', outcome: 'success' },
      { operation: 'cycle_detail', outcome: 'success' },
      { operation: 'cycle_detail', outcome: 'not_found' },
    ]);
    const serialized = JSON.stringify(
      journal.points.filter(point =>
        point.name.startsWith('catalog.history.query.'),
      ),
    );
    expect(serialized).not.toContain(input.cycleId);
    expect(serialized).not.toContain(input.provider);
    expect(serialized).not.toContain('private-entity');
  });
});
