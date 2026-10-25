import { Buffer } from 'node:buffer';
import { randomUUID } from 'node:crypto';
import { TestDatabases } from '@backstage/backend-test-utils';
import type { Knex } from 'knex';
import type {
  CaptureSource,
  EntityRow,
} from '@kunickiaj/backstage-plugin-catalog-history-node';
import { PostgresHistoryStore } from '../PostgresHistoryStore';

jest.setTimeout(30000);

const entityRef = 'user:default/alice';
const provider = 'summary-provider';
const known = { owner: '', relations: [], statusItems: [], orphan: false };
const unchanged = {
  ownerChanged: false,
  relationsChanged: false,
  statusChanged: false,
  orphanChanged: false,
};
const changed = {
  ownerChanged: true,
  relationsChanged: true,
  statusChanged: true,
  orphanChanged: true,
};
const other = {
  owner: 'group:default/platform',
  relations: [{ type: 'ownedBy', targetRef: 'group:default/platform' }],
  statusItems: [{ type: 'test', level: 'error', message: 'failed' }],
  orphan: true,
};

describe('PostgresHistoryStore timeline summaries', () => {
  const databases = TestDatabases.create({ ids: ['POSTGRES_16'] });
  let db: Knex;
  let store: PostgresHistoryStore;
  let tick: number;

  beforeEach(async () => {
    db = await databases.init('POSTGRES_16');
    store = new PostgresHistoryStore(db);
    await store.ensureReady();
    await store.query.ensureReady();
    tick = 0;
  });

  async function record(
    op: 'insert' | 'update' | 'delete',
    fields: Partial<EntityRow> = known,
    scope: { provider?: string; source?: CaptureSource } = {},
  ): Promise<string> {
    const cycleId = randomUUID();
    const at = new Date(Date.UTC(2026, 6, 7, tick++));
    const row: EntityRow = {
      entityRef,
      kind: 'User',
      namespace: 'default',
      name: 'alice',
      etag: 'repeated-etag',
      metadata: { name: 'alice' },
      spec: {},
      ...fields,
    };
    await store.recordCycle({
      cycleId,
      provider: scope.provider ?? provider,
      source: scope.source ?? 'provider',
      mutationType: 'full',
      startedAt: at,
      finishedAt: at,
      inserts: op === 'insert' ? [row] : [],
      updates: op === 'update' ? [row] : [],
      deletes: op === 'delete' ? [row.entityRef] : [],
      unchangedCount: 0,
    });
    const saved = await db('catalog_history_entities')
      .where({ cycle_id: cycleId })
      .first('id');
    return String(saved.id);
  }

  it('compares updates to inserts and repeated-etag physical updates', async () => {
    // Arrange
    const first = await record('insert');
    const second = await record('update', other);
    const third = await record('update', known);
    const fourth = await record('update', known);

    // Act
    const timeline = await store.query.getEntityTimeline({ entityRef });
    const detail = await store.query.getEntityVersion({
      entityRef,
      id: second,
    });
    const unchangedDetail = await store.query.getEntityVersion({
      entityRef,
      id: fourth,
    });

    // Assert
    expect(timeline.items.map(item => [item.id, item.summary])).toEqual([
      [fourth, unchanged],
      [third, changed],
      [second, changed],
      [first, {}],
    ]);
    expect(detail.summary).toEqual(changed);
    expect(unchangedDetail.summary).toEqual(unchanged);
    expect(unchangedDetail.previousVersion).toMatchObject({
      id: third,
      summary: {},
      snapshot: known,
    });
    expect(unchangedDetail.changes).toEqual([]);
    expect(detail.previousVersion).toMatchObject({
      id: first,
      summary: {},
      snapshot: known,
    });
    expect(detail.changes).toEqual([
      { path: ['orphan'], op: 'replace', before: false, after: true },
      { path: ['owner'], op: 'replace', before: '', after: other.owner },
      {
        path: ['relations'],
        op: 'replace',
        before: [],
        after: other.relations,
      },
      {
        path: ['statusItems'],
        op: 'replace',
        before: [],
        after: other.statusItems,
      },
    ]);
  });

  it.each(['owner', 'relations', 'statusItems', 'orphan'] as const)(
    'omits the %s flag for SQL NULL on either side',
    async field => {
      // Arrange: recordCycle persists undefined fields as SQL NULL.
      const partial = { ...known, [field]: undefined };
      await record('insert', partial);
      const knownId = await record('update', known);
      const unknownId = await record('update', partial);
      const expected: Record<string, boolean> = { ...unchanged };
      const flag = {
        owner: 'ownerChanged',
        relations: 'relationsChanged',
        statusItems: 'statusChanged',
        orphan: 'orphanChanged',
      }[field];
      delete expected[flag];

      // Act
      const timeline = await store.query.getEntityTimeline({ entityRef });
      const detail = await store.query.getEntityVersion({
        entityRef,
        id: unknownId,
      });

      // Assert
      expect(
        timeline.items
          .filter(item => item.op === 'update')
          .map(item => item.summary),
      ).toEqual([expected, expected]);
      expect(detail.summary).toEqual(expected);
      expect(detail.previousVersion?.id).toBe(knownId);
    },
  );

  it('does not compare first updates or updates across a deletion barrier', async () => {
    // Arrange
    const first = await record('update', known);
    const inserted = await record('insert', known);
    const deleted = await record('delete');
    const recreated = await record('update', other);

    // Act
    const timeline = await store.query.getEntityTimeline({ entityRef });
    const firstDetail = await store.query.getEntityVersion({
      entityRef,
      id: first,
    });
    const deletedDetail = await store.query.getEntityVersion({
      entityRef,
      id: deleted,
    });
    const recreatedDetail = await store.query.getEntityVersion({
      entityRef,
      id: recreated,
    });

    // Assert
    expect(timeline.items.map(item => item.summary)).toEqual([{}, {}, {}, {}]);
    expect(firstDetail.summary).toEqual({});
    expect(firstDetail.previousVersion).toBeUndefined();
    expect(firstDetail.changes).toBeUndefined();
    expect(deletedDetail.summary).toEqual({});
    expect(deletedDetail.snapshot).toBeUndefined();
    expect(deletedDetail.previousVersion).toMatchObject({
      id: inserted,
      summary: {},
      snapshot: known,
    });
    expect(deletedDetail.changes).toEqual(
      expect.arrayContaining([
        { path: ['owner'], op: 'remove', before: '' },
        { path: ['orphan'], op: 'remove', before: false },
      ]),
    );
    expect(recreatedDetail).toMatchObject({
      summary: {},
      previousVersion: { id: deleted, summary: {} },
    });
    expect(recreatedDetail.previousVersion?.snapshot).toBeUndefined();
    expect(recreatedDetail.changes).toBeUndefined();
  });

  it('ignores closer rows from another entity, source, or provider', async () => {
    // Arrange: literal wildcard characters must not broaden provider matching.
    const scopedProvider = 'summary_%_provider';
    const first = await record('insert', known, { provider: scopedProvider });
    await record('update', other, { provider: 'summary_X_provider' });
    await record('update', other, {
      provider: scopedProvider,
      source: 'processing',
    });
    await record(
      'update',
      { ...other, entityRef: 'user:default/bob', name: 'bob' },
      { provider: scopedProvider },
    );
    const last = await record('update', known, { provider: scopedProvider });

    // Act
    const timeline = await store.query.getEntityTimeline({
      entityRef,
      provider: scopedProvider,
      source: 'provider',
    });
    const detail = await store.query.getEntityVersion({ entityRef, id: last });

    // Assert
    expect(timeline.items.map(item => [item.id, item.summary])).toEqual([
      [last, unchanged],
      [first, {}],
    ]);
    expect(detail.summary).toEqual(unchanged);
    expect(detail.previousVersion?.id).toBe(first);
  });

  it.each([
    { owner: other.owner },
    { op: 'update' as const },
    {
      changedAfter: '2026-07-07T00:30:00.000Z',
      changedBefore: '2026-07-07T01:30:00.000Z',
    },
  ])(
    'applies page filters without hiding the physical predecessor: %j',
    async filter => {
      // Arrange
      await record('insert', known);
      const id = await record('update', other);

      // Act
      const timeline = await store.query.getEntityTimeline({
        entityRef,
        ...filter,
      });

      // Assert
      expect(timeline.items.map(item => [item.id, item.summary])).toEqual([
        [id, changed],
      ]);
    },
  );

  it('keeps summaries and metadata on limit-one cursor pages with equal timestamps', async () => {
    // Arrange
    const first = await record('insert', known);
    const second = await record('update', other);
    const third = await record('update', other);
    await db('catalog_history_entities').update({
      changed_at: '2026-07-07T00:00:00.000Z',
    });

    // Act
    const page1 = await store.query.getEntityTimeline({ entityRef, limit: 1 });
    const page2 = await store.query.getEntityTimeline({
      entityRef,
      limit: 1,
      cursor: page1.nextCursor,
    });
    const page3 = await store.query.getEntityTimeline({
      entityRef,
      limit: 1,
      cursor: page2.nextCursor,
    });

    // Assert
    expect(page1.items[0]).toMatchObject({
      id: third,
      entityRef,
      provider,
      source: 'provider',
      op: 'update',
      etag: 'repeated-etag',
      changedAt: '2026-07-07T00:00:00.000Z',
      summary: unchanged,
    });
    expect(page1.items[0].cycleId).toEqual(expect.any(String));
    expect(page2.items[0]).toMatchObject({ id: second, summary: changed });
    expect(page3.items[0]).toMatchObject({ id: first, summary: {} });
    expect(
      JSON.parse(Buffer.from(page1.nextCursor!, 'base64url').toString('utf8')),
    ).toEqual({ changedAt: '2026-07-07T00:00:00.000Z', id: third });
    expect(page2.nextCursor).toEqual(expect.any(String));
    expect(page3.nextCursor).toBeUndefined();
  });

  it.each(['equal timestamps', 'stored microseconds'])(
    'compares native bigint tuples with %s without rounding through JavaScript',
    async mode => {
      // Arrange: ID order opposes microsecond order; no rounded cursor is used.
      const ids = [
        await record('insert', known),
        await record('update', other),
        await record('update', other),
      ];
      const largeIds =
        mode === 'equal timestamps'
          ? ['9007199254740992', '9007199254740993', '9007199254740994']
          : ['9007199254740994', '9007199254740993', '9007199254740992'];
      for (const [index, id] of ids.entries()) {
        const timestamp =
          mode === 'equal timestamps'
            ? '2026-07-07T00:00:00.000000Z'
            : `2026-07-07T00:00:00.000${index + 1}00Z`;
        await db('catalog_history_entities')
          .where({ id })
          .update({ id: largeIds[index], changed_at: timestamp });
      }

      // Act
      const timeline = await store.query.getEntityTimeline({ entityRef });
      const detail = await store.query.getEntityVersion({
        entityRef,
        id: largeIds[1],
      });

      // Assert
      expect(timeline.items.map(item => [item.id, item.summary])).toEqual([
        [largeIds[2], unchanged],
        [largeIds[1], changed],
        [largeIds[0], {}],
      ]);
      expect(detail.summary).toEqual(changed);
      expect(detail.previousVersion?.id).toBe(largeIds[0]);
    },
  );

  it('treats saved relation and status array order as a change', async () => {
    // Arrange
    const fields = {
      ...known,
      relations: [
        { type: 'a', targetRef: 'group:default/a' },
        { type: 'b', targetRef: 'group:default/b' },
      ],
      statusItems: [{ type: 'a' }, { type: 'b' }],
    };
    await record('insert', fields);
    const id = await record('update', {
      ...fields,
      relations: [...fields.relations].reverse(),
      statusItems: [...fields.statusItems].reverse(),
    });

    // Act
    const timeline = await store.query.getEntityTimeline({ entityRef });
    const detail = await store.query.getEntityVersion({ entityRef, id });

    // Assert
    const expected = {
      ...unchanged,
      relationsChanged: true,
      statusChanged: true,
    };
    expect(timeline.items[0].summary).toEqual(expected);
    expect(detail.summary).toEqual(expected);
  });

  it('normalizes malformed JSON arrays exactly like detail snapshots', async () => {
    // Arrange: legacy persisted values, not new capture input restrictions.
    const first = await record('insert', known);
    const second = await record('update', known);
    await db('catalog_history_entities')
      .where({ id: first })
      .update({
        relations: JSON.stringify([
          null,
          1,
          'bad',
          [],
          { type: 'ownedBy', targetRef: 'a' },
        ]),
        status_items: JSON.stringify({ invalid: 'not an array' }),
      });
    await db('catalog_history_entities')
      .where({ id: second })
      .update({
        relations: JSON.stringify([{ targetRef: 'a', type: 'ownedBy' }]),
        status_items: JSON.stringify([]),
      });
    const third = await record('update', known);
    await db('catalog_history_entities')
      .where({ id: third })
      .update({
        relations: JSON.stringify('not an array'),
      });

    // Act
    const timeline = await store.query.getEntityTimeline({ entityRef });
    const detail = await store.query.getEntityVersion({
      entityRef,
      id: second,
    });

    // Assert
    const expected = {
      ownerChanged: false,
      relationsChanged: false,
      orphanChanged: false,
    };
    expect(timeline.items[1].summary).toEqual(expected);
    expect(timeline.items[0].summary).toEqual({
      ownerChanged: false,
      statusChanged: false,
      orphanChanged: false,
    });
    expect(detail.summary).toEqual(expected);
    expect(detail.previousVersion?.snapshot?.relations).toEqual([
      { type: 'ownedBy', targetRef: 'a' },
    ]);
    expect(detail.previousVersion?.snapshot?.statusItems).toBeUndefined();
    expect(detail.snapshot?.statusItems).toEqual([]);
  });

  it('keeps global feed and version-list summaries empty without changing captured baselines', async () => {
    // Arrange
    await record('insert', known);
    const last = await record('update', other);

    // Act
    const feed = await store.query.getChangeFeed({});
    const versions = await store.query.getEntityVersions({ entityRef });
    const timeline = await store.query.getEntityTimeline({ entityRef });
    const etags = await store.loadCurrentEtags(provider);
    const saved = await db('catalog_history_entities')
      .where({ id: last })
      .first();

    // Assert
    expect(feed.items.map(item => item.summary)).toEqual([{}, {}]);
    expect(versions.items.map(item => item.summary)).toEqual([{}]);
    expect(timeline.items[0].summary).toEqual(changed);
    expect(etags.get(entityRef)).toBe('repeated-etag');
    expect(saved).toMatchObject({
      owner: other.owner,
      relations: other.relations,
      status_items: other.statusItems,
      orphan: true,
    });
    expect(saved).not.toHaveProperty('summary');
  });

  it('returns an empty page without a fabricated summary or cursor', async () => {
    // Arrange: initialize schema even though no capture has run.
    const statements: string[] = [];
    const listener = (query: { sql: string }) => {
      if (
        /^(select|with)\b/i.test(query.sql) &&
        query.sql.includes('catalog_history_entities')
      ) {
        statements.push(query.sql);
      }
    };
    db.on('query', listener);
    try {
      // Act
      const timeline = await store.query.getEntityTimeline({
        entityRef,
        limit: 1,
      });

      // Assert
      expect(timeline).toEqual({ items: [], nextCursor: undefined });
      expect(statements).toHaveLength(1);
    } finally {
      db.off('query', listener);
    }
  });

  it('uses one paged lateral timeline statement and two detail statements, not per-item queries', async () => {
    // Arrange: both schema caches are warm before observing history reads.
    await record('insert', known);
    const id = await record('update', other);
    await record('update', known);
    const statements: Array<{ sql: string; bindings: unknown[] }> = [];
    const listener = (query: { sql: string; bindings: unknown[] }) => {
      if (
        /^(select|with)\b/i.test(query.sql) &&
        query.sql.includes('catalog_history_entities')
      ) {
        statements.push(query);
      }
    };
    db.on('query', listener);
    try {
      // Act
      const timeline = await store.query.getEntityTimeline({
        entityRef,
        limit: 2,
      });
      const timelineSql = [...statements];
      statements.length = 0;
      const detail = await store.query.getEntityVersion({ entityRef, id });

      // Assert
      expect(timeline.items).toHaveLength(2);
      expect(timelineSql).toHaveLength(1);
      expect(timelineSql[0].sql).toMatch(
        /limit\s+\$2\)\s+as\s+"page"\s+left join lateral/i,
      );
      expect(timelineSql[0].bindings[1]).toBe(3);
      expect(timelineSql[0].sql).not.toMatch(/\b(lag|lead)\s*\(|\bover\s*\(/i);
      expect(statements).toHaveLength(2);
      expect(detail.summary).toEqual(changed);
    } finally {
      db.off('query', listener);
    }
  });
});
