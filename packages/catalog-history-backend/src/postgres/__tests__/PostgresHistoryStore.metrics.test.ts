import { randomUUID } from 'node:crypto';
import { TestDatabases } from '@backstage/backend-test-utils';
import { knex, type Knex } from 'knex';
import type { CycleInput } from '@kunickiaj/backstage-plugin-catalog-history-node';
import { PostgresHistoryStore } from '../PostgresHistoryStore';
import * as schema from '../ensureSchema';
import { metricsJournal } from './metricsJournal';

jest.mock('../ensureSchema', () => {
  const actual = jest.requireActual('../ensureSchema');
  return {
    ...actual,
    ensureSchema: jest.fn((db: Knex) => actual.ensureSchema(db)),
  };
});

jest.setTimeout(30000);

const storageOperations = 'catalog.history.storage.operations';
const storageDuration = 'catalog.history.storage.operation.duration';
const persistence = 'catalog.history.storage.persistence.duration';
const captureWindow = 'catalog.history.capture.window.duration';
const lastSuccess = 'catalog.history.capture.last_success.timestamp';
const queryOperations = 'catalog.history.query.operations';
const queryDuration = 'catalog.history.query.operation.duration';
const initializations = 'catalog.history.schema.initializations';
const initializationDuration = 'catalog.history.schema.initialization.duration';
const initialized = 'catalog.history.schema.initialized';
const entityRef = 'user:default/private-person';
const methods = ['timeline', 'feed', 'versions', 'detail'] as const;

function cycle(overrides: Partial<CycleInput> = {}): CycleInput {
  return {
    cycleId: randomUUID(),
    provider: 'private-provider-name',
    source: 'provider',
    mutationType: 'full',
    startedAt: new Date('2026-01-01T00:00:00Z'),
    finishedAt: new Date('2026-01-01T00:00:37Z'),
    inserts: [
      {
        entityRef,
        kind: 'User',
        namespace: 'default',
        name: 'private-person',
        etag: 'private-etag',
        metadata: { description: 'private-payload' },
        spec: {},
      },
    ],
    updates: [],
    deletes: [],
    unchangedCount: 0,
    ...overrides,
  };
}

function read(
  store: PostgresHistoryStore,
  method: (typeof methods)[number],
  id = '1',
) {
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
      throw new Error('Unexpected method');
  }
}

describe('PostgresHistoryStore metrics', () => {
  const databases = TestDatabases.create({ ids: ['POSTGRES_16'] });
  let fixture: Knex;
  let db: Knex;
  let journal: ReturnType<typeof metricsJournal>;
  let store: PostgresHistoryStore;

  beforeEach(async () => {
    jest.mocked(schema.ensureSchema).mockClear();
    fixture = await databases.init('POSTGRES_16');
    db = knex({ ...fixture.client.config, pool: { min: 0, max: 1 } });
    journal = metricsJournal();
    store = new PostgresHistoryStore(db, { metrics: journal.metrics });
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await store?.shutdown();
    await db?.destroy();
  });

  it('creates the literal instruments and collects passive schema state without SQL', async () => {
    // Arrange: construction and collection must not initialize the database.
    const sql = jest.fn();
    db.on('query', sql);
    // Act
    const before = await journal.collect();
    const queriesBeforeCollection = sql.mock.calls.length;
    await store.ensureReady();
    await store.ensureReady();
    await store.query.ensureReady();
    await store.query.ensureReady();
    const queriesAfterInitialization = sql.mock.calls.length;
    const after = await journal.collect();
    // Assert: fixed names, units, and labels are independent of production constants.
    expect(journal.instruments).toEqual([
      { name: storageOperations, kind: 'counter', unit: '{operation}' },
      { name: storageDuration, kind: 'histogram', unit: 's' },
      { name: persistence, kind: 'histogram', unit: 's' },
      { name: captureWindow, kind: 'histogram', unit: 's' },
      { name: lastSuccess, kind: 'gauge', unit: 's' },
      { name: queryOperations, kind: 'counter', unit: '{operation}' },
      { name: queryDuration, kind: 'histogram', unit: 's' },
      { name: initializations, kind: 'counter', unit: '{initialization}' },
      { name: initializationDuration, kind: 'histogram', unit: 's' },
      { name: initialized, kind: 'gauge', unit: '1' },
    ]);
    expect(before).toEqual([
      { name: initialized, value: 0, attributes: { component: 'store' } },
      { name: initialized, value: 0, attributes: { component: 'query' } },
    ]);
    expect(queriesBeforeCollection).toBe(0);
    expect(sql).toHaveBeenCalledTimes(queriesAfterInitialization);
    expect(after).toEqual([
      { name: initialized, value: 1, attributes: { component: 'store' } },
      { name: initialized, value: 1, attributes: { component: 'query' } },
    ]);
    expect(journal.values(initializations)).toEqual([
      {
        name: initializations,
        value: 1,
        attributes: { component: 'store', outcome: 'success' },
      },
      {
        name: initializations,
        value: 1,
        attributes: { component: 'query', outcome: 'success' },
      },
    ]);
  });

  it('records committed captures and empty heartbeats without changing persisted times', async () => {
    // Arrange
    const input = cycle();
    const now = jest.spyOn(Date, 'now').mockReturnValue(1800000000000);
    // Act
    await store.recordCycle(input);
    const first = await journal.collect();
    now.mockReturnValue(1800000001000);
    await store.recordCycle(cycle({ inserts: [], unchangedCount: 9 }));
    const second = await journal.collect();
    const persistedCycle = await db('catalog_history_cycles')
      .where({ cycle_id: input.cycleId })
      .first();
    const persistedEntity = await db('catalog_history_entities').first();
    // Assert: capture time is input time; last success is wall time after persistence.
    expect(persistedCycle.started_at).toEqual(input.startedAt);
    expect(persistedCycle.finished_at).toEqual(input.finishedAt);
    expect(persistedEntity.changed_at).toEqual(input.finishedAt);
    expect(journal.values(captureWindow).map(point => point.value)).toEqual([
      37, 37,
    ]);
    expect(journal.values(persistence)).toHaveLength(2);
    expect(journal.values(storageOperations)).toEqual(
      [1, 1].map(value => ({
        name: storageOperations,
        value,
        attributes: {
          operation: 'record_cycle',
          source: 'provider',
          outcome: 'success',
        },
      })),
    );
    expect(first.filter(point => point.name === lastSuccess)).toEqual([
      {
        name: lastSuccess,
        value: 1800000000,
        attributes: { source: 'provider' },
      },
    ]);
    expect(second.filter(point => point.name === lastSuccess)).toEqual([
      {
        name: lastSuccess,
        value: 1800000001,
        attributes: { source: 'provider' },
      },
    ]);
    expect(
      await db('catalog_history_cycles').count('* as n').first(),
    ).toMatchObject({ n: '2' });
    for (const point of [
      ...journal.values(persistence),
      ...journal.values(storageDuration),
    ]) {
      expect(Number.isFinite(point.value)).toBe(true);
      expect(point.value).toBeGreaterThanOrEqual(0);
    }
  });

  it.each(['store', 'query'] as const)(
    'records failed %s initialization, retries once, and does not count cached awaits',
    async component => {
      // Arrange: inject one schema failure; the retry initializes real PostgreSQL.
      const error = new Error('private-initialization-error');
      const ensure = jest
        .mocked(schema.ensureSchema)
        .mockRejectedValueOnce(error);
      const subject = component === 'store' ? store : store.query;
      // Act / Assert
      await expect(subject.ensureReady()).rejects.toBe(error);
      expect(
        (await journal.collect()).filter(
          point =>
            point.name === initialized &&
            point.attributes.component === component,
        ),
      ).toEqual([{ name: initialized, value: 0, attributes: { component } }]);
      await Promise.all([subject.ensureReady(), subject.ensureReady()]);
      await subject.ensureReady();
      expect(ensure).toHaveBeenCalledTimes(2);
      expect(journal.values(initializations)).toEqual(
        ['error', 'success'].map(outcome => ({
          name: initializations,
          value: 1,
          attributes: { component, outcome },
        })),
      );
      expect(
        (await journal.collect()).filter(
          point =>
            point.name === initialized &&
            point.attributes.component === component,
        ),
      ).toEqual([{ name: initialized, value: 1, attributes: { component } }]);
      expect(
        journal.values(initializationDuration).map(point => point.attributes),
      ).toEqual(journal.values(initializations).map(point => point.attributes));
    },
  );

  it('does not advance last success when INSERT succeeds but deferred COMMIT fails, and can retry', async () => {
    // Arrange: one prior row satisfies a constraint which the next two-row capture violates only at COMMIT.
    await store.recordCycle(cycle());
    const before = (await journal.collect()).filter(
      point => point.name === lastSuccess,
    );
    await db.raw(
      'alter table catalog_history_entities add constraint metrics_commit_unique unique (cycle_id) deferrable initially deferred',
    );
    const input = cycle();
    input.inserts.push({
      ...input.inserts[0],
      entityRef: 'user:default/second',
      name: 'second',
    });
    const inserted = jest.fn();
    db.on('query-response', (_response, query) => {
      if (/insert into "catalog_history_entities"/.test(query.sql)) inserted();
    });
    // Act / Assert: the error is from the real commit, not the insert.
    await expect(store.recordCycle(input)).rejects.toMatchObject({
      code: '23505',
      constraint: 'metrics_commit_unique',
    });
    expect(inserted).toHaveBeenCalledTimes(1);
    expect(
      (await journal.collect()).filter(point => point.name === lastSuccess),
    ).toEqual(before);
    expect(
      await db('catalog_history_cycles').where({ cycle_id: input.cycleId }),
    ).toEqual([]);
    expect(
      await db('catalog_history_entities').where({ cycle_id: input.cycleId }),
    ).toEqual([]);
    expect(
      journal.values(persistence).map(point => point.attributes.outcome),
    ).toEqual(['success', 'error']);
    expect(
      journal.values(storageOperations).map(point => point.attributes.outcome),
    ).toEqual(['success', 'error']);
    expect(
      journal.values(captureWindow).map(point => point.attributes.outcome),
    ).toEqual(['success', 'error']);
    await db.raw(
      'alter table catalog_history_entities drop constraint metrics_commit_unique',
    );
    await store.recordCycle(input);
    expect(
      await db('catalog_history_entities').where({ cycle_id: input.cycleId }),
    ).toHaveLength(2);
  });

  it('does not report top-level persistence or last success for a caller-owned transaction that rolls back', async () => {
    // Arrange: schema creation must survive the caller's rollback.
    await store.ensureReady();
    jest.spyOn(Date, 'now').mockReturnValue(1800000000000);
    const nestedJournal = metricsJournal();
    const input = cycle();
    const rollbackMarker = new Error('caller-requested-rollback');
    let nestedStore: PostgresHistoryStore | undefined;
    const snapshots: Array<{
      phase: string;
      persistence: unknown[];
      lastSuccess: unknown[];
    }> = [];
    const collectSignals = async (phase: string) => ({
      phase,
      persistence: nestedJournal.values(persistence),
      lastSuccess: (await nestedJournal.collect()).filter(
        point => point.name === lastSuccess,
      ),
    });

    // Act: recordCycle releases its savepoint successfully; the caller then rolls back.
    try {
      await expect(
        db.transaction(async outer => {
          nestedStore = new PostgresHistoryStore(outer, {
            metrics: nestedJournal.metrics,
          });
          await nestedStore.recordCycle(input);
          expect(
            await outer('catalog_history_entities').where({
              cycle_id: input.cycleId,
            }),
          ).toHaveLength(1);
          snapshots.push(await collectSignals('outer pending'));
          throw rollbackMarker;
        }),
      ).rejects.toBe(rollbackMarker);
      snapshots.push(await collectSignals('outer rolled back'));
    } finally {
      // Close callbacks only after the caller-owned transaction has resolved.
      await nestedStore?.shutdown();
    }

    // Assert: savepoint success must not claim an outer commit acknowledgment.
    expect(
      await db('catalog_history_cycles').where({ cycle_id: input.cycleId }),
    ).toEqual([]);
    expect(
      await db('catalog_history_entities').where({ cycle_id: input.cycleId }),
    ).toEqual([]);
    expect(snapshots).toEqual([
      { phase: 'outer pending', persistence: [], lastSuccess: [] },
      { phase: 'outer rolled back', persistence: [], lastSuccess: [] },
    ]);
  });

  it('times the whole storage method and transaction through commit ACK, but only the query SQL phase', async () => {
    // Arrange: advance a manual monotonic clock at real execution boundaries, never sleep.
    let clock = 0;
    jest.spyOn(performance, 'now').mockImplementation(() => clock);
    await store.ensureReady();
    await store.query.ensureReady();
    clock = 0;
    const input = cycle();
    Object.defineProperty(input.inserts[0], 'metadata', {
      get: () => {
        clock += 2000;
        return { description: 'private-payload' };
      },
    });
    // A cached ensureReady is still part of the whole storage method, not persistence.
    const ready = store.ensureReady.bind(store);
    jest.spyOn(store, 'ensureReady').mockImplementation(async () => {
      clock += 1000;
      await ready();
    });
    db.on('query', query => {
      if (/^BEGIN/i.test(query.sql)) clock += 3000;
      if (/^select.*catalog_history_entities/i.test(query.sql)) clock += 2000;
    });
    const prototype = Object.getPrototypeOf(db.client);
    const original = prototype.query;
    jest.spyOn(prototype, 'query').mockImplementation(async function query(
      this: Knex.Client,
      ...args: unknown[]
    ) {
      const [connection, statement] = args as [
        unknown,
        string | { sql: string },
      ];
      const sql = typeof statement === 'string' ? statement : statement.sql;
      const result = await original.call(this, connection, statement);
      if (/^COMMIT/i.test(sql)) clock += 4000;
      return result;
    });
    // Act
    await store.recordCycle(input);
    // Assert: persistence includes mapping, transaction acquisition/control, and commit ACK.
    expect(journal.values(persistence)[0].value).toBe(9);
    expect(journal.values(storageDuration)[0].value).toBe(10);
    expect(journal.values(captureWindow)[0].value).toBe(37);

    // Arrange: query preparation and response mapping lie outside the SQL timer.
    clock = 0;
    const queryReady = store.query.ensureReady.bind(store.query);
    jest.spyOn(store.query, 'ensureReady').mockImplementation(async () => {
      clock += 1000;
      await queryReady();
    });
    const toISOString = Date.prototype.toISOString;
    jest
      .spyOn(Date.prototype, 'toISOString')
      .mockImplementation(function format(this: Date) {
        clock += 5000;
        return toISOString.call(this);
      });
    // Act
    const result = await store.query.getEntityTimeline({ entityRef });
    // Assert: SQL includes transaction control, but not preparation or mapping.
    expect(result.items).toHaveLength(1);
    expect(journal.values(queryDuration)[0].value).toBe(9);
    expect(clock).toBe(15000);
  });

  it('keeps last success absent while the transaction callback has run but COMMIT has not acknowledged', async () => {
    // Arrange: observe at COMMIT submission, delegating the real PostgreSQL commit unchanged.
    await store.ensureReady();
    const prototype = Object.getPrototypeOf(db.client);
    const original = prototype.query;
    const duringCommit: unknown[] = [];
    jest.spyOn(prototype, 'query').mockImplementation(async function query(
      this: Knex.Client,
      ...args: unknown[]
    ) {
      const [connection, statement] = args as [
        unknown,
        string | { sql: string },
      ];
      const sql = typeof statement === 'string' ? statement : statement.sql;
      if (/^COMMIT/i.test(sql)) duringCommit.push(...(await journal.collect()));
      return original.call(this, connection, statement);
    });
    // Act
    await store.recordCycle(cycle());
    const after = await journal.collect();
    // Assert
    expect(duringCommit).not.toEqual([]);
    expect(duringCommit).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ name: lastSuccess })]),
    );
    expect(after.filter(point => point.name === lastSuccess)).toHaveLength(1);
  });

  it.each([
    undefined,
    'provider',
    'processing',
    'reconciler',
    'private-invalid-source',
  ])(
    'labels baseline scope %s using only fixed sources on success and failure',
    async source => {
      // Arrange
      await store.recordCycle(cycle());
      const options =
        source === undefined
          ? undefined
          : { source: source as CycleInput['source'] };
      const expectedSource = source === undefined ? 'all' : source;
      const label =
        source === 'private-invalid-source' ? 'unknown' : expectedSource;
      // Act
      const current = await store.loadCurrentEtags(
        'private-provider-name',
        options,
      );
      const all = await store.loadAllCurrentEtags(options);
      await db.raw(
        'alter table catalog_history_entities rename column entity_ref to hidden_entity_ref',
      );
      try {
        await expect(
          store.loadCurrentEtags('private-provider-name', options),
        ).rejects.toMatchObject({ code: '42703' });
        await expect(store.loadAllCurrentEtags(options)).rejects.toMatchObject({
          code: '42703',
        });
      } finally {
        await db.raw(
          'alter table catalog_history_entities rename column hidden_entity_ref to entity_ref',
        );
      }
      // Assert
      expect(current.has(entityRef)).toBe(
        source === undefined || source === 'provider',
      );
      expect(all.has(entityRef)).toBe(
        source === undefined || source === 'provider',
      );
      expect(journal.values(storageOperations).slice(1)).toEqual(
        [
          ['load_current_etags', 'success'],
          ['load_all_current_etags', 'success'],
          ['load_current_etags', 'error'],
          ['load_all_current_etags', 'error'],
        ].map(([operation, outcome]) => ({
          name: storageOperations,
          value: 1,
          attributes: { operation, source: label, outcome },
        })),
      );
      expect(
        journal
          .values(storageDuration)
          .slice(1)
          .map(point => point.attributes),
      ).toEqual(
        journal
          .values(storageOperations)
          .slice(1)
          .map(point => point.attributes),
      );
    },
  );

  it.each(methods)(
    'counts real %s SQL success, SQL error, and blocked deadline separately',
    async method => {
      // Arrange: all initialization is outside the SQL-phase measurement.
      await store.recordCycle(cycle());
      await store.query.ensureReady();
      const { id } = await db('catalog_history_entities').first();
      // Act
      const result = await read(store, method, String(id));
      await db.raw(
        'alter table catalog_history_entities rename column entity_ref to hidden_entity_ref',
      );
      try {
        await expect(read(store, method, String(id))).rejects.toMatchObject({
          code: '42703',
        });
      } finally {
        await db.raw(
          'alter table catalog_history_entities rename column hidden_entity_ref to entity_ref',
        );
      }
      const timed = new PostgresHistoryStore(db, {
        metrics: journal.metrics,
        queryTimeoutMs: 50,
      });
      await timed.query.ensureReady();
      const previous = (await db.raw('show statement_timeout')).rows[0]
        .statement_timeout;
      const blocker = await fixture.transaction();
      try {
        await blocker.raw(
          'lock table catalog_history_entities in access exclusive mode',
        );
        await expect(read(timed, method, String(id))).rejects.toMatchObject({
          code: '57014',
        });
      } finally {
        await blocker.rollback();
        await blocker.executionPromise;
        await timed.shutdown();
      }
      // Assert: no provider, entity, SQL, payload, or error labels escape.
      expect(result).toBeDefined();
      expect(journal.values(queryOperations)).toEqual(
        ['success', 'error', 'timeout'].map(outcome => ({
          name: queryOperations,
          value: 1,
          attributes: { operation: method, outcome },
        })),
      );
      expect(
        journal.values(queryDuration).map(point => point.attributes),
      ).toEqual(journal.values(queryOperations).map(point => point.attributes));
      for (const point of journal.values(queryDuration)) {
        expect(Number.isFinite(point.value)).toBe(true);
        expect(point.value).toBeGreaterThanOrEqual(0);
      }
      expect(
        (await db.raw('show statement_timeout')).rows[0].statement_timeout,
      ).toBe(previous);
      expect(await store.loadCurrentEtags('private-provider-name')).toEqual(
        new Map([[entityRef, 'private-etag']]),
      );
    },
  );

  it('classifies a missing detail as not_found but excludes request validation from SQL metrics', async () => {
    // Arrange
    await store.query.ensureReady();
    // Act / Assert
    await expect(read(store, 'detail', '1')).rejects.toMatchObject({
      name: 'NotFoundError',
    });
    await expect(read(store, 'detail', 'not-an-id')).rejects.toThrow(
      'Invalid history row id',
    );
    await expect(
      store.query.getEntityTimeline({ entityRef, limit: -1 }),
    ).rejects.toThrow();
    expect(journal.values(queryOperations)).toEqual([
      {
        name: queryOperations,
        value: 1,
        attributes: { operation: 'detail', outcome: 'not_found' },
      },
    ]);
  });

  it.each([
    'create',
    'add',
    'record',
    'callback',
    'second_callback',
    'observe',
    'remove',
  ] as const)(
    'keeps SQL work and original PostgreSQL errors unchanged when SDK %s throws',
    async failure => {
      // Arrange
      const broken = metricsJournal(failure);
      const subject = new PostgresHistoryStore(db, { metrics: broken.metrics });
      const input = cycle();
      const entitySelects: string[] = [];
      db.on('query', query => {
        if (
          /^(select|with)/i.test(query.sql) &&
          query.sql.includes('catalog_history_entities')
        )
          entitySelects.push(query.sql);
      });
      let databaseError: unknown;
      const onError = (error: unknown) => {
        databaseError = error;
      };
      db.on('query-error', onError);
      // Act
      await subject.recordCycle(input);
      expect(await subject.loadCurrentEtags(input.provider)).toEqual(
        new Map([[entityRef, 'private-etag']]),
      );
      expect(await subject.query.getChangeFeed({})).toMatchObject({
        items: [{ entityRef }],
      });
      await expect(broken.collect()).resolves.toBeDefined();
      const duplicate = await subject.recordCycle(input).catch(error => error);
      await subject.shutdown();
      const afterShutdown = await broken.collect();
      // Assert: no retries, error replacement, or live callbacks after cleanup.
      expect(duplicate).toBe(databaseError);
      expect(duplicate).toMatchObject({ code: '23505' });
      expect(
        await db('catalog_history_cycles').count('* as n').first(),
      ).toMatchObject({ n: '1' });
      expect(afterShutdown).toEqual([]);
      expect(entitySelects).toHaveLength(2);
      expect(broken.removed).toHaveLength(
        {
          create: 0,
          add: 2,
          record: 2,
          callback: 1,
          second_callback: 2,
          observe: 2,
          remove: 2,
        }[failure],
      );
      db.removeListener('query-error', onError);
    },
  );

  it('keeps callbacks active during flush, removes them afterwards, and shuts down once', async () => {
    // Arrange
    await store.recordCycle(cycle());
    const flush = jest.fn(async () => {
      expect(
        (await journal.collect()).filter(point => point.name === lastSuccess),
      ).toHaveLength(1);
    });
    store.addShutdownHook(flush);
    // Act
    await store.shutdown();
    await store.shutdown();
    // Assert
    expect(flush).toHaveBeenCalledTimes(1);
    expect(journal.removed).toHaveLength(2);
    expect(await journal.collect()).toEqual([]);
  });

  it('preserves a flush error and skips owned destruction while still closing callbacks', async () => {
    // Arrange
    const destroy = jest.fn();
    const subject = new PostgresHistoryStore({ destroy } as unknown as Knex, {
      metrics: journal.metrics,
      ownsDatabase: true,
    });
    const error = new Error('private-flush-error');
    const flush = jest.fn(async () => {
      throw error;
    });
    subject.addShutdownHook(flush);
    // Act / Assert
    await expect(subject.shutdown()).rejects.toBe(error);
    await expect(subject.shutdown()).rejects.toBe(error);
    expect(flush).toHaveBeenCalledTimes(1);
    expect(destroy).not.toHaveBeenCalled();
    // This journal also belongs to the beforeEach store, so only the subject's two callbacks were removed.
    expect(journal.removed).toHaveLength(2);
  });
});

describe('PostgresHistoryStore constructor metrics validation', () => {
  it.each(['success', 'error'] as const)(
    'awaits owned destruction once on %s and closes callbacks without replacing its result',
    async outcome => {
      // Arrange
      const journal = metricsJournal('remove');
      const error = new Error('private-destroy-error');
      const destroy = jest.fn().mockResolvedValue(undefined);
      if (outcome === 'error') destroy.mockRejectedValue(error);
      const subject = new PostgresHistoryStore({ destroy } as unknown as Knex, {
        ownsDatabase: true,
        metrics: journal.metrics,
      });
      // Act
      const first = await subject.shutdown().catch(failure => failure);
      const second = await subject.shutdown().catch(failure => failure);
      // Assert: callback removal cannot hide the original database destruction error.
      const expected = outcome === 'error' ? error : undefined;
      expect(first).toBe(expected);
      expect(second).toBe(expected);
      expect(destroy).toHaveBeenCalledTimes(1);
      expect(journal.removed).toHaveLength(2);
      expect(await journal.collect()).toEqual([]);
    },
  );

  it.each([NaN, Infinity, -1, 0.5, 2147483648])(
    'rejects %s before creating instruments or callbacks',
    queryTimeoutMs => {
      // Arrange
      const journal = metricsJournal();
      // Act / Assert
      expect(
        () =>
          new PostgresHistoryStore({} as Knex, {
            metrics: journal.metrics,
            queryTimeoutMs,
          }),
      ).toThrow();
      expect(journal.instruments).toEqual([]);
      expect(journal.callbacks.size).toBe(0);
    },
  );

  it('allows a manual store with no metrics dependency', () => {
    // Arrange
    const db = {} as Knex;
    // Act
    const store = new PostgresHistoryStore(db);
    // Assert
    expect(store.query).toBeDefined();
  });
});
