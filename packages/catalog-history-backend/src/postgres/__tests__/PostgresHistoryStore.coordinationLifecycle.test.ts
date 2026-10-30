import { randomUUID } from 'node:crypto';
import { TestDatabases } from '@backstage/backend-test-utils';
import { knex, type Knex } from 'knex';
import type { CycleInput } from '@kunickiaj/backstage-plugin-catalog-history-node';
import { PostgresHistoryStore } from '../PostgresHistoryStore';
import * as coordinationDatabase from '../providerCoordinationDatabase';
import { copyTestDatabaseConnection } from './copyTestDatabaseConnection';

jest.mock('../providerCoordinationDatabase', () => {
  const actual = jest.requireActual<typeof coordinationDatabase>(
    '../providerCoordinationDatabase',
  );
  return {
    ...actual,
    createProviderCoordinationDatabase: jest.fn(
      actual.createProviderCoordinationDatabase,
    ),
  };
});

jest.setTimeout(30000);

type Session = {
  query(sql: string): Promise<{ rows: Array<Record<string, string>> }>;
};

function heartbeat(): CycleInput {
  return {
    cycleId: randomUUID(),
    provider: 'p',
    source: 'provider',
    mutationType: 'full',
    startedAt: new Date('2000-01-01'),
    finishedAt: new Date('2000-01-01'),
    inserts: [],
    updates: [],
    deletes: [],
    unchangedCount: 0,
  };
}

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>(r => {
    resolve = r;
  });
  return { promise, resolve };
}

async function waitForBarrier(
  promise: Promise<void>,
  label: string,
  timeoutMs = 10000,
) {
  let timeout!: ReturnType<typeof setTimeout>;
  try {
    await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new Error(`Did not reach ${label}`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

async function timeouts(session: Session) {
  const result =
    await session.query(`SELECT current_setting('statement_timeout') AS statement,
    current_setting('lock_timeout') AS lock,
    current_setting('idle_in_transaction_session_timeout') AS idle`);
  return result.rows[0];
}

describe('dedicated provider coordination pool lifecycle', () => {
  const databases = TestDatabases.create({ ids: ['POSTGRES_16'] });
  let db: Knex;
  let shared: Knex;
  let store: PostgresHistoryStore;
  let sessions: Session[];
  let connection: jest.Mock;
  let applicationName: string;

  beforeEach(async () => {
    const actual = jest.requireActual<typeof coordinationDatabase>(
      '../providerCoordinationDatabase',
    );
    jest
      .mocked(coordinationDatabase.createProviderCoordinationDatabase)
      .mockImplementation(actual.createProviderCoordinationDatabase);
    db = await databases.init('POSTGRES_16');
    sessions = [];
    applicationName = `history-coordination-test-${randomUUID()}`;
    const settings = copyTestDatabaseConnection(db.client.config.connection);
    connection = jest.fn(async () => ({
      ...settings,
      application_name: applicationName,
    }));
    shared = knex({
      client: 'pg',
      // Knex detects providers with instanceof Function. Jest mock functions
      // originate in a different VM realm, so keep the actual provider native.
      connection: async () => connection(),
      searchPath: ['public'],
      acquireConnectionTimeout: 1500,
      pool: {
        min: 0,
        max: 1,
        afterCreate: (
          session: Session,
          done: (error: unknown, session: Session) => void,
        ) => {
          sessions.push(session);
          session
            .query(
              "SET statement_timeout = '12s'; SET lock_timeout = '4s'; SET idle_in_transaction_session_timeout = '45s'",
            )
            .then(
              () => done(null, session),
              error => done(error, session),
            );
        },
      },
    });
    store = new PostgresHistoryStore(shared);
    await store.ensureReady();
  });

  afterEach(async () => {
    await store?.shutdown().catch(() => {});
    await shared?.destroy();
    await db?.destroy();
  });

  it('does not create a coordination connection when shutdown precedes first use', async () => {
    // Arrange
    const callback = jest.fn();
    expect(sessions).toHaveLength(1);
    // Act
    await store.shutdown();
    await expect(store.withProviderMutation('p', callback)).rejects.toThrow(
      /shut.*down/i,
    );
    // Assert
    expect(callback).not.toHaveBeenCalled();
    expect(sessions).toHaveLength(1);
    expect(connection).toHaveBeenCalledTimes(1);
    expect((await shared.raw('SELECT 1 AS available')).rows).toEqual([
      { available: 1 },
    ]);
  });

  it('propagates a runtime pool creation failure promptly instead of retrying it as contention', async () => {
    // Arrange: the source pool is already healthy. Only the dedicated pool's
    // first credential-provider call fails while constructing its connection.
    const failure = Object.assign(
      new Error('synthetic credential provider failed'),
      { code: '28P01' },
    );
    connection.mockRejectedValueOnce(failure);
    const callback = jest.fn(async scoped => scoped.recordCycle(heartbeat()));
    // Act
    const outcome = Promise.allSettled([
      store.withProviderMutation('p', callback),
    ]);
    await waitForBarrier(
      outcome.then(() => undefined),
      'pool creation error propagation',
      2000,
    );
    const beforeRecovery = await db('catalog_history_cycles').count(
      '* as count',
    );
    const connectionAttempts = connection.mock.calls.length;
    await store.withProviderMutation('p', scoped =>
      scoped.recordCycle(heartbeat()),
    );
    // Assert
    expect(await outcome).toEqual([{ status: 'rejected', reason: failure }]);
    expect(callback).not.toHaveBeenCalled();
    expect(connectionAttempts).toBe(2);
    expect(beforeRecovery).toEqual([{ count: '0' }]);
    expect(await db('catalog_history_cycles').count('* as count')).toEqual([
      { count: '1' },
    ]);
    expect((await shared.raw('SELECT 1 AS available')).rows).toEqual([
      { available: 1 },
    ]);
  });

  it.each([false, true])(
    'retries saturation of a single-slot pool and stops pending retries on shutdown=%s',
    async stop => {
      // Arrange: different providers still contend for the same dedicated pool.
      const entered = gate();
      const release = gate();
      const retried = gate();
      const actual = jest.requireActual<typeof coordinationDatabase>(
        '../providerCoordinationDatabase',
      );
      jest
        .mocked(coordinationDatabase.createProviderCoordinationDatabase)
        .mockImplementation(source => {
          const dedicated = actual.createProviderCoordinationDatabase(source);
          let requests = 0;
          dedicated.client.pool.on('acquireRequest', () => {
            // Holder, first waiter attempt, then retry after its five-second timeout.
            if (++requests === 3) retried.resolve();
          });
          return dedicated;
        });
      const holding = store.withProviderMutation('p', async scoped => {
        entered.resolve();
        await release.promise;
        await scoped.recordCycle(heartbeat());
      });
      await entered.promise;
      const forward = jest.fn(async scoped => {
        await shared.raw('SELECT 1 AS catalog_forward');
        await scoped.recordCycle({ ...heartbeat(), provider: 'other' });
      });
      let settled = false;
      const result = Promise.allSettled([
        store.withProviderMutation('other', forward),
      ]).then(outcome => {
        settled = true;
        return outcome;
      });
      // Act
      let shutdown = Promise.resolve();
      try {
        await waitForBarrier(
          retried.promise,
          'second dedicated pool acquisition attempt',
        );
        // Assert: contention cannot turn into fail-open catalog forwarding.
        expect(forward).not.toHaveBeenCalled();
        expect(settled).toBe(false);
        expect(await db('catalog_history_cycles')).toEqual([]);
        if (stop) shutdown = store.shutdown();
      } finally {
        release.resolve();
        await holding;
        await shutdown;
        await result;
      }
      expect((await result)[0].status).toBe(stop ? 'rejected' : 'fulfilled');
      expect(forward).toHaveBeenCalledTimes(stop ? 0 : 1);
      expect(await db('catalog_history_cycles').count('* as count')).toEqual([
        { count: stop ? '1' : '2' },
      ]);
      expect((await shared.raw('SELECT 1 AS available')).rows).toEqual([
        { available: 1 },
      ]);
    },
    15000,
  );

  it.each([false, true])(
    'releases its pool and prevents reuse when shutdown hook fails=%s',
    async hookFails => {
      // Arrange: schema initialization uses only the source pool.
      expect(sessions).toHaveLength(1);
      const hooks = jest.fn(async () => {
        if (hookFails) throw new Error('shutdown hook failed');
      });
      store.addShutdownHook(hooks);
      await store.withProviderMutation('p', scoped =>
        scoped.recordCycle(heartbeat()),
      );
      expect(sessions).toHaveLength(2);
      await store.withProviderMutation('p', scoped =>
        scoped.recordCycle(heartbeat()),
      );
      expect(sessions).toHaveLength(2);
      // Act
      const [shutdown] = await Promise.allSettled([store.shutdown()]);
      expect(shutdown.status).toBe(hookFails ? 'rejected' : 'fulfilled');
      expect(
        shutdown.status === 'rejected' ? shutdown.reason.message : undefined,
      ).toBe(hookFails ? 'shutdown hook failed' : undefined);
      const callback = jest.fn();
      await expect(store.withProviderMutation('p', callback)).rejects.toThrow(
        /shut.*down/i,
      );
      // Assert: pool destruction must complete before shutdown settles, including
      // its failure path. The caller-owned source connection remains available.
      const alive = await db('pg_stat_activity')
        .where({ application_name: applicationName })
        .count('* as count');
      expect(alive).toEqual([{ count: '1' }]);
      expect((await shared.raw('SELECT 1 AS accepted')).rows).toEqual([
        { accepted: 1 },
      ]);
      expect(callback).not.toHaveBeenCalled();
      expect(hooks).toHaveBeenCalledTimes(1);
      expect(sessions).toHaveLength(2);
      expect(connection).toHaveBeenCalledTimes(2);
    },
  );

  it.each([false, true])(
    'preserves session setup and restores timeouts after callback rollback=%s',
    async rollback => {
      // Arrange
      const original = { statement: '12s', lock: '4s', idle: '45s' };
      expect(await timeouts(sessions[0])).toEqual(original);
      const input = heartbeat();
      // Act
      const work = store.withProviderMutation('p', async scoped => {
        expect(await timeouts(sessions[1])).toEqual({
          statement: '30s',
          lock: '5s',
          idle: '0',
        });
        expect(await timeouts(sessions[0])).toEqual(original);
        await shared.raw('SELECT 1');
        await scoped.recordCycle(input);
        if (rollback) throw new Error('synthetic callback failure');
      });
      const [result] = await Promise.allSettled([work]);
      expect(result.status).toBe(rollback ? 'rejected' : 'fulfilled');
      expect(
        result.status === 'rejected' ? result.reason.message : undefined,
      ).toBe(rollback ? 'synthetic callback failure' : undefined);
      // Assert
      expect(await timeouts(sessions[1])).toEqual(original);
      expect(await timeouts(sessions[0])).toEqual(original);
      expect(
        await db('catalog_history_cycles')
          .where({ cycle_id: input.cycleId })
          .count('* as count'),
      ).toEqual([{ count: rollback ? '0' : '1' }]);
      expect(connection).toHaveBeenCalledTimes(2);
    },
  );
});
