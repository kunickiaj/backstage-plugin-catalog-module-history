import { Buffer } from 'node:buffer';
import { randomUUID } from 'node:crypto';
import { TestDatabases } from '@backstage/backend-test-utils';
import { InputError } from '@backstage/errors';
import type {
  HistoryEntitySearchRequest,
  HistoryKindSearchRequest,
} from '@kunickiaj/backstage-plugin-catalog-history-common';
import type {
  CycleInput,
  EntityRow,
} from '@kunickiaj/backstage-plugin-catalog-history-node';
import { knex, type Knex } from 'knex';
import { PostgresHistoryStore } from '../PostgresHistoryStore';
import { metricsJournal } from './metricsJournal';

jest.setTimeout(30000);
const at = '2026-10-25T00:00:00Z';

function entity(
  name: string,
  kind = 'Component',
  namespace = 'default',
): EntityRow {
  return {
    entityRef: `${kind.toLowerCase()}:${namespace}/${name}`,
    name,
    kind,
    namespace,
    etag: 'one',
    metadata: { name, description: 'private-snapshot-payload' },
    spec: {},
  };
}

function cycle(
  inserts: EntityRow[],
  options: Partial<CycleInput> = {},
): CycleInput {
  return {
    cycleId: randomUUID(),
    provider: 'fixture',
    source: 'provider',
    mutationType: 'delta',
    startedAt: new Date(at),
    finishedAt: new Date(at),
    inserts,
    updates: [],
    deletes: [],
    unchangedCount: 0,
    ...options,
  };
}

function identity(row: EntityRow) {
  return {
    entityRef: row.entityRef,
    name: row.name,
    kind: row.kind,
    namespace: row.namespace,
  };
}

function encode(value: unknown) {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

describe('PostgresHistoryQueryService retained entity and kind discovery', () => {
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

  it('initializes empty discovery concurrently and finds retained custom tombstones beyond the event page', async () => {
    // Arrange: no writer has initialized the schema.
    const empty = await Promise.all([
      store.query.getEntities({}),
      store.query.getKinds({}),
    ]);
    const removed = entity('removed', 'CustomWidget', 'archive');
    await store.recordCycle(cycle([], { deletes: [removed.entityRef] }));
    await store.recordCycle(
      cycle(
        Array.from({ length: 150 }, (_, n) => entity(`recent-${n}`)),
        {
          finishedAt: new Date('2026-10-26T00:00:00Z'),
        },
      ),
    );

    // Act
    const page = await store.query.getEntities({ prefix: 'REM' });
    const kinds = await store.query.getKinds({});
    const feed = await store.query.getChangeFeed({});
    const missing = await store.query.getEntities({ prefix: 'absent' });

    // Assert
    expect(empty).toEqual([
      { items: [], nextCursor: undefined },
      { items: [], nextCursor: undefined },
    ]);
    expect(page.items.map(item => item.entityRef)).toEqual([removed.entityRef]);
    expect(kinds.items.map(kind => kind.toLowerCase())).toEqual([
      'component',
      'customwidget',
    ]);
    expect(feed.items).toHaveLength(25);
    expect(feed.items.every(item => item.op === 'insert')).toBe(true);
    expect(missing).toEqual({ items: [], nextCursor: undefined });
  });

  it('paginates after deduplication by folded name and ref, preserving original fields and blank anchors', async () => {
    // Arrange: stored names need not match the canonical ref spelling.
    const rows = [
      { ...entity('blank'), name: '' },
      entity('  padded  '),
      entity('Same', 'Api', 'a'),
      entity('same', 'Component', 'a'),
      entity('SAME', 'Component', 'b'),
    ];
    await store.recordCycle(cycle(rows));
    await store.recordCycle(cycle([], { updates: rows }));

    // Act
    const first = await store.query.getEntities({ limit: 1 });
    const second = await store.query.getEntities({
      prefix: '',
      cursor: first.nextCursor,
      limit: 2,
    });
    const third = await store.query.getEntities({
      cursor: second.nextCursor,
      limit: 100,
    });
    const padded = await store.query.getEntities({ prefix: '  ' });
    const refPrefix = await store.query.getEntities({ prefix: 'component:' });

    // Assert
    expect(first.items).toEqual([identity(rows[0])]);
    expect(first.nextCursor).toEqual(expect.any(String));
    expect([...first.items, ...second.items, ...third.items]).toEqual(
      rows.map(identity),
    );
    expect(third.nextCursor).toBeUndefined();
    expect(padded.items).toEqual([identity(rows[1])]);
    expect(refPrefix.items).toEqual([]);
  });

  it('defaults to 25 and caps entity pages at 100 without counting duplicate observations', async () => {
    // Arrange
    const rows = Array.from({ length: 105 }, (_, n) =>
      entity(`item-${String(n).padStart(3, '0')}`),
    );
    await store.recordCycle(cycle(rows));
    await store.recordCycle(cycle([], { updates: rows }));

    // Act
    const first = await store.query.getEntities({});
    const capped = await store.query.getEntities({ limit: 1000 });
    const tail = await store.query.getEntities({
      cursor: capped.nextCursor,
      limit: 100,
    });

    // Assert
    expect(first.items).toEqual(rows.slice(0, 25).map(identity));
    expect(capped.items).toEqual(rows.slice(0, 100).map(identity));
    expect(tail).toEqual({
      items: rows.slice(100).map(identity),
      nextCursor: undefined,
    });
  });

  it.each([
    '%',
    '_',
    '\\',
    "'",
    "'; DROP TABLE catalog_history_entities; --",
    '猫',
    'É',
  ])(
    'matches literal name prefix %j, not substring or wildcard',
    async prefix => {
      // Arrange
      const row = entity('safe');
      const match = { ...row, name: `${prefix}tail` };
      await store.recordCycle(
        cycle([
          match,
          { ...entity('other'), name: `x${prefix}tail` },
          entity('ordinary'),
        ]),
      );

      // Act
      const result = await store.query.getEntities({ prefix });
      const absent = await store.query.getEntities({
        prefix: `${prefix}missing`,
      });

      // Assert
      expect(result.items).toEqual([identity(match)]);
      expect(absent.items).toEqual([]);
    },
  );

  it.each(['%', '_', '\\', '😀', 'x'.repeat(1025)])(
    'truncates raw SQL-folded text before escaping at the 128-character boundary %j',
    async special => {
      // Arrange: the shared index key cannot replace the full prefix recheck.
      const prefix = `${'a'.repeat(127)}${special}${'猫'.repeat(10)}`;
      const matching = { ...entity('match'), name: `${prefix}tail` };
      await store.recordCycle(
        cycle([
          matching,
          { ...entity('decoy'), name: `${'a'.repeat(127)}${special}different` },
        ]),
      );

      // Act
      const result = await store.query.getEntities({ prefix });
      const absent = await store.query.getEntities({
        prefix: `${prefix}missing`,
      });

      // Assert
      expect(result.items).toEqual([identity(matching)]);
      expect(absent.items).toEqual([]);
    },
  );

  it('uses database-locale LOWER and accepts long prefixes without truncating Unicode in JavaScript', async () => {
    // Arrange
    const prefix = `${'😀'.repeat(65)}É`;
    const rows = ['Éclair', 'école', 'eclair', `${prefix}tail`].map(
      (name, n) => ({ ...entity(`ref-${n}`), name }),
    );
    await store.recordCycle(cycle(rows));
    const expected = await db('catalog_history_entities')
      .whereRaw(
        'left(lower(name), char_length(lower(?::text))) = lower(?::text)',
        ['é', 'é'],
      )
      .orderByRaw('lower(name) COLLATE "C", entity_ref COLLATE "C"')
      .pluck('entity_ref');

    // Act
    const accented = await store.query.getEntities({ prefix: 'é' });
    const long = await store.query.getEntities({ prefix });

    // Assert
    expect(accented.items.map(item => item.entityRef)).toEqual(expected);
    expect(accented.items.map(item => item.name)).not.toContain('eclair');
    expect(long.items).toEqual([identity(rows[3])]);
  });

  it('selects every identity field from one latest matching row, before pagination and after all filters', async () => {
    // Arrange: independent stored fields intentionally differ between observations.
    const old = {
      ...entity('old'),
      entityRef: 'component:default/stable',
      kind: 'CustomKind',
      namespace: 'OldNS',
      name: 'Match-old',
    };
    const latest = { ...old, name: 'Match-latest', namespace: 'LatestNS' };
    await store.recordCycle(
      cycle([], {
        source: 'processing',
        provider: 'wanted',
        updates: [old, latest],
      }),
    );
    await store.recordCycle(
      cycle(
        [
          {
            ...old,
            kind: 'OtherKind',
            namespace: 'OtherNS',
            name: 'unmatched',
          },
        ],
        { finishedAt: new Date('2026-10-26T00:00:00Z') },
      ),
    );
    const request: HistoryEntitySearchRequest = {
      prefix: 'MATCH',
      kind: 'customkind',
      provider: 'wanted',
      source: 'processing',
      op: 'update',
      changedAfter: at,
      changedBefore: at,
    };

    // Act
    const result = await store.query.getEntities(request);
    const incompatible = await store.query.getEntities({
      ...request,
      op: 'delete',
    });
    const exactProvider = await store.query.getEntities({
      ...request,
      provider: 'want',
    });
    const unsupported = {
      ...request,
      entityRef: 'component:default/not-selected',
      owner: 'group:default/ignored',
    };
    const alternatives = await store.query.getEntities(
      unsupported as unknown as HistoryEntitySearchRequest,
    );

    // Assert
    expect(result.items).toEqual([identity(latest)]);
    expect(incompatible.items).toEqual([]);
    expect(exactProvider.items).toEqual([]);
    expect(alternatives).toEqual(result);
  });

  it('compares native bigint IDs and microsecond timestamps when choosing the latest matching observation', async () => {
    // Arrange: numbers exceed JS safe integers; newer timestamps outrank IDs.
    const row = entity('stable');
    await store.recordCycle(
      cycle([row], {
        updates: [
          { ...row, name: 'id-winner' },
          { ...row, name: 'time-winner' },
        ],
      }),
    );
    const ids = await db('catalog_history_entities').orderBy('id').pluck('id');
    for (const [n, id] of ids.entries()) {
      await db('catalog_history_entities')
        .where({ id })
        .update({
          id: ['9007199254740993', '9007199254740994', '9007199254740992'][n],
          changed_at:
            n === 2
              ? '2026-10-25T00:00:00.000999Z'
              : '2026-10-25T00:00:00.000998Z',
        });
    }

    // Act
    const latest = await store.query.getEntities({});
    const tied = await store.query.getEntities({
      changedBefore: '2026-10-25T00:00:00.000998Z',
    });
    const outside = await store.query.getEntities({
      changedAfter: '2026-10-25T00:00:00.001000Z',
    });

    // Assert
    expect(latest.items[0].name).toBe('time-winner');
    expect(tied.items[0].name).toBe('id-winner');
    expect(outside.items).toEqual([]);
  });

  const scope: HistoryEntitySearchRequest = {
    prefix: 'scope-',
    kind: 'Component',
    source: 'processing',
    provider: 'wanted',
    op: 'update',
    changedAfter: '2026-10-25T00:00:00.000999Z',
    changedBefore: '2026-10-25T00:00:00.000999Z',
  };
  async function scopedPage() {
    const input = cycle([], {
      source: 'processing',
      provider: 'wanted',
      updates: [entity('scope-a'), entity('scope-b')],
    });
    await store.recordCycle(input);
    await db('catalog_history_entities')
      .where({ cycle_id: input.cycleId })
      .update({ changed_at: scope.changedAfter });
    return store.query.getEntities({ ...scope, limit: 1 });
  }

  it.each<Partial<HistoryEntitySearchRequest>>([
    { prefix: 'missing' },
    { kind: 'Other' },
    { source: 'reconciler' },
    { provider: 'want' },
    { op: 'delete' },
    { changedAfter: '2026-10-25T00:00:00.001000Z', changedBefore: undefined },
    { changedAfter: undefined, changedBefore: '2026-10-25T00:00:00.000998Z' },
  ])(
    'applies observation filter %j before choosing entity identities',
    async changed => {
      // Arrange
      const first = await scopedPage();

      // Act
      const missing = await store.query.getEntities({ ...scope, ...changed });

      // Assert
      expect(first.items).toHaveLength(1);
      expect(missing.items).toEqual([]);
    },
  );

  it('preserves inclusive microsecond scope across entity pages while allowing a new limit', async () => {
    // Arrange
    const first = await scopedPage();

    // Act
    const next = await store.query.getEntities({
      ...scope,
      cursor: first.nextCursor,
      limit: 100,
    });

    // Assert
    expect(first.items.map(item => item.name)).toEqual(['scope-a']);
    expect(first.nextCursor).toEqual(expect.any(String));
    expect(next.items.map(item => item.name)).toEqual(['scope-b']);
    expect(next.nextCursor).toBeUndefined();
  });

  it.each<Partial<HistoryEntitySearchRequest>>([
    { prefix: 'other' },
    { kind: 'User' },
    { source: 'provider' },
    { provider: 'other' },
    { op: 'delete' },
    { changedAfter: at },
    { changedBefore: '2026-10-26T00:00:00Z' },
  ])('rejects changed entity cursor scope %j', async changed => {
    // Arrange
    const first = await scopedPage();

    // Act
    const result = store.query.getEntities({
      ...scope,
      ...changed,
      cursor: first.nextCursor,
    });

    // Assert
    expect(first.nextCursor).toEqual(expect.any(String));
    await expect(result).rejects.toBeInstanceOf(InputError);
  });

  it.each([
    { limit: 0 },
    { limit: -1 },
    { limit: 1.5 },
    { limit: NaN },
    { limit: Infinity },
    { prefix: 42 },
    { source: 'wrong' },
    { op: 'wrong' },
    { changedAfter: '' },
    { changedBefore: '' },
    { cursor: '' },
    { cursor: 'not-base64!' },
    { cursor: encode(null) },
    { cursor: encode([]) },
    { cursor: encode({ changedAt: at, id: '1' }) },
  ])(
    'rejects invalid direct entity input %j without SQL details',
    async input => {
      // Arrange
      const request = input as unknown as HistoryEntitySearchRequest;

      // Act
      const result = store.query.getEntities(request);

      // Assert
      await expect(result).rejects.toBeInstanceOf(InputError);
      await expect(result).rejects.not.toThrow(
        /select .*catalog_history_entities/i,
      );
    },
  );

  it('groups kinds by database-folded spelling, selects C-minimum originals, and exhausts retained custom kinds', async () => {
    // Arrange
    const kinds = Array.from(
      { length: 105 },
      (_, n) => `Custom${String(n).padStart(3, '0')}`,
    );
    await store.recordCycle(cycle(kinds.map(kind => entity('same', kind))));
    await store.recordCycle(
      cycle([entity('a', 'custom000'), entity('b', 'CUSTOM000')]),
    );
    await store.recordCycle(cycle([], { deletes: ['zombie:default/deleted'] }));

    // Act
    const first = await store.query.getKinds({});
    const next = await store.query.getKinds({
      cursor: first.nextCursor,
      limit: 100,
    });
    const capped = await store.query.getKinds({ limit: 1000 });
    const prefix = await store.query.getKinds({ prefix: 'cUsToM000' });
    const absent = await store.query.getKinds({ prefix: 'missing' });

    // Assert
    const expected = ['CUSTOM000', ...kinds.slice(1), 'zombie'];
    expect(first.items).toEqual(expected.slice(0, 25));
    expect([...first.items, ...next.items]).toEqual(expected);
    expect(next.nextCursor).toBeUndefined();
    expect(capped.items).toHaveLength(100);
    expect(prefix.items).toEqual(['CUSTOM000']);
    expect(absent.items).toEqual([]);
  });

  it.each(['%', '_', '\\', "'", '猫'])(
    'matches literal kind prefix %j before grouping',
    async prefix => {
      // Arrange
      const kind = `${prefix}Custom`;
      await store.recordCycle(
        cycle([
          entity('a', kind),
          entity('b', `x${kind}`),
          entity('c', 'ordinary'),
        ]),
      );

      // Act
      const result = await store.query.getKinds({ prefix });
      const absent = await store.query.getKinds({ prefix: `${prefix}missing` });

      // Assert
      expect(result.items).toEqual([kind]);
      expect(absent.items).toEqual([]);
    },
  );

  it('preserves blank and whitespace kind anchors and folds Unicode kinds in PostgreSQL', async () => {
    // Arrange: stored fields may differ from their valid canonical references.
    const rows = ['', ' ', '  padded', 'Éclair', 'école', 'eclair'].map(
      (kind, n) => ({ ...entity(`kind-${n}`), kind }),
    );
    await store.recordCycle(cycle(rows));
    const expected = await db('catalog_history_entities')
      .whereRaw(
        'left(lower(kind), char_length(lower(?::text))) = lower(?::text)',
        ['é', 'é'],
      )
      .groupByRaw('lower(kind) COLLATE "C"')
      .orderByRaw('lower(kind) COLLATE "C"')
      .select(db.raw('min(kind COLLATE "C") as kind'));

    // Act
    const first = await store.query.getKinds({ limit: 1 });
    const tail = await store.query.getKinds({
      prefix: '',
      cursor: first.nextCursor,
    });
    const accented = await store.query.getKinds({ prefix: 'é' });
    const whitespace = await store.query.getKinds({ prefix: '  ' });

    // Assert
    expect(first.items).toEqual(['']);
    expect(first.nextCursor).toEqual(expect.any(String));
    expect(tail.items).toEqual([' ', '  padded', 'eclair', 'Éclair', 'école']);
    expect(accented.items).toEqual(expected.map(row => row.kind));
    expect(accented.items).not.toContain('eclair');
    expect(whitespace.items).toEqual(['  padded']);
  });

  it('keeps kind discovery unscoped and rejects kind cursor prefix changes and cross-route cursors', async () => {
    // Arrange
    await store.recordCycle(
      cycle([
        entity('a', 'Alpha'),
        entity('b', 'Another'),
        entity('c', 'Beta'),
      ]),
    );
    const first = await store.query.getKinds({ prefix: 'a', limit: 1 });
    await store.recordCycle(
      cycle([], { provider: 'second', updates: [entity('d', 'Beta')] }),
    );
    const providers = await store.query.getProviders({ limit: 1 });
    const feed = await store.query.getChangeFeed({ limit: 1 });
    const entities = await store.query.getEntities({ limit: 1 });

    // Act
    const next = await store.query.getKinds({
      prefix: 'a',
      cursor: first.nextCursor,
      limit: 100,
    });
    const unscoped = await store.query.getKinds({
      prefix: '',
      ...{
        source: 'nonexistent',
        kind: 'nothing',
        provider: 'nothing',
        entityRef: 'nothing',
        op: 'delete',
      },
    });
    const rejected = await Promise.allSettled([
      store.query.getKinds({ prefix: 'b', cursor: first.nextCursor }),
      store.query.getEntities({ cursor: first.nextCursor }),
      store.query.getEntities({ cursor: feed.nextCursor }),
      store.query.getKinds({ cursor: entities.nextCursor }),
      store.query.getEntities({ cursor: providers.nextCursor }),
    ]);

    // Assert
    expect(next).toEqual({ items: ['Another'], nextCursor: undefined });
    expect(unscoped.items).toEqual(['Alpha', 'Another', 'Beta']);
    expect(rejected).toEqual(
      Array.from({ length: 5 }, () => ({
        status: 'rejected',
        reason: expect.any(InputError),
      })),
    );
    expect(providers.items).toEqual(['fixture']);
  });

  it.each(['entities', 'kinds'] as const)(
    'rejects malformed %s cursor versions, shapes, and last anchors',
    async operation => {
      // Arrange: mutate genuine emitted cursors rather than inventing a wire format.
      await store.recordCycle(
        cycle([entity('a', 'Alpha'), entity('b', 'Beta')]),
      );
      const first =
        operation === 'entities'
          ? await store.query.getEntities({ limit: 1 })
          : await store.query.getKinds({ limit: 1 });
      expect(first.nextCursor).toEqual(expect.any(String));
      const payload: unknown = JSON.parse(
        Buffer.from(first.nextCursor!, 'base64url').toString('utf8'),
      );
      if (!payload || typeof payload !== 'object')
        throw new Error('Expected cursor object');
      const mutations = [
        { tag: 'history' },
        { version: 2 },
        { version: '1' },
        { foldedName: null },
        { foldedName: 42 },
        { scope: null },
        { extra: 'unexpected' },
        ...(operation === 'entities'
          ? [{ entityRef: null }, { entityRef: 42 }]
          : []),
      ];

      // Act
      const results = await Promise.allSettled(
        mutations.map(fields => {
          const cursor = encode({ ...payload, ...fields });
          return operation === 'entities'
            ? store.query.getEntities({ cursor })
            : store.query.getKinds({ cursor });
        }),
      );

      // Assert
      expect(results).toEqual(
        mutations.map(() => ({
          status: 'rejected',
          reason: expect.any(InputError),
        })),
      );
    },
  );

  it.each([
    { limit: 0 },
    { limit: -1 },
    { limit: 1.5 },
    { limit: NaN },
    { limit: Infinity },
    { prefix: 42 },
    { cursor: '' },
    { cursor: 'not-base64!' },
    { cursor: encode(null) },
    { cursor: encode([]) },
  ])('rejects invalid direct kind input %j', async input => {
    // Arrange
    const request = input as unknown as HistoryKindSearchRequest;

    // Act
    const result = store.query.getKinds(request);

    // Assert
    await expect(result).rejects.toBeInstanceOf(InputError);
  });

  it.each(['create', 'gauge_create', 'record'] as const)(
    'isolates metrics SDK %s failures from both discovery routes',
    async failure => {
      // Arrange
      await store.recordCycle(cycle([entity('visible')]));
      const journal = metricsJournal(failure);
      const observed = new PostgresHistoryStore(db, {
        metrics: journal.metrics,
      });
      try {
        // Act
        const entities = await observed.query.getEntities({});
        const kinds = await observed.query.getKinds({});

        // Assert
        expect(entities.items.map(item => item.name)).toEqual(['visible']);
        expect(kinds.items).toEqual(['Component']);
      } finally {
        await observed.shutdown();
      }
    },
  );

  it.each(['entities', 'kinds'] as const)(
    'executes one metadata-only SQL query with fixed %s metrics',
    async operation => {
      // Arrange
      const prefix = 'private-query-prefix';
      await store.recordCycle(
        cycle([
          entity(`${prefix}a`, `${prefix}A`),
          entity(`${prefix}b`, `${prefix}B`),
        ]),
      );
      const journal = metricsJournal();
      const observed = new PostgresHistoryStore(db, {
        metrics: journal.metrics,
      });
      await observed.query.ensureReady();
      const feed = jest.spyOn(observed.query, 'getChangeFeed');
      const statements: Array<{ sql: string; bindings?: readonly unknown[] }> =
        [];
      const listener = (query: {
        sql: string;
        bindings?: readonly unknown[];
      }) => statements.push(query);
      db.on('query', listener);
      try {
        // Act
        const page =
          operation === 'entities'
            ? await observed.query.getEntities({ prefix, limit: 1 })
            : await observed.query.getKinds({ prefix, limit: 1 });

        // Assert
        const selects = statements.filter(
          query =>
            /^(select|with)\b/i.test(query.sql) &&
            query.sql.includes('catalog_history_entities'),
        );
        expect(selects).toHaveLength(1);
        expect(selects[0].sql).not.toMatch(
          /count\s*\(|metadata|spec|relations|status_items/,
        );
        expect(selects[0].sql).not.toContain(prefix);
        expect(selects[0].bindings).toEqual(expect.arrayContaining([2]));
        expect(feed).not.toHaveBeenCalled();
        expect(page.items).toHaveLength(1);
        expect(
          journal
            .values('catalog.history.query.operation.duration')
            .map(point => point.attributes),
        ).toEqual([{ operation, outcome: 'success' }]);
        expect(JSON.stringify(journal.points)).not.toContain(prefix);
        expect(JSON.stringify(page)).not.toContain('private-snapshot-payload');
      } finally {
        db.off('query', listener);
        await observed.shutdown();
      }
    },
  );

  it.each(['entities', 'kinds'] as const)(
    'cancels blocked %s reads and reuses the same connection without leaked timeouts',
    async operation => {
      // Arrange: migrate before locking the fixture table.
      await store.recordCycle(cycle([entity('visible')]));
      const readDb = knex({ ...db.client.config, pool: { min: 0, max: 1 } });
      const journal = metricsJournal();
      const timed = new PostgresHistoryStore(readDb, {
        queryTimeoutMs: 60,
        metrics: journal.metrics,
      });
      let blocker: Knex.Transaction | undefined;
      let watchdog: ReturnType<typeof setTimeout> | undefined;
      try {
        await timed.ensureReady();
        await timed.query.ensureReady();
        const previous = (await readDb.raw('show statement_timeout')).rows[0]
          .statement_timeout;
        const pid = (await readDb.raw('select pg_backend_pid() as pid')).rows[0]
          .pid;
        blocker = await db.transaction();
        await blocker.raw(
          'lock table catalog_history_entities in access exclusive mode',
        );
        let watchdogReleased = false;
        watchdog = setTimeout(() => {
          watchdogReleased = true;
          void blocker?.rollback();
        }, 5000);

        // Act
        const result =
          operation === 'entities'
            ? timed.query.getEntities({})
            : timed.query.getKinds({});

        // Assert: cancellation must happen while the lock is still held.
        await expect(result).rejects.toMatchObject({ code: '57014' });
        expect(watchdogReleased).toBe(false);
        expect(
          (await readDb.raw('show statement_timeout')).rows[0]
            .statement_timeout,
        ).toBe(previous);
        expect(
          (await readDb.raw('select pg_backend_pid() as pid')).rows[0].pid,
        ).toBe(pid);
        expect(await db('pg_locks').where({ pid, granted: false })).toEqual([]);
        expect(
          journal
            .values('catalog.history.query.operation.duration')
            .map(point => point.attributes),
        ).toEqual([{ operation, outcome: 'timeout' }]);
      } finally {
        if (watchdog) clearTimeout(watchdog);
        await blocker?.rollback();
        await blocker?.executionPromise;
        await timed.shutdown();
        await readDb.destroy();
      }
    },
  );
});
