import { randomUUID } from 'node:crypto';
import { TestDatabases } from '@backstage/backend-test-utils';
import { knex, type Knex } from 'knex';
import { PostgresHistoryStore } from '../PostgresHistoryStore';
import { metricsJournal } from './metricsJournal';

jest.setTimeout(30000);

async function timeoutSetting(db: Knex): Promise<number> {
  const result = await db.raw(
    "select setting::integer as timeout from pg_settings where name = 'statement_timeout'",
  );
  return result.rows[0].timeout;
}

// Observe the real connection immediately before each production SELECT.
// All production SQL still executes unchanged against the owned fixture DB.
function observeReads(db: Knex) {
  const observations: Array<{ timeout: number; table: string }> = [];
  const prototype = Object.getPrototypeOf(db.client);
  const original = prototype.query;
  const spy = jest
    .spyOn(prototype, 'query')
    .mockImplementation(async function observeQuery(
      this: Knex.Client,
      ...args: unknown[]
    ) {
      const [connection, query] = args as [unknown, { sql: string }];
      if (
        /^select\b/i.test(query.sql) &&
        /catalog_history_(cycles|entities)/.test(query.sql)
      ) {
        const probe = await original.call(this, connection, {
          sql: "select setting::integer as timeout from pg_settings where name = 'statement_timeout'",
          bindings: [],
        });
        observations.push({
          timeout: probe.response.rows[0].timeout,
          table: query.sql.includes('catalog_history_cycles')
            ? 'cycles'
            : 'entities',
        });
      }
      return original.call(this, connection, query);
    });
  return { observations, restore: () => spy.mockRestore() };
}

describe('PostgresHistoryQueryService cycle read deadlines', () => {
  const databases = TestDatabases.create({ ids: ['POSTGRES_16'] });
  let fixture: Knex;
  let db: Knex;
  let cycleId: string;

  beforeEach(async () => {
    fixture = await databases.init('POSTGRES_16');
    db = knex({ ...fixture.client.config, pool: { min: 0, max: 1 } });
    cycleId = randomUUID();
    const store = new PostgresHistoryStore(db);
    await store.recordCycle({
      cycleId,
      provider: 'private-deadline-provider',
      source: 'provider',
      mutationType: 'full',
      startedAt: new Date('2026-10-25T00:00:00Z'),
      finishedAt: new Date('2026-10-25T00:00:00Z'),
      inserts: [
        {
          entityRef: 'component:default/private-name',
          kind: 'Component',
          namespace: 'default',
          name: 'private-name',
          etag: 'one',
          metadata: {},
          spec: {},
        },
      ],
      updates: [],
      deletes: [],
      unchangedCount: 0,
    });
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    try {
      await db?.destroy();
    } finally {
      await fixture?.destroy();
    }
  });

  it.each(['list', 'detail'] as const)(
    'applies the default 10s deadline to every %s SELECT and restores the session',
    async method => {
      // Arrange: schema initialization is outside observations.
      const store = new PostgresHistoryStore(db);
      await store.query.ensureReady();
      const previous = await timeoutSetting(db);
      const probe = observeReads(db);
      try {
        // Act
        if (method === 'list') await store.query.listCycles({});
        else await store.query.getCycle({ cycleId });

        // Assert
        expect(probe.observations).toEqual(
          method === 'list'
            ? [{ timeout: 10000, table: 'cycles' }]
            : [
                { timeout: 10000, table: 'cycles' },
                { timeout: 10000, table: 'entities' },
              ],
        );
        expect(await timeoutSetting(db)).toBe(previous);
      } finally {
        probe.restore();
      }
    },
  );

  it.each([0, 5000])(
    'respects a stricter database default with plugin timeout %s on both routes',
    async queryTimeoutMs => {
      // Arrange: alter only this test's one-connection pool.
      const previous = await timeoutSetting(db);
      await db.raw("select set_config('statement_timeout', '750', false)");
      const store = new PostgresHistoryStore(db, { queryTimeoutMs });
      await store.query.ensureReady();
      const probe = observeReads(db);
      try {
        // Act
        await store.query.listCycles({});
        await store.query.getCycle({ cycleId });

        // Assert
        expect(
          probe.observations.map(observation => observation.timeout),
        ).toEqual([750, 750, 750]);
        expect(await timeoutSetting(db)).toBe(750);
      } finally {
        probe.restore();
        await db.raw("select set_config('statement_timeout', ?, false)", [
          String(previous),
        ]);
      }
    },
  );

  it('leaves the database default unchanged when plugin deadlines are disabled', async () => {
    // Arrange
    const previous = await timeoutSetting(db);
    const store = new PostgresHistoryStore(db, { queryTimeoutMs: 0 });
    await store.query.ensureReady();
    const probe = observeReads(db);
    try {
      // Act
      await store.query.listCycles({});
      await store.query.getCycle({ cycleId });

      // Assert
      expect(
        probe.observations.map(observation => observation.timeout),
      ).toEqual([previous, previous, previous]);
      expect(await timeoutSetting(db)).toBe(previous);
    } finally {
      probe.restore();
    }
  });

  it.each([
    {
      method: 'list',
      table: 'catalog_history_cycles',
      operation: 'cycles',
      reads: ['cycles'],
    },
    {
      method: 'detail',
      table: 'catalog_history_cycles',
      operation: 'cycle_detail',
      reads: ['cycles'],
    },
    {
      method: 'detail',
      table: 'catalog_history_entities',
      operation: 'cycle_detail',
      reads: ['cycles', 'entities'],
    },
  ])(
    'cancels blocked $method on $table and reuses the same clean connection',
    async ({ method, table, operation, reads }) => {
      // Arrange: the transaction locks only this test's isolated database.
      const journal = metricsJournal();
      const store = new PostgresHistoryStore(db, {
        queryTimeoutMs: 80,
        metrics: journal.metrics,
      });
      await store.query.ensureReady();
      const previous = await timeoutSetting(db);
      const [{ pid }] = (await db.raw('select pg_backend_pid() as pid')).rows;
      const blocker = await fixture.transaction();
      let watchdogReleased = false;
      const watchdog = setTimeout(() => {
        watchdogReleased = true;
        void blocker.rollback();
      }, 5000);
      const probe = observeReads(db);
      try {
        await blocker.raw('lock table ?? in access exclusive mode', [table]);

        // Act / Assert: cancellation must complete before the lock is released.
        const result =
          method === 'list'
            ? store.query.listCycles({})
            : store.query.getCycle({ cycleId });
        await expect(result).rejects.toMatchObject({ code: '57014' });
        expect(watchdogReleased).toBe(false);
        expect(probe.observations).toEqual(
          reads.map(read => ({ table: read, timeout: 80 })),
        );
        expect(await timeoutSetting(db)).toBe(previous);
        expect(
          (await db.raw('select pg_backend_pid() as pid, 1 as reusable'))
            .rows[0],
        ).toEqual({ pid, reusable: 1 });
        expect(
          await fixture('pg_locks').where({ pid, granted: false }),
        ).toEqual([]);
        expect(
          await fixture('pg_stat_activity').where({ pid }).first('state'),
        ).toEqual({ state: 'idle' });
        const points = journal.values(
          'catalog.history.query.operation.duration',
        );
        expect(points.map(point => point.attributes)).toEqual(
          reads.map((_, index) => ({
            operation,
            outcome: index === reads.length - 1 ? 'timeout' : 'success',
          })),
        );
        expect(JSON.stringify(points)).not.toContain(cycleId);
        expect(JSON.stringify(points)).not.toContain(
          'private-deadline-provider',
        );
      } finally {
        probe.restore();
        clearTimeout(watchdog);
        await blocker.rollback();
        await blocker.executionPromise;
      }

      // Assert: after releasing the owned lock the original API succeeds again.
      const recovered =
        method === 'list'
          ? (await store.query.listCycles({})).items
          : (await store.query.getCycle({ cycleId })).changes.items;
      expect(recovered).toHaveLength(1);
    },
  );
});
