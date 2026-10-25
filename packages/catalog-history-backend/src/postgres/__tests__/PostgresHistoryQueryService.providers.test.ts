import { Buffer } from 'node:buffer';
import { randomUUID } from 'node:crypto';
import { TestDatabases } from '@backstage/backend-test-utils';
import { InputError } from '@backstage/errors';
import type { HistoryProviderSearchRequest } from '@kunickiaj/backstage-plugin-catalog-history-common';
import type {
  CycleInput,
  EntityRow,
} from '@kunickiaj/backstage-plugin-catalog-history-node';
import { knex, type Knex } from 'knex';
import { PostgresHistoryQueryService } from '../PostgresHistoryQueryService';
import { PostgresHistoryStore } from '../PostgresHistoryStore';
import { metricsJournal } from './metricsJournal';

jest.setTimeout(30000);

const at = '2026-07-07T00:00:00Z';
const entityRef = 'component:default/service';

function entity(name = 'service', kind = 'Component'): EntityRow {
  return {
    entityRef: `${kind.toLowerCase()}:default/${name}`,
    kind,
    namespace: 'default',
    name,
    etag: 'one',
    metadata: { name, description: 'private-snapshot-payload' },
    spec: {},
  };
}

function cycle(
  provider: string,
  options: Partial<CycleInput> = {},
): CycleInput {
  return {
    cycleId: randomUUID(),
    provider,
    source: 'provider',
    mutationType: 'delta',
    startedAt: new Date(at),
    finishedAt: new Date(at),
    inserts: [entity()],
    updates: [],
    deletes: [],
    unchangedCount: 0,
    ...options,
  };
}

function encode(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

describe('PostgresHistoryQueryService provider discovery', () => {
  const databases = TestDatabases.create({ ids: ['POSTGRES_16'] });
  let db: Knex;
  let store: PostgresHistoryStore;
  let service: PostgresHistoryQueryService;

  beforeEach(async () => {
    db = await databases.init('POSTGRES_16');
    store = new PostgresHistoryStore(db);
    service = store.query;
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    // Release each case's pool before parallel suites need these connections.
    await db?.destroy();
  });

  it('initializes a new schema on the first request and shares readiness across concurrent calls', async () => {
    // Arrange: do not prepare the schema through a writer first.
    const requests = [{}, { prefix: 'missing' }];

    // Act
    const pages = await Promise.all(
      requests.map(request => service.getProviders(request)),
    );
    await store.recordCycle(cycle('visible'));
    const populated = await service.getProviders({});

    // Assert
    expect(pages).toEqual([
      { items: [], nextCursor: undefined },
      { items: [], nextCursor: undefined },
    ]);
    expect(populated.items).toEqual(['visible']);
  });

  it('finds distinct names beyond the first history page, not only names on loaded events', async () => {
    // Arrange: the desired provider is older than 150 events from another name.
    await store.recordCycle(cycle('remote-match'));
    await store.recordCycle(
      cycle('recent', {
        finishedAt: new Date('2026-07-08T00:00:00Z'),
        inserts: Array.from({ length: 150 }, (_, index) =>
          entity(`recent-${index}`),
        ),
      }),
    );
    const history = await service.getChangeFeed({});

    // Act
    const page = await service.getProviders({ prefix: 'REMOTE' });
    const all = await service.getProviders({});
    const missing = await service.getProviders({ prefix: 'absent' });

    // Assert
    expect(history.items).toHaveLength(25);
    expect(history.items.every(item => item.provider === 'recent')).toBe(true);
    expect(page).toEqual({ items: ['remote-match'], nextCursor: undefined });
    expect(all.items).toEqual(['recent', 'remote-match']);
    expect(missing).toEqual({ items: [], nextCursor: undefined });
  });

  it('uses 25 by default, caps at 100, and paginates distinct original names without overlap', async () => {
    // Arrange: duplicates must not consume the limit+1 lookahead.
    const names = Array.from(
      { length: 105 },
      (_, index) => `provider-${String(index).padStart(3, '0')}`,
    );
    for (const name of names) {
      await store.recordCycle(
        cycle(name, { inserts: [entity('one'), entity('two')] }),
      );
    }

    // Act
    const first = await service.getProviders({ prefix: 'provider-' });
    const second = await service.getProviders({
      prefix: 'provider-',
      cursor: first.nextCursor,
      limit: 100,
    });
    const repeated = await service.getProviders({
      prefix: 'provider-',
      cursor: first.nextCursor,
      limit: 100,
    });
    const capped = await service.getProviders({ limit: 1000 });
    const tail = await service.getProviders({
      cursor: capped.nextCursor,
      limit: 100,
    });

    // Assert
    expect(first.items).toEqual(names.slice(0, 25));
    expect(first.nextCursor).toEqual(expect.any(String));
    expect(second.items).toEqual(names.slice(25));
    expect(second.nextCursor).toBeUndefined();
    expect(repeated).toEqual(second);
    expect(capped.items).toEqual(names.slice(0, 100));
    expect(capped.nextCursor).toEqual(expect.any(String));
    expect(tail).toEqual({ items: names.slice(100), nextCursor: undefined });
  });

  it('keeps mixed case, empty names, and whitespace in C-order cursor pagination', async () => {
    // Arrange: empty provider names are legal capture data, not absent anchors.
    const names = ['', ' ', '  padded  ', 'ALPHA', 'Alpha', 'alpha'];
    for (const name of [...names].reverse())
      await store.recordCycle(cycle(name));

    // Act
    const first = await service.getProviders({ limit: 1 });
    const second = await service.getProviders({
      prefix: '',
      limit: 2,
      cursor: first.nextCursor,
    });
    const third = await service.getProviders({
      limit: 10,
      cursor: second.nextCursor,
    });
    const mixed = await service.getProviders({ prefix: 'aLpHa', limit: 2 });
    const mixedTail = await service.getProviders({
      prefix: 'aLpHa',
      cursor: mixed.nextCursor,
    });
    const whitespace = await service.getProviders({ prefix: '  ' });

    // Assert
    expect(first.items).toEqual(['']);
    expect(first.nextCursor).toEqual(expect.any(String));
    expect([...first.items, ...second.items, ...third.items]).toEqual(names);
    expect(third.nextCursor).toBeUndefined();
    expect(mixed.items).toEqual(['ALPHA', 'Alpha']);
    expect(mixedTail).toEqual({ items: ['alpha'], nextCursor: undefined });
    expect(whitespace.items).toEqual(['  padded  ']);
  });

  it.each(['%', '_', '\\', "'", "'; DROP TABLE catalog_history_entities; --"])(
    'matches %j as literal prefix text rather than wildcard or SQL',
    async prefix => {
      // Arrange
      const name = `${prefix}literal`;
      await store.recordCycle(cycle(name));
      await store.recordCycle(cycle('ordinary'));
      await store.recordCycle(cycle(`x${name}`));

      // Act
      const page = await service.getProviders({ prefix });
      const absent = await service.getProviders({ prefix: `${prefix}missing` });

      // Assert
      expect(page.items).toEqual([name]);
      expect(absent.items).toEqual([]);
    },
  );

  it('uses PostgreSQL LOWER for non-ASCII prefixes without accent folding or a prefix length cap', async () => {
    // Arrange
    const names = ['Éclair', 'école', 'eclair', '猫-provider'];
    const longPrefix = 'x'.repeat(1025);
    for (const name of [...names, `${longPrefix}tail`])
      await store.recordCycle(cycle(name));
    const expected = await db('catalog_history_entities')
      .select('provider')
      .whereRaw(
        'LEFT(LOWER(provider), char_length(LOWER(?::text))) = LOWER(?::text)',
        ['é', 'é'],
      )
      .orderByRaw('provider COLLATE "C"');

    // Act
    const accented = await service.getProviders({ prefix: 'é' });
    const ideograph = await service.getProviders({ prefix: '猫' });
    const long = await service.getProviders({ prefix: longPrefix });

    // Assert: the database locale, not JavaScript localeCompare, defines folding.
    expect(accented.items).toEqual(expected.map(row => row.provider));
    expect(accented.items).toContain('école');
    expect(accented.items).not.toContain('eclair');
    expect(ideograph.items).toEqual(['猫-provider']);
    expect(long.items).toEqual([`${longPrefix}tail`]);
  });

  it('filters observations before distinct names, including tombstones but excluding heartbeat-only cycles', async () => {
    // Arrange: provider names deliberately collide with source enum strings.
    await store.recordCycle(
      cycle('provider', {
        source: 'processing',
        inserts: [],
        deletes: [entityRef],
      }),
    );
    await store.recordCycle(cycle('processing', { source: 'provider' }));
    await store.recordCycle(
      cycle('reconciler', {
        source: 'reconciler',
        inserts: [],
        updates: [entity()],
      }),
    );
    await store.recordCycle(
      cycle('heartbeat', { inserts: [], unchangedCount: 100 }),
    );
    await store.recordCycle(
      cycle('provider', { inserts: [entity('other', 'User')] }),
    );
    const request: HistoryProviderSearchRequest = {
      prefix: 'PRO',
      source: 'processing',
      entityRef,
      kind: 'cOmPoNeNt',
      op: 'delete',
      changedAfter: at,
      changedBefore: at,
    };

    // Act
    const combined = await service.getProviders(request);
    const sources = await Promise.all(
      ['provider', 'processing', 'reconciler'].map(source =>
        service.getProviders({ source: source as CycleInput['source'] }),
      ),
    );
    const missing = await service.getProviders({
      ...request,
      entityRef: `${entityRef}-other`,
    });
    const conflicting = await service.getProviders({
      ...request,
      kind: 'User',
    });
    const wrongOp = await service.getProviders({ ...request, op: 'insert' });
    const outside = await service.getProviders({
      ...request,
      changedBefore: '2026-07-06T23:59:59Z',
      changedAfter: undefined,
    });
    const all = await service.getProviders({});

    // Assert
    expect(combined.items).toEqual(['provider']);
    expect(sources.map(page => page.items)).toEqual([
      ['processing', 'provider'],
      ['provider'],
      ['reconciler'],
    ]);
    expect([
      missing.items,
      conflicting.items,
      wrongOp.items,
      outside.items,
    ]).toEqual([[], [], [], []]);
    expect(all.items).toEqual(['processing', 'provider', 'reconciler']);
  });

  it.each(['2026-07-07T00:00:00.000999Z', '2026-07-07T02:00:00.000999+02:00'])(
    'preserves microsecond precision and inclusive bounds %s through cursor pages',
    async bound => {
      // Arrange: capture uses Date; only these precision fixtures need raw timestamps.
      for (const [name, fraction] of [
        ['before', '000500'],
        ['equal-a', '000999'],
        ['equal-b', '000999'],
        ['later', '001000'],
      ]) {
        const input = cycle(name);
        await store.recordCycle(input);
        await db('catalog_history_entities')
          .where({ cycle_id: input.cycleId })
          .update({ changed_at: `2026-07-07T00:00:00.${fraction}Z` });
      }
      const scope = { changedAfter: bound, changedBefore: bound };

      // Act
      const after = await service.getProviders({ changedAfter: bound });
      const before = await service.getProviders({ changedBefore: bound });
      const equal = await service.getProviders({ ...scope, limit: 1 });
      const tail = await service.getProviders({
        ...scope,
        cursor: equal.nextCursor,
      });

      // Assert
      expect(after.items).toEqual(['equal-a', 'equal-b', 'later']);
      expect(before.items).toEqual(['before', 'equal-a', 'equal-b']);
      expect(equal.items).toEqual(['equal-a']);
      expect(equal.nextCursor).toEqual(expect.any(String));
      expect(tail).toEqual({ items: ['equal-b'], nextCursor: undefined });
    },
  );

  const context: HistoryProviderSearchRequest = {
    prefix: 'scope-',
    source: 'processing',
    entityRef,
    kind: 'Component',
    op: 'update',
    changedAfter: at,
    changedBefore: at,
  };

  async function scopedCursor() {
    for (const name of ['scope-a', 'scope-b']) {
      await store.recordCycle(
        cycle(name, { source: 'processing', inserts: [], updates: [entity()] }),
      );
    }
    return service.getProviders({ ...context, limit: 1 });
  }

  it('continues with every active filter and a different page size', async () => {
    // Arrange
    const first = await scopedCursor();
    await store.recordCycle(cycle('scope-c', { source: 'provider' }));

    // Act
    const next = await service.getProviders({
      ...context,
      cursor: first.nextCursor,
      limit: 10,
    });

    // Assert
    expect(first.items).toEqual(['scope-a']);
    expect(first.nextCursor).toEqual(expect.any(String));
    expect(next).toEqual({ items: ['scope-b'], nextCursor: undefined });
  });

  it.each<Partial<HistoryProviderSearchRequest>>([
    { prefix: 'different' },
    { source: 'provider' },
    { entityRef: `${entityRef}-different` },
    { kind: 'User' },
    { op: 'delete' },
    { changedAfter: '2026-07-06T00:00:00Z' },
    { changedBefore: '2026-07-08T00:00:00Z' },
  ])('rejects a cursor reused with changed context %j', async changed => {
    // Arrange
    const first = await scopedCursor();

    // Act
    const result = service.getProviders({
      ...context,
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
    { cursor: '' },
    { cursor: 'not-base64!' },
    { cursor: encode(null) },
    { cursor: encode([]) },
    { cursor: Buffer.from('{').toString('base64url') },
    { cursor: encode({ changedAt: at, id: '1' }) },
    { changedAfter: 'not-a-date' },
    { changedBefore: '2026-07-07' },
  ])('rejects invalid input %j with InputError', async input => {
    // Arrange
    const request: HistoryProviderSearchRequest = input;

    // Act
    const result = service.getProviders(request);

    // Assert
    await expect(result).rejects.toBeInstanceOf(InputError);
  });

  it.each([
    { tag: 'history' },
    { version: 2 },
    { version: '1' },
    { lastName: 42 },
    { lastName: null },
    { scope: 'different' },
    { scope: null },
  ])(
    'rejects malformed provider cursor fields %j without exposing payloads',
    async fields => {
      // Arrange: mutate a genuine cursor, not a guessed wire format.
      const first = await scopedCursor();
      expect(first.nextCursor).toEqual(expect.any(String));
      const payload: unknown = JSON.parse(
        Buffer.from(first.nextCursor!, 'base64url').toString('utf8'),
      );
      if (!payload || typeof payload !== 'object')
        throw new Error('Expected cursor object');
      const cursor = encode({ ...payload, ...fields });

      // Act
      const result = service.getProviders({ ...context, cursor });

      // Assert
      await expect(result).rejects.toBeInstanceOf(InputError);
      await expect(result).rejects.not.toThrow(cursor);
    },
  );

  it('keeps exact history-provider filtering and existing event/timeline cursors unchanged', async () => {
    // Arrange
    await store.recordCycle(
      cycle('Alpha', { inserts: [entity()], updates: [entity()] }),
    );

    // Act
    const discovered = await service.getProviders({ prefix: 'Al' });
    const exact = await service.getChangeFeed({ provider: 'Al' });
    const feed = await service.getChangeFeed({ provider: 'Alpha', limit: 1 });
    const feedTail = await service.getChangeFeed({
      provider: 'Alpha',
      limit: 1,
      cursor: feed.nextCursor,
    });
    const timeline = await service.getEntityTimeline({
      entityRef,
      provider: 'Alpha',
      limit: 1,
    });
    const timelineTail = await service.getEntityTimeline({
      entityRef,
      provider: 'Alpha',
      limit: 1,
      cursor: timeline.nextCursor,
    });
    const wrongKind = service.getProviders({ cursor: timeline.nextCursor });

    // Assert
    expect(discovered.items).toEqual(['Alpha']);
    expect(exact.items).toEqual([]);
    expect(feed.items).toHaveLength(1);
    expect(feedTail.items).toHaveLength(1);
    expect(feedTail.items[0].id).not.toBe(feed.items[0].id);
    expect(timeline.items).toHaveLength(1);
    expect(timelineTail.items).toHaveLength(1);
    expect(timelineTail.items[0].id).not.toBe(timeline.items[0].id);
    await expect(wrongKind).rejects.toBeInstanceOf(InputError);
  });

  it('executes one parameterized metadata-only SELECT with limit+1 and fixed providers metrics', async () => {
    // Arrange
    const prefix = "private-query-prefix'_%\\";
    await store.recordCycle(cycle(`${prefix}a`));
    await store.recordCycle(cycle(`${prefix}b`));
    const journal = metricsJournal();
    const observedStore = new PostgresHistoryStore(db, {
      metrics: journal.metrics,
    });
    await observedStore.query.ensureReady();
    const feed = jest.spyOn(observedStore.query, 'getChangeFeed');
    const statements: Array<{ sql: string; bindings?: readonly unknown[] }> =
      [];
    const listener = (query: { sql: string; bindings?: readonly unknown[] }) =>
      statements.push(query);
    db.on('query', listener);
    try {
      // Act
      const page = await observedStore.query.getProviders({ prefix, limit: 1 });

      // Assert: transaction and timeout control statements are not discovery SELECTs.
      const selects = statements.filter(
        query =>
          /^(select|with)\b/i.test(query.sql) &&
          query.sql.includes('catalog_history_entities'),
      );
      expect(selects).toHaveLength(1);
      expect(selects[0].sql).toMatch(/distinct/i);
      expect(selects[0].sql).not.toMatch(
        /count\s*\(|\*|metadata|spec|relations|status_items/i,
      );
      expect(selects[0].sql).not.toContain(prefix);
      expect(selects[0].bindings).toEqual(expect.arrayContaining([prefix, 2]));
      expect(feed).not.toHaveBeenCalled();
      expect(page.items).toEqual([`${prefix}a`]);
      expect(page.nextCursor).toEqual(expect.any(String));
      expect(
        journal
          .values('catalog.history.query.operations')
          .map(point => point.attributes),
      ).toEqual([{ operation: 'providers', outcome: 'success' }]);
      expect(JSON.stringify(journal.points)).not.toContain(prefix);
      expect(JSON.stringify(page)).not.toContain('private-snapshot-payload');
    } finally {
      db.off('query', listener);
      await observedStore.shutdown();
    }
  });

  it.each(['create', 'add', 'record'] as const)(
    'isolates metrics SDK %s failures from discovery',
    async failure => {
      // Arrange
      await store.recordCycle(cycle('visible'));
      const journal = metricsJournal(failure);
      const observedStore = new PostgresHistoryStore(db, {
        metrics: journal.metrics,
      });
      try {
        // Act
        const result = await observedStore.query.getProviders({});

        // Assert
        expect(result.items).toEqual(['visible']);
      } finally {
        await observedStore.shutdown();
      }
    },
  );

  it('cancels a blocked providers SELECT and restores and reuses its one-connection session', async () => {
    // Arrange: all schema work finishes before taking the fixture-only lock.
    await store.recordCycle(cycle('visible'));
    const readDb = knex({ ...db.client.config, pool: { min: 0, max: 1 } });
    const journal = metricsJournal();
    const timed = new PostgresHistoryStore(readDb, {
      queryTimeoutMs: 80,
      metrics: journal.metrics,
    });
    await timed.ensureReady();
    await timed.query.ensureReady();
    const previous = (await readDb.raw('show statement_timeout')).rows[0]
      .statement_timeout;
    const pid = (await readDb.raw('select pg_backend_pid() as pid')).rows[0]
      .pid;
    const blocker = await db.transaction();
    await blocker.raw(
      'lock table catalog_history_entities in access exclusive mode',
    );
    let watchdogReleased = false;
    const watchdog = setTimeout(() => {
      watchdogReleased = true;
      void blocker.rollback();
    }, 5000);
    try {
      // Act
      const result = timed.query.getProviders({});

      // Assert: cancellation completes while the lock is still held.
      await expect(result).rejects.toMatchObject({ code: '57014' });
      expect(watchdogReleased).toBe(false);
      expect(
        (await readDb.raw('show statement_timeout')).rows[0].statement_timeout,
      ).toBe(previous);
      expect(
        (await readDb.raw('select pg_backend_pid() as pid')).rows[0].pid,
      ).toBe(pid);
      expect((await db('pg_stat_activity').where({ pid }).first()).state).toBe(
        'idle',
      );
      expect(await db('pg_locks').where({ pid, granted: false })).toEqual([]);
      expect(
        journal
          .values('catalog.history.query.operations')
          .map(point => point.attributes),
      ).toEqual([{ operation: 'providers', outcome: 'timeout' }]);
    } finally {
      clearTimeout(watchdog);
      await blocker.rollback();
      await blocker.executionPromise;
      await timed.shutdown();
      await readDb.destroy();
    }
  });
});
