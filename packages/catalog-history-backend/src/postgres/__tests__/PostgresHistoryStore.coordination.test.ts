import { fork, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { TestDatabases } from '@backstage/backend-test-utils';
import { knex, KnexTimeoutError, type Knex } from 'knex';
import type {
  CycleInput,
  ProviderMutationStore,
} from '@kunickiaj/backstage-plugin-catalog-history-node';
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

jest.setTimeout(60000);
const REF = 'component:default/example';

function cycle(version: string, options: Partial<CycleInput> = {}): CycleInput {
  return {
    cycleId: randomUUID(),
    provider: 'p',
    source: 'provider',
    mutationType: 'full',
    startedAt: new Date('2099-01-01'),
    finishedAt: new Date('2099-01-01'),
    inserts: [
      {
        entityRef: REF,
        kind: 'component',
        namespace: 'default',
        name: 'example',
        etag: version,
        metadata: { name: 'example' },
        spec: {},
      },
    ],
    updates: [],
    deletes: [],
    unchangedCount: 0,
    ...options,
  };
}

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>(r => {
    resolve = r;
  });
  return { promise, resolve };
}

async function waitForBarrier(promise: Promise<void>, label: string) {
  let timeout!: ReturnType<typeof setTimeout>;
  try {
    await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new Error(`Did not reach ${label}`)),
          10000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

function worker(
  connection: Knex.PgConnectionConfig | string,
  options: Record<string, unknown>,
) {
  const child = fork(
    path.resolve(__dirname, '../fixtures/providerMutationWorker.cjs'),
    [],
    {
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    },
  );
  const messages: Array<{ type: string; message?: string }> = [];
  const listeners = new Set<() => void>();
  let diagnostics = '';
  child.stderr!.on('data', value => {
    diagnostics += value;
  });
  child.on('message', message => {
    messages.push(message as (typeof messages)[number]);
    listeners.forEach(f => f());
  });
  const exited = new Promise<void>(resolve =>
    child.once('exit', () => {
      listeners.forEach(f => f());
      resolve();
    }),
  );
  const wait = async (type: string): Promise<void> => {
    let resolve!: () => void;
    let reject!: (error: Error) => void;
    const completed = new Promise<void>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    const check = () => {
      const error = messages.find(message => message.type === 'error');
      if (error) reject(new Error(error.message));
      else if (messages.some(message => message.type === type)) resolve();
      else if (child.exitCode !== null || child.signalCode !== null)
        reject(new Error(`Worker exited before ${type}: ${diagnostics}`));
    };
    const timeout = setTimeout(
      () => reject(new Error(`Worker did not reach ${type}: ${diagnostics}`)),
      20000,
    );
    listeners.add(check);
    check();
    try {
      await completed;
    } finally {
      clearTimeout(timeout);
      listeners.delete(check);
    }
  };
  child.send({
    type: 'start',
    connection: copyTestDatabaseConnection(connection),
    provider: 'p',
    mutationType: 'delta',
    ...options,
  });
  return { child, wait, exited, messages };
}

describe('test database connection copies', () => {
  it('preserves a non-enumerable password through object spread and JSON IPC without changing the source', () => {
    // Arrange: Knex hides passwords before test code receives its config.
    const source: Knex.PgConnectionConfig = {
      host: 'localhost',
      database: 'synthetic',
    };
    Object.defineProperty(source, 'password', {
      value: 'synthetic-test-password',
      enumerable: false,
    });
    // Act
    const copy = copyTestDatabaseConnection(source);
    const spread = { ...copy, application_name: 'synthetic-worker' };
    const ipc = JSON.parse(JSON.stringify({ connection: copy })).connection;
    // Assert: compare booleans so failures never print connection credentials.
    expect(spread.password === source.password).toBe(true);
    expect(ipc.password === source.password).toBe(true);
    expect(copy).not.toBe(source);
    expect(
      Object.getOwnPropertyDescriptor(source, 'password')?.enumerable,
    ).toBe(false);
    expect(Object.keys(source)).not.toContain('password');
    expect(ipc.host).toBe(source.host);
    expect(ipc.database).toBe(source.database);
  });

  it('keeps connection URLs intact and does not invent passwords for passwordless configs', () => {
    // Arrange
    const url = 'postgres://localhost/synthetic';
    const passwordless = { host: 'localhost', database: 'synthetic' };
    // Act
    const copiedUrl = copyTestDatabaseConnection(url);
    const ipc = JSON.parse(
      JSON.stringify(copyTestDatabaseConnection(passwordless)),
    );
    // Assert
    expect(copiedUrl).toEqual({ connectionString: url });
    expect(ipc).toEqual(passwordless);
    expect(Object.hasOwn(ipc, 'password')).toBe(false);
  });
});

describe('provider mutation coordination across pools and processes', () => {
  const databases = TestDatabases.create({ ids: ['POSTGRES_16'] });
  let db: Knex;
  let otherDb: Knex;
  let first: PostgresHistoryStore;
  let second: PostgresHistoryStore;
  const children: ChildProcess[] = [];

  beforeEach(async () => {
    db = await databases.init('POSTGRES_16');
    otherDb = knex({
      client: 'pg',
      connection: db.client.config.connection,
      pool: { min: 0, max: 3 },
    });
    first = new PostgresHistoryStore(db);
    second = new PostgresHistoryStore(otherDb);
    await Promise.all([first.ensureReady(), second.ensureReady()]);
    await db.schema.createTable('synthetic_catalog', table => {
      table.text('provider').primary();
      table.text('version').notNullable();
    });
  });

  afterEach(async () => {
    await Promise.all(
      children.splice(0).map(
        child =>
          new Promise<void>(resolve => {
            if (child.exitCode !== null || child.signalCode !== null) {
              resolve();
              return;
            }
            child.once('exit', () => resolve());
            child.kill('SIGKILL');
          }),
      ),
    );
    await Promise.all([first.shutdown(), second.shutdown()]);
    await Promise.all([otherDb.destroy(), db.destroy()]);
  });

  it('keeps an old full baseline and a new delta ordered in separate OS processes', async () => {
    // Arrange: each worker loads both production classes and owns its own pool.
    const old = worker(db.client.config.connection, {
      version: 'old',
      mutationType: 'full',
      pause: true,
    });
    children.push(old.child);
    await old.wait('accepted');
    await old.wait('baseline');
    const newer = worker(db.client.config.connection, { version: 'new' });
    children.push(newer.child);
    await newer.wait('attempting');
    await newer.wait('lock-timeout');
    await newer.wait('lock-retry');
    expect(
      newer.messages.filter(message => message.type === 'recording-error'),
    ).toEqual([]);
    // Act: an unrelated provider must finish while p holds its lock.
    const unrelated = worker(db.client.config.connection, {
      provider: 'unrelated',
      version: 'independent',
    });
    children.push(unrelated.child);
    await unrelated.wait('done');
    expect(newer.messages.some(message => message.type === 'accepted')).toBe(
      false,
    );
    old.child.send({ type: 'release' });
    await Promise.all([old.wait('done'), newer.wait('done')]);
    // Assert: the later delta remains latest in the catalog and history.
    expect(
      await db('synthetic_catalog').where({ provider: 'p' }).first('version'),
    ).toEqual({ version: 'new' });
    expect(
      (await first.loadCurrentEtags('p', { source: 'provider' })).get(REF),
    ).toBe('new');
    expect((await first.loadCurrentEtags('unrelated')).get(REF)).toBe(
      'independent',
    );
    await Promise.all([old.exited, newer.exited, unrelated.exited]);
    expect(
      [...old.messages, ...newer.messages, ...unrelated.messages].filter(
        message => message.type === 'recording-error',
      ),
    ).toEqual([]);
    const persistedCycles = await db('catalog_history_cycles')
      .where({ provider: 'p', source: 'provider' })
      .orderBy('started_at');
    expect(persistedCycles.map(row => row.mutation_type)).toEqual([
      'full',
      'delta',
    ]);
    const persistedEntities = await db('catalog_history_entities')
      .where({ provider: 'p', source: 'provider' })
      .orderBy('id')
      .select('cycle_id', 'entity_ref', 'etag', 'op');
    expect(persistedEntities).toEqual([
      {
        cycle_id: persistedCycles[0].cycle_id,
        entity_ref: REF,
        etag: 'old',
        op: 'insert',
      },
      {
        cycle_id: persistedCycles[1].cycle_id,
        entity_ref: REF,
        etag: 'new',
        op: 'update',
      },
    ]);
  });

  it('releases a process-owned lock when the owner is terminated', async () => {
    // Arrange
    const old = worker(db.client.config.connection, {
      version: 'old',
      mutationType: 'full',
      pause: true,
    });
    children.push(old.child);
    await old.wait('baseline');
    // Act
    old.child.kill('SIGKILL');
    await old.exited;
    const newer = worker(db.client.config.connection, { version: 'new' });
    children.push(newer.child);
    await newer.wait('done');
    // Assert: the abandoned history transaction did not commit.
    expect((await first.loadCurrentEtags('p')).get(REF)).toBe('new');
    expect(
      await db('catalog_history_cycles')
        .where({ provider: 'p' })
        .count('* as count'),
    ).toEqual([{ count: '1' }]);
    await newer.exited;
  });

  it('releases coordination after catalog forwarding rejects without recording a cycle', async () => {
    // Arrange
    const failed = worker(db.client.config.connection, {
      version: 'rejected',
      failForward: true,
    });
    children.push(failed.child);
    // Act
    await failed.wait('rejected');
    await failed.exited;
    const newer = worker(db.client.config.connection, { version: 'accepted' });
    children.push(newer.child);
    await newer.wait('done');
    // Assert
    expect((await first.loadCurrentEtags('p')).get(REF)).toBe('accepted');
    expect(
      await db('catalog_history_cycles')
        .where({ provider: 'p' })
        .count('* as count'),
    ).toEqual([{ count: '1' }]);
    await newer.exited;
  });

  it('uses database timestamps despite reversed caller clocks and preserves source isolation', async () => {
    // Arrange
    const future = cycle('old');
    const past = cycle('new', {
      startedAt: new Date('2000-01-01'),
      finishedAt: new Date('2000-01-01'),
    });
    await first.recordCycle(
      cycle('processed', {
        source: 'processing',
        finishedAt: new Date('2100-01-01'),
      }),
    );
    // Act
    await first.withProviderMutation('p', scoped => scoped.recordCycle(future));
    await second.withProviderMutation('p', async scoped => {
      expect((await scoped.loadCurrentEtags('p')).get(REF)).toBe('old');
      await scoped.recordCycle(past);
    });
    // Assert
    const cycles = await db('catalog_history_cycles')
      .where({ provider: 'p', source: 'provider' })
      .orderBy('finished_at');
    expect(cycles.map(row => row.cycle_id)).toEqual([
      future.cycleId,
      past.cycleId,
    ]);
    expect(+cycles[1].finished_at).toBeGreaterThan(+cycles[0].finished_at);
    expect(+cycles[0].started_at).toBeLessThan(+future.startedAt);
    expect(
      (await first.loadCurrentEtags('p', { source: 'provider' })).get(REF),
    ).toBe('new');
    expect(
      (await first.loadCurrentEtags('p', { source: 'processing' })).get(REF),
    ).toBe('processed');
  });

  it('rolls back a failed recording and permits a later pool to acquire the same provider', async () => {
    // Arrange
    const invalid = cycle('invalid', {
      inserts: [{ ...cycle('x').inserts[0], kind: undefined! }],
    });
    // Act
    await expect(
      first.withProviderMutation('p', scoped => scoped.recordCycle(invalid)),
    ).rejects.toThrow();
    const result = await second.withProviderMutation('p', async scoped => {
      const baseline = await scoped.loadCurrentEtags('p');
      await scoped.recordCycle(cycle('recovered'));
      return baseline.size;
    });
    // Assert
    expect(result).toBe(0);
    expect(
      await db('catalog_history_cycles').where({ cycle_id: invalid.cycleId }),
    ).toEqual([]);
    expect((await first.loadCurrentEtags('p')).get(REF)).toBe('recovered');
  });

  it('lets unrelated providers commit while another provider callback is paused', async () => {
    // Arrange
    const entered = gate();
    const release = gate();
    const holding = first.withProviderMutation('p', async scoped => {
      entered.resolve();
      await release.promise;
      await scoped.recordCycle(cycle('held'));
    });
    await entered.promise;
    // Act
    try {
      await second.withProviderMutation('other', scoped =>
        scoped.recordCycle(cycle('other', { provider: 'other' })),
      );
      // Assert
      expect((await second.loadCurrentEtags('other')).get(REF)).toBe('other');
      expect(await second.loadCurrentEtags('p')).toEqual(new Map());
    } finally {
      release.resolve();
      await holding;
    }
  });

  it('retries lock contention after five seconds without invoking the waiter or expiring the owner', async () => {
    // Arrange: the owner has no callback deadline because a catalog write
    // cannot be canceled safely when the waiting caller reaches its timeout.
    const entered = gate();
    const release = gate();
    const retried = gate();
    const createDatabase = jest.requireActual<typeof coordinationDatabase>(
      '../providerCoordinationDatabase',
    ).createProviderCoordinationDatabase;
    const factory = jest
      .mocked(coordinationDatabase.createProviderCoordinationDatabase)
      .mockImplementation(source => {
        const dedicated = createDatabase(source);
        if (source === otherDb) {
          let attempts = 0;
          dedicated.on('query', query => {
            if (query.sql.includes('pg_advisory_xact_lock') && ++attempts === 2)
              retried.resolve();
          });
        }
        return dedicated;
      });
    let holderFinished = false;
    const holding = first.withProviderMutation('p', async scoped => {
      entered.resolve();
      await release.promise;
      await scoped.recordCycle(cycle('owner'));
      holderFinished = true;
    });
    await entered.promise;
    const blocked = jest.fn(async (scoped: ProviderMutationStore) =>
      scoped.recordCycle(cycle('waiter')),
    );
    // Act
    const began = performance.now();
    const waiting = second.withProviderMutation('p', blocked);
    let waiterSettled = false;
    const outcome = Promise.allSettled([waiting]).then(result => {
      waiterSettled = true;
      return result;
    });
    try {
      await waitForBarrier(retried.promise, 'second PostgreSQL lock attempt');
      // Assert
      expect(performance.now() - began).toBeGreaterThanOrEqual(4500);
      expect(blocked).not.toHaveBeenCalled();
      expect(waiterSettled).toBe(false);
      expect(holderFinished).toBe(false);
      expect(await db('catalog_history_cycles')).toEqual([]);
    } finally {
      release.resolve();
      await holding;
      await outcome;
      factory.mockImplementation(createDatabase);
    }
    expect(await outcome).toEqual([{ status: 'fulfilled', value: undefined }]);
    expect(blocked).toHaveBeenCalledTimes(1);
    expect((await first.loadCurrentEtags('p')).get(REF)).toBe('waiter');
    expect(await db('catalog_history_cycles').count('* as count')).toEqual([
      { count: '2' },
    ]);
  }, 15000);

  it('retains the timestamp floor after retention deletes every old cycle', async () => {
    // Arrange: future legacy timestamps must remain below later commits even
    // after retention removes every cycle from which the floor was inferred.
    await first.recordCycle(
      cycle('legacy', {
        inserts: [],
        startedAt: new Date('2200-01-01'),
        finishedAt: new Date('2200-01-01'),
      }),
    );
    const before = cycle('before', { inserts: [] });
    await first.withProviderMutation('p', scoped => scoped.recordCycle(before));
    const saved = await db('catalog_history_cycles')
      .where({ cycle_id: before.cycleId })
      .first();
    // Act
    await first.applyRetention({
      cutoff: new Date('2300-01-01'),
      batchSize: 10,
    });
    expect(await db('catalog_history_cycles')).toEqual([]);
    const after = cycle('after', { inserts: [] });
    await second.withProviderMutation('p', scoped => scoped.recordCycle(after));
    // Assert
    const next = await db('catalog_history_cycles')
      .where({ cycle_id: after.cycleId })
      .first();
    expect(+next.started_at).toBeGreaterThan(+saved.finished_at);
    expect(+next.finished_at).toBeGreaterThan(+next.started_at);
  });

  it('leaves a single-slot shared catalog pool available during the coordinated callback', async () => {
    // Arrange: the catalog and history may use the same Backstage database
    // service. Ownership must not reserve its only connection across forwarding.
    const shared = knex({
      client: 'pg',
      connection: db.client.config.connection,
      pool: { min: 0, max: 1 },
      acquireConnectionTimeout: 1500,
    });
    const store = new PostgresHistoryStore(shared);
    await store.ensureReady();
    // Act
    try {
      const result = await store.withProviderMutation('p', async scoped => {
        const catalog = await shared.raw('SELECT 1 AS accepted');
        await scoped.recordCycle(cycle('shared-pool'));
        return catalog.rows[0].accepted;
      });
      // Assert
      expect(result).toBe(1);
      expect((await store.loadCurrentEtags('p')).get(REF)).toBe('shared-pool');
    } finally {
      await store.shutdown();
      await shared.destroy();
    }
  });

  it('orders coordinated rows above legacy history and continues preexisting timeline cursors', async () => {
    // Arrange
    await first.recordCycle(
      cycle('legacy-old', {
        startedAt: new Date('2199-01-01'),
        finishedAt: new Date('2199-01-01'),
      }),
    );
    await first.recordCycle(
      cycle('legacy-new', {
        startedAt: new Date('2200-01-01'),
        finishedAt: new Date('2200-01-01'),
      }),
    );
    const oldPage = await first.query.getEntityTimeline({
      entityRef: REF,
      limit: 1,
    });
    const oldFeed = await first.query.getChangeFeed({ limit: 1 });
    const oldCycles = await first.query.listCycles({ limit: 1 });
    expect(oldPage.nextCursor).toBeDefined();
    expect(oldFeed.nextCursor).toBeDefined();
    expect(oldCycles.nextCursor).toBeDefined();
    // Act
    await second.withProviderMutation('p', scoped =>
      scoped.recordCycle(cycle('coordinated')),
    );
    const newest = await first.query.getEntityTimeline({
      entityRef: REF,
      limit: 1,
    });
    const next = await first.query.getEntityTimeline({
      entityRef: REF,
      limit: 1,
      cursor: newest.nextCursor,
    });
    const continued = await first.query.getEntityTimeline({
      entityRef: REF,
      limit: 1,
      cursor: oldPage.nextCursor,
    });
    const newestFeed = await first.query.getChangeFeed({ limit: 1 });
    const continuedFeed = await first.query.getChangeFeed({
      limit: 1,
      cursor: oldFeed.nextCursor,
    });
    const newestCycles = await first.query.listCycles({ limit: 1 });
    const continuedCycles = await first.query.listCycles({
      limit: 1,
      cursor: oldCycles.nextCursor,
    });
    // Assert
    expect(newest.items.map(item => item.etag)).toEqual(['coordinated']);
    expect(next.items.map(item => item.etag)).toEqual(['legacy-new']);
    expect(continued.items.map(item => item.etag)).toEqual(['legacy-old']);
    expect(continued.nextCursor).toBeUndefined();
    expect(newestFeed.items.map(item => item.etag)).toEqual(['coordinated']);
    expect(continuedFeed.items.map(item => item.etag)).toEqual(['legacy-old']);
    expect(continuedFeed.nextCursor).toBeUndefined();
    expect(newestCycles.items.map(item => item.cycleId)).toEqual([
      newestFeed.items[0].cycleId,
    ]);
    expect(continuedCycles.items.map(item => item.cycleId)).toEqual([
      continuedFeed.items[0].cycleId,
    ]);
    expect(continuedCycles.nextCursor).toBeUndefined();
  });

  it('rejects reads and writes outside the provider scope and after its callback ends', async () => {
    // Arrange
    let escaped!: ProviderMutationStore;
    // Act
    await first.withProviderMutation('p', async scoped => {
      escaped = scoped;
      await expect(scoped.loadCurrentEtags('other')).rejects.toThrow(
        /provider/i,
      );
      await expect(
        scoped.loadCurrentEtags('p', { source: 'processing' }),
      ).rejects.toThrow(/source/i);
      await expect(
        scoped.recordCycle(cycle('wrong', { source: 'processing' })),
      ).rejects.toThrow(/source/i);
      await scoped.recordCycle(cycle('valid'));
    });
    // Assert
    await expect(escaped.loadCurrentEtags('p')).rejects.toThrow(/active/i);
    await expect(escaped.recordCycle(cycle('late'))).rejects.toThrow(/active/i);
    expect((await second.loadCurrentEtags('p')).get(REF)).toBe('valid');
    expect(await second.loadCurrentEtags('other')).toEqual(new Map());
  });

  it('rolls back an already recorded cycle when the callback subsequently fails', async () => {
    // Arrange
    const aborted = cycle('aborted');
    // Act
    await expect(
      first.withProviderMutation('p', async scoped => {
        await scoped.recordCycle(aborted);
        throw new Error('callback rejected');
      }),
    ).rejects.toThrow('callback rejected');
    await second.withProviderMutation('p', scoped =>
      scoped.recordCycle(cycle('committed')),
    );
    // Assert
    expect(
      await db('catalog_history_cycles').where({ cycle_id: aborted.cycleId }),
    ).toEqual([]);
    expect((await first.loadCurrentEtags('p')).get(REF)).toBe('committed');
  });

  it.each([
    [
      '55P03',
      () =>
        Object.assign(new Error('callback lock timeout'), { code: '55P03' }),
    ],
    [
      '57014',
      () =>
        Object.assign(new Error('callback statement timeout'), {
          code: '57014',
        }),
    ],
    [
      'KnexTimeoutError',
      () => new KnexTimeoutError('callback connection timeout'),
    ],
  ] as const)(
    'does not retry a callback that throws %s after recording',
    async (_label, makeError) => {
      // Arrange: callback failures can carry the same error codes as contention.
      const failure = makeError();
      const aborted = cycle('aborted');
      let invocations = 0;
      const work = jest.fn(async (scoped: ProviderMutationStore) => {
        // Fail promptly if a regression replays the callback, rather than leaving
        // an incorrectly retrying implementation in an infinite test loop.
        if (++invocations > 1)
          throw new Error('callback was unexpectedly repeated');
        await scoped.recordCycle(aborted);
        throw failure;
      });
      // Act
      await expect(first.withProviderMutation('p', work)).rejects.toBe(failure);
      const rolledBack = await db('catalog_history_cycles').where({
        cycle_id: aborted.cycleId,
      });
      await second.withProviderMutation('p', scoped =>
        scoped.recordCycle(cycle('recovered')),
      );
      // Assert
      expect(work).toHaveBeenCalledTimes(1);
      expect(rolledBack).toEqual([]);
      expect((await first.loadCurrentEtags('p')).get(REF)).toBe('recovered');
      expect(await db('catalog_history_cycles').count('* as count')).toEqual([
        { count: '1' },
      ]);
    },
  );

  it('does not replay the callback after an actual deferred PostgreSQL commit failure', async () => {
    // Arrange: this constraint trigger runs at COMMIT, after recordCycle and
    // the callback have both completed successfully. Its code resembles lock contention.
    await db.raw(`CREATE FUNCTION reject_test_history_commit() RETURNS trigger
      LANGUAGE plpgsql AS $$ BEGIN
        RAISE EXCEPTION 'synthetic deferred commit failure' USING ERRCODE = '55P03';
      END $$`);
    await db.raw(`CREATE CONSTRAINT TRIGGER reject_test_history_commit
      AFTER INSERT ON catalog_history_cycles DEFERRABLE INITIALLY DEFERRED
      FOR EACH ROW EXECUTE FUNCTION reject_test_history_commit()`);
    const aborted = cycle('aborted-at-commit');
    let invocations = 0;
    const work = jest.fn(async (scoped: ProviderMutationStore) => {
      if (++invocations > 1)
        throw new Error('callback was unexpectedly repeated');
      await scoped.recordCycle(aborted);
      return 'callback completed';
    });
    // Act
    await expect(first.withProviderMutation('p', work)).rejects.toMatchObject({
      code: '55P03',
      message: expect.stringContaining('synthetic deferred commit failure'),
    });
    const rolledBack = await db('catalog_history_cycles').where({
      cycle_id: aborted.cycleId,
    });
    await db.raw(
      'DROP TRIGGER reject_test_history_commit ON catalog_history_cycles',
    );
    await second.withProviderMutation('p', scoped =>
      scoped.recordCycle(cycle('recovered')),
    );
    // Assert
    expect(work).toHaveBeenCalledTimes(1);
    expect(rolledBack).toEqual([]);
    expect((await first.loadCurrentEtags('p')).get(REF)).toBe('recovered');
    expect(await db('catalog_history_cycles').count('* as count')).toEqual([
      { count: '1' },
    ]);
  });
});
