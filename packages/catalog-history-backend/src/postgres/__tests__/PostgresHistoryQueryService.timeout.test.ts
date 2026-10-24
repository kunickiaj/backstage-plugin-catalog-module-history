import { randomUUID } from 'node:crypto';
import { TestDatabases } from '@backstage/backend-test-utils';
import { knex, type Knex } from 'knex';
import { PostgresHistoryStore } from '../PostgresHistoryStore';

jest.setTimeout(30000);

const entityRef = 'user:default/alice';
const methods = ['timeline', 'feed', 'versions', 'detail'] as const;
type ReadMethod = (typeof methods)[number];

function read(store: PostgresHistoryStore, method: ReadMethod, id: string) {
  switch (method) {
    case 'timeline':
      return store.query.getEntityTimeline({ entityRef });
    case 'feed':
      return store.query.getChangeFeed({});
    case 'versions':
      return store.query.getEntityVersions({ entityRef });
    case 'detail':
      return store.query.getEntityVersion({ entityRef, id });
    default:
      throw new Error(`Unknown read method ${method}`);
  }
}

async function timeoutSetting(db: Knex) {
  const result = await db.raw(
    "select setting::integer as timeout from pg_settings where name = 'statement_timeout'",
  );
  return result.rows[0].timeout as number;
}

// Observe real PostgreSQL state on the very connection executing each SELECT.
// The wrapper delegates every production query unchanged, including failures.
function observeReads(db: Knex) {
  const observations: Array<{ timeout: number; tx: string; pid: number }> = [];
  const prototype = Object.getPrototypeOf(db.client);
  const original = prototype.query;
  const spy = jest
    .spyOn(prototype, 'query')
    .mockImplementation(async function observeQuery(
      this: Knex.Client,
      ...args: unknown[]
    ) {
      const [conn, q] = args as [unknown, { sql: string }];
      if (
        /^(select|with)\b/i.test(q.sql) &&
        q.sql.includes('catalog_history_entities')
      ) {
        const probe = await original.call(this, conn, {
          sql: "select setting::integer as timeout, txid_current()::text as tx, pg_backend_pid() as pid from pg_settings where name = 'statement_timeout'",
          bindings: [],
        });
        observations.push(probe.response.rows[0]);
      }
      return original.call(this, conn, q);
    });
  return { observations, restore: () => spy.mockRestore() };
}

describe('PostgresHistoryStore query deadline validation', () => {
  it.each([undefined, 0, 1, 2147483647])('accepts %s', queryTimeoutMs => {
    // Arrange: construction must not acquire a database connection.
    const db = {} as Knex;
    // Act / Assert: public constructor accepts the documented boundaries.
    expect(
      () => new PostgresHistoryStore(db, { queryTimeoutMs }),
    ).not.toThrow();
  });

  it.each([null, NaN, Infinity, -Infinity, -1, 0.5, 2147483648])(
    'rejects %s before database access',
    queryTimeoutMs => {
      // Arrange
      const db = {} as Knex;
      // Act / Assert
      expect(
        () =>
          new PostgresHistoryStore(db, {
            queryTimeoutMs: queryTimeoutMs as number,
          }),
      ).toThrow();
    },
  );
});

describe('PostgresHistoryStore PostgreSQL read deadlines', () => {
  const databases = TestDatabases.create({ ids: ['POSTGRES_16'] });
  let fixture: Knex;
  let db: Knex;
  let id: string;

  beforeEach(async () => {
    fixture = await databases.init('POSTGRES_16');
    db = knex({ ...fixture.client.config, pool: { min: 0, max: 1 } });
    const store = new PostgresHistoryStore(db);
    await store.ensureReady();
    await store.recordCycle({
      cycleId: randomUUID(),
      provider: 'timeout-test',
      source: 'provider',
      mutationType: 'full',
      startedAt: new Date('2026-01-01T00:00:00Z'),
      finishedAt: new Date('2026-01-01T00:00:00Z'),
      inserts: [
        {
          entityRef,
          kind: 'User',
          namespace: 'default',
          name: 'alice',
          etag: 'one',
          metadata: {},
          spec: {},
        },
      ],
      updates: [],
      deletes: [],
      unchangedCount: 0,
    });
    const row = await db('catalog_history_entities').first('id');
    id = String(row.id);
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await db.destroy();
  });

  it.each(methods)(
    'applies the default inside the %s SELECT and restores the session',
    async method => {
      // Arrange: schema preparation is outside the observed read operation.
      const store = new PostgresHistoryStore(db);
      await store.query.ensureReady();
      const previous = await timeoutSetting(db);
      const probe = observeReads(db);
      // Act
      const result = await read(store, method, id);
      probe.restore();
      // Assert: detail has two separately executed SELECTs in one transaction.
      expect(result).toBeDefined();
      expect(probe.observations).toHaveLength(method === 'detail' ? 2 : 1);
      expect(probe.observations.map(value => value.timeout)).toEqual(
        method === 'detail' ? [10000, 10000] : [10000],
      );
      expect(new Set(probe.observations.map(value => value.tx)).size).toBe(1);
      expect(await timeoutSetting(db)).toBe(previous);
    },
  );

  it.each([0, 5000])(
    'never relaxes a stricter session limit with plugin limit %s',
    async queryTimeoutMs => {
      // Arrange: mutate only this fixture pool's single session.
      const previous = await timeoutSetting(db);
      await db.raw("select set_config('statement_timeout', '750', false)");
      const store = new PostgresHistoryStore(db, { queryTimeoutMs });
      await store.query.ensureReady();
      const probe = observeReads(db);
      try {
        // Act
        await read(store, 'timeline', id);
        probe.restore();
        // Assert
        expect(probe.observations.map(value => value.timeout)).toEqual([750]);
        expect(await timeoutSetting(db)).toBe(750);
      } finally {
        probe.restore();
        await db.raw("select set_config('statement_timeout', ?, false)", [
          String(previous),
        ]);
      }
    },
  );

  it.each(methods)(
    'cancels blocked %s reads without releasing the blocker and reuses a one-connection pool',
    async method => {
      // Arrange: prepare before taking a lock so migrations are not the timed read.
      const store = new PostgresHistoryStore(db, { queryTimeoutMs: 100 });
      await store.query.ensureReady();
      const previous = await timeoutSetting(db);
      const [{ pid }] = (await db.raw('select pg_backend_pid() as pid')).rows;
      const blocker = await fixture.transaction();
      await blocker.raw(
        'lock table catalog_history_entities in access exclusive mode',
      );
      let watchdogReleased = false;
      const watchdog = setTimeout(() => {
        watchdogReleased = true;
        void blocker.rollback();
      }, 5000);
      try {
        // Act / Assert: repeated cancellation must finish while the lock is held.
        for (let attempt = 0; attempt < 2; attempt += 1) {
          await expect(read(store, method, id)).rejects.toMatchObject({
            code: '57014',
          });
          expect(watchdogReleased).toBe(false);
          const activity = await fixture('pg_stat_activity')
            .where({ pid })
            .first();
          expect(activity.state).toBe('idle');
          const waiting = await fixture('pg_locks').where({
            pid,
            granted: false,
          });
          expect(waiting).toEqual([]);
          expect(await timeoutSetting(db)).toBe(previous);
          expect(
            (await db.raw('select pg_backend_pid() as pid')).rows[0].pid,
          ).toBe(pid);
        }
      } finally {
        clearTimeout(watchdog);
        await blocker.rollback();
        await blocker.executionPromise;
      }
    },
  );

  it('restores a caller transaction setting before releasing the successful savepoint', async () => {
    // Arrange
    await db.transaction(async outer => {
      await outer.raw("select set_config('statement_timeout', '4000', true)");
      const store = new PostgresHistoryStore(outer, { queryTimeoutMs: 100 });
      await store.query.ensureReady();
      const probe = observeReads(db);
      try {
        // Act
        await read(store, 'detail', id);
        probe.restore();
        // Assert: SET LOCAL alone would leak the child setting into this parent.
        expect(probe.observations.map(value => value.timeout)).toEqual([
          100, 100,
        ]);
        expect(await timeoutSetting(outer)).toBe(4000);
        expect((await outer.raw('select 1 as usable')).rows[0].usable).toBe(1);
      } finally {
        probe.restore();
      }
    });
  });

  it('rolls back a failed savepoint without masking 57014 or poisoning the caller transaction', async () => {
    // Arrange
    await db.transaction(async outer => {
      await outer.raw("select set_config('statement_timeout', '4000', true)");
      const store = new PostgresHistoryStore(outer, { queryTimeoutMs: 100 });
      await store.query.ensureReady();
      const blocker = await fixture.transaction();
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
        await expect(read(store, 'timeline', id)).rejects.toMatchObject({
          code: '57014',
        });
        // Assert
        expect(watchdogReleased).toBe(false);
        expect(await timeoutSetting(outer)).toBe(4000);
        expect((await outer.raw('select 1 as usable')).rows[0].usable).toBe(1);
      } finally {
        clearTimeout(watchdog);
        await blocker.rollback();
        await blocker.executionPromise;
      }
    });
  });

  it('does not apply read deadlines to capture writes or current etag loads', async () => {
    // Arrange
    const previous = await timeoutSetting(db);
    const store = new PostgresHistoryStore(db, { queryTimeoutMs: 1 });
    await store.ensureReady();
    const statements: string[] = [];
    const listener = (query: { sql: string }) => statements.push(query.sql);
    const probe = observeReads(db);
    db.on('query', listener);
    try {
      // Act
      await store.recordCycle({
        cycleId: randomUUID(),
        provider: 'empty',
        source: 'provider',
        mutationType: 'full',
        startedAt: new Date('2026-01-02T00:00:00Z'),
        finishedAt: new Date('2026-01-02T00:00:00Z'),
        inserts: [],
        updates: [],
        deletes: [],
        unchangedCount: 0,
      });
      const etags = await store.loadCurrentEtags('timeout-test');
      // Assert
      expect(etags.get(entityRef)).toBe('one');
      expect(probe.observations.map(value => value.timeout)).toEqual([
        previous,
      ]);
      expect(
        statements.filter(sql =>
          /set_config|set\s+(local\s+)?statement_timeout/i.test(sql),
        ),
      ).toEqual([]);
    } finally {
      db.off('query', listener);
      probe.restore();
    }
  });
});
