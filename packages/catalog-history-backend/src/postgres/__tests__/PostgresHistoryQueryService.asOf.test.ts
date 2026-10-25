import { randomUUID } from 'node:crypto';
import { TestDatabases } from '@backstage/backend-test-utils';
import { InputError } from '@backstage/errors';
import { knex, type Knex } from 'knex';
import type { HistoryEntityAsOfRequest } from '@kunickiaj/backstage-plugin-catalog-history-common';
import type {
  CaptureSource,
  EntityRow,
} from '@kunickiaj/backstage-plugin-catalog-history-node';
import { PostgresHistoryStore } from '../PostgresHistoryStore';
import { metricsJournal } from './metricsJournal';

jest.setTimeout(30000);

const entityRef = 'user:default/alice';
const firstAt = '2026-07-07T00:00:01.000Z';
const secondAt = '2026-07-07T00:00:02.000Z';
const thirdAt = '2026-07-07T00:00:03.000Z';
const after = '2026-07-07T00:00:10.000Z';
const request = { entityRef, timestamp: after };

// Invalid runtime inputs stay local to tests; the public DTO requires timestamp.
function runtimeRequest(value: unknown): HistoryEntityAsOfRequest {
  return value as HistoryEntityAsOfRequest;
}

async function timeoutSetting(db: Knex): Promise<number> {
  const result = await db.raw(
    "select setting::integer as timeout from pg_settings where name = 'statement_timeout'",
  );
  return result.rows[0].timeout;
}

describe('PostgresHistoryQueryService as-of physical observations', () => {
  const databases = TestDatabases.create({ ids: ['POSTGRES_16'] });
  let fixture: Knex;
  let db: Knex;
  let store: PostgresHistoryStore;
  let journal: ReturnType<typeof metricsJournal>;

  beforeEach(async () => {
    fixture = await databases.init('POSTGRES_16');
    db = knex({ ...fixture.client.config, pool: { min: 0, max: 1 } });
    journal = metricsJournal();
    store = new PostgresHistoryStore(db, { metrics: journal.metrics });
    await store.ensureReady();
    await store.query.ensureReady();
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await store?.shutdown();
    await db?.destroy();
    await fixture?.destroy();
  });

  async function record(
    timestamp: string,
    options: {
      op?: 'insert' | 'update' | 'delete';
      source?: CaptureSource;
      provider?: string;
      fields?: Partial<EntityRow>;
      id?: string;
    } = {},
  ) {
    const cycleId = randomUUID();
    const op = options.op ?? 'insert';
    const row: EntityRow = {
      entityRef,
      kind: 'User',
      namespace: 'default',
      name: 'alice',
      etag: 'A',
      metadata: { name: 'alice' },
      spec: {},
      ...options.fields,
    };
    await store.recordCycle({
      cycleId,
      provider: options.provider ?? 'as-of-provider',
      source: options.source ?? 'provider',
      mutationType: 'full',
      startedAt: new Date(timestamp),
      finishedAt: new Date(timestamp),
      inserts: op === 'insert' ? [row] : [],
      updates: op === 'update' ? [row] : [],
      deletes: op === 'delete' ? [row.entityRef] : [],
      unchangedCount: 0,
    });
    // Bind the original string so fixtures retain PostgreSQL microseconds too.
    const [saved] = await db('catalog_history_entities')
      .where({ cycle_id: cycleId })
      .update({ changed_at: timestamp, ...(options.id && { id: options.id }) })
      .returning('id');
    return { id: String(saved.id), cycleId };
  }

  it.each(['empty', 'before-first', 'pruned'] as const)(
    'returns unknown retained state without throwing for %s history',
    async scenario => {
      // Arrange: the future observation must not stand in for missing history.
      if (scenario !== 'empty') await record(thirdAt);
      if (scenario === 'pruned') {
        const eligible = await record(firstAt);
        await db('catalog_history_entities').where('id', eligible.id).delete();
      }
      const timestamp = secondAt;

      // Act
      const result = await store.query.getEntityAsOf({ entityRef, timestamp });

      // Assert: absence is a successful read, not NotFoundError/never-existed.
      expect(result).toEqual({ entityRef, asOf: timestamp });
      expect(result.version).toBeUndefined();
      expect(result.snapshot).toBeUndefined();
      expect(
        journal.points.filter(
          p => p.name === 'catalog.history.query.operations',
        ),
      ).toEqual([
        expect.objectContaining({
          value: 1,
          attributes: { operation: 'as_of', outcome: 'success' },
        }),
      ]);
    },
  );

  it.each([
    [firstAt, 'first'],
    ['2026-07-07T00:00:01.500Z', 'first'],
    [secondAt, 'second'],
    [after, 'second'],
  ])('selects the inclusive latest row at %s', async (timestamp, expected) => {
    // Arrange
    const first = await record(firstAt);
    const second = await record(secondAt, { op: 'update' });

    // Act
    const result = await store.query.getEntityAsOf({ entityRef, timestamp });

    // Assert
    expect(result.asOf).toBe(timestamp);
    expect(result.version?.id).toBe(
      expected === 'first' ? first.id : second.id,
    );
  });

  it.each(['Z', '+02:00'])(
    'keeps native microsecond cutoff precision with %s',
    async zone => {
      // Arrange: IDs oppose timestamp order; neither JS millisecond truncation nor
      // ordering IDs before native timestamps may select the earlier observation.
      const base = zone === 'Z' ? '2026-07-07T00:00:01' : '2026-07-07T02:00:01';
      await record(`${base}.000100${zone}`, { id: '9007199254740995' });
      const eligible = await record(`${base}.000400${zone}`, {
        id: '9007199254740994',
      });
      await record(`${base}.000600${zone}`, { id: '9007199254740996' });
      const timestamp = `${base}.000500${zone}`;

      // Act
      const result = await store.query.getEntityAsOf({ entityRef, timestamp });

      // Assert
      expect(result.asOf).toBe(timestamp);
      expect(result.version?.id).toBe(eligible.id);
    },
  );

  it('breaks equal-time ties with PostgreSQL bigint IDs above Number.MAX_SAFE_INTEGER', async () => {
    // Arrange: insert the larger ID first, then a lower ID that rounds to it in JS.
    const latest = await record(firstAt, { id: '9007199254740993' });
    await record(firstAt, { id: '9007199254740992' });

    // Act
    const result = await store.query.getEntityAsOf(request);

    // Assert
    expect(result.version?.id).toBe(latest.id);
  });

  it('selects the last physical A in A -> B -> A rather than deduplicating etags', async () => {
    // Arrange
    await record(firstAt);
    await record(secondAt, { op: 'update', fields: { etag: 'B' } });
    const last = await record(thirdAt, { op: 'update', fields: { etag: 'A' } });

    // Act
    const result = await store.query.getEntityAsOf(request);

    // Assert
    expect(result.version).toMatchObject({
      id: last.id,
      etag: 'A',
      op: 'update',
    });
  });

  it('returns a tombstone without falling back to live state, then permits reinsertion', async () => {
    // Arrange
    await record(firstAt);
    const deleted = await record(secondAt, { op: 'delete' });
    const reinserted = await record(thirdAt);

    // Act
    const absent = await store.query.getEntityAsOf({
      ...request,
      timestamp: secondAt,
    });
    const live = await store.query.getEntityAsOf(request);

    // Assert
    expect(absent.version).toMatchObject({
      id: deleted.id,
      op: 'delete',
      summary: {},
    });
    expect(absent.version?.snapshot).toBeUndefined();
    expect(absent.snapshot).toBeUndefined();
    expect(live.version?.id).toBe(reinserted.id);
    expect(live.snapshot).toBeDefined();
  });

  it.each([
    ['provider', 'Shared'],
    ['processing', 'Shared'],
    ['reconciler', 'Shared'],
    ['provider', 'shared'],
    ['provider', ' Shared '],
    ['provider', ''],
    ['provider', 'literal_%'],
  ] as const)(
    'matches exact source %s and provider %j without trimming or truthiness',
    async (source, provider) => {
      // Arrange: later rows are tempting but outside at least one exact predicate.
      const selected = await record(firstAt, { source, provider });
      await record(secondAt, {
        source: source === 'provider' ? 'processing' : 'provider',
        provider,
      });
      await record(thirdAt, { source, provider: `${provider}x` });

      // Act
      const result = await store.query.getEntityAsOf({
        ...request,
        source,
        provider,
      });
      const missing = await store.query.getEntityAsOf({
        ...request,
        source,
        provider: `${provider}missing`,
      });

      // Assert
      expect(result.version).toMatchObject({
        id: selected.id,
        source,
        provider,
      });
      expect(missing.version).toBeUndefined();
    },
  );

  it('uses the last unscoped observation without combining capture layers or entities', async () => {
    // Arrange
    await record(firstAt, { fields: { owner: 'group:default/old' } });
    const processing = await record(secondAt, {
      source: 'processing',
      provider: 'Shared',
    });
    const reconciler = await record(thirdAt, {
      source: 'reconciler',
      provider: 'Shared',
    });
    await record(after, {
      fields: { entityRef: 'user:default/bob', name: 'bob' },
    });

    // Act
    const unscoped = await store.query.getEntityAsOf(request);
    const sourceOnly = await store.query.getEntityAsOf({
      ...request,
      source: 'processing',
    });
    const providerOnly = await store.query.getEntityAsOf({
      ...request,
      provider: 'Shared',
    });
    const exactRef = await store.query.getEntityAsOf({
      ...request,
      entityRef: 'User:default/alice',
    });

    // Assert
    expect(unscoped.version?.id).toBe(reconciler.id);
    expect(providerOnly.version?.id).toBe(reconciler.id);
    expect(sourceOnly.version?.id).toBe(processing.id);
    expect(unscoped.snapshot?.owner).toBeUndefined();
    expect(exactRef.version).toBeUndefined();
  });

  it('maps every snapshot field and provenance from one row without filling missing fields', async () => {
    // Arrange
    await record(firstAt, { fields: { owner: 'group:default/old' } });
    const fields = {
      displayName: 'Alice New',
      email: 'alice@example.test',
      parent: 'group:default/parent',
      memberOf: ['group:default/team'],
      metadata: { name: 'alice', annotations: { observed: 'new' } },
      spec: { profile: { displayName: 'New' } },
      relations: [{ type: 'memberOf', targetRef: 'group:default/team' }],
      statusItems: [{ type: 'test', level: 'warning', message: 'new' }],
      orphan: false,
      etag: 'latest',
    };
    const saved = await record(secondAt, {
      op: 'update',
      source: 'processing',
      provider: ' Observer ',
      fields,
    });

    // Act
    const result = await store.query.getEntityAsOf(request);

    // Assert
    expect(result.version).toMatchObject({
      ...saved,
      entityRef,
      source: 'processing',
      provider: ' Observer ',
      op: 'update',
      etag: 'latest',
      changedAt: secondAt,
      summary: {},
    });
    expect(result.snapshot).toEqual({
      entityRef,
      kind: 'User',
      namespace: 'default',
      name: 'alice',
      ...fields,
    });
    expect(result.snapshot?.owner).toBeUndefined();
    expect(result.version?.snapshot).toEqual(result.snapshot);
  });

  it.each([
    { op: 'insert' },
    { owner: 'group:default/old' },
    { changedBefore: firstAt },
    { changedAfter: after },
    { cycleId: randomUUID() },
    { cycle: { cycleId: randomUUID() } },
  ])('ignores undeclared runtime predicate %j', async extra => {
    // Arrange
    await record(firstAt, { fields: { owner: 'group:default/old' } });
    const selected = await record(secondAt, { op: 'update' });

    // Act
    const result = await store.query.getEntityAsOf(
      runtimeRequest({ ...request, ...extra }),
    );

    // Assert
    expect(result.version?.id).toBe(selected.id);
  });

  it.each([
    { timestamp: undefined },
    { timestamp: null },
    { timestamp: 1 },
    { timestamp: '' },
    { timestamp: 'not-a-time' },
    { timestamp: '2026-07-07' },
    { timestamp: '2026-07-07T00:00:00' },
    { source: 'unknown' },
    { source: '' },
    { provider: 1 },
    { provider: null },
    { entityRef: '' },
    { entityRef: null },
  ])(
    'rejects invalid direct service input %j with InputError',
    async invalid => {
      // Arrange
      const input = runtimeRequest({ ...request, ...invalid });

      // Act
      const result = store.query.getEntityAsOf(input);

      // Assert
      await expect(result).rejects.toBeInstanceOf(InputError);
    },
  );

  it('executes one full-row entity SELECT with raw cutoff and fixed metrics labels after readiness', async () => {
    // Arrange
    await record(firstAt);
    const timestamp = '2026-07-07T02:00:01.000500+02:00';
    const queries: Array<{ sql: string; bindings: readonly unknown[] }> = [];
    db.on('query', query => queries.push(query));

    // Act
    const result = await store.query.getEntityAsOf({ entityRef, timestamp });

    // Assert: no COUNT, predecessor, distinct-etag pass, or hidden detail fetch.
    expect(result.snapshot).toBeDefined();
    const selects = queries.filter(
      q =>
        /^(select|with)\b/i.test(q.sql) &&
        q.sql.includes('catalog_history_entities'),
    );
    expect(selects).toHaveLength(1);
    expect(selects[0].sql).toMatch(
      /^select \* from "catalog_history_entities"/i,
    );
    expect(selects[0].sql).toMatch(/"changed_at" <= \$2/);
    expect(selects[0].sql).toMatch(
      /order by "changed_at" desc, "id" desc limit \$3/,
    );
    expect(selects[0].bindings).toEqual([entityRef, timestamp, 1]);
    expect(
      journal.points
        .filter(p => p.name.startsWith('catalog.history.query.'))
        .map(p => p.attributes),
    ).toEqual([
      { operation: 'as_of', outcome: 'success' },
      { operation: 'as_of', outcome: 'success' },
    ]);
  });

  it('applies the default deadline inside the successful as-of SELECT and restores it', async () => {
    // Arrange: inspect the same connection immediately before its entity SELECT.
    await record(firstAt);
    const previous = await timeoutSetting(db);
    const prototype = Object.getPrototypeOf(db.client);
    const original = prototype.query;
    const observed: number[] = [];
    jest.spyOn(prototype, 'query').mockImplementation(async function observe(
      this: Knex.Client,
      ...args: unknown[]
    ) {
      const [connection, query] = args as [unknown, { sql: string }];
      if (
        /^select\b/i.test(query.sql) &&
        query.sql.includes('catalog_history_entities')
      ) {
        const probe = await original.call(this, connection, {
          sql: "select setting::integer as timeout from pg_settings where name = 'statement_timeout'",
          bindings: [],
        });
        observed.push(probe.response.rows[0].timeout);
      }
      return original.call(this, connection, query);
    });

    // Act
    const result = await store.query.getEntityAsOf(request);

    // Assert
    expect(result.snapshot).toBeDefined();
    expect(observed).toEqual([
      previous > 0 ? Math.min(previous, 10000) : 10000,
    ]);
    expect(await timeoutSetting(db)).toBe(previous);
  });

  it('cancels a blocked as-of SELECT with 57014 and restores a reusable session', async () => {
    // Arrange: readiness must finish before taking the external table lock.
    await record(firstAt);
    const limited = new PostgresHistoryStore(db, {
      queryTimeoutMs: 80,
      metrics: journal.metrics,
    });
    await limited.query.ensureReady();
    const previous = await timeoutSetting(db);
    const blocker = await fixture.transaction();
    // Safety release avoids leaking the lock if a regression bypasses the deadline.
    let watchdogReleased = false;
    const watchdog = setTimeout(() => {
      watchdogReleased = true;
      void blocker.rollback();
    }, 5000);
    try {
      await blocker.raw(
        'lock table catalog_history_entities in access exclusive mode',
      );

      // Act / Assert: the lock remains owned until the finally block.
      await expect(limited.query.getEntityAsOf(request)).rejects.toMatchObject({
        code: '57014',
      });
      expect(watchdogReleased).toBe(false);
      expect(await timeoutSetting(db)).toBe(previous);
      expect((await db.raw('select 1 as usable')).rows[0].usable).toBe(1);
      expect(
        journal.points.filter(
          p => p.name === 'catalog.history.query.operations',
        ),
      ).toEqual([
        expect.objectContaining({
          attributes: { operation: 'as_of', outcome: 'timeout' },
        }),
      ]);
    } finally {
      clearTimeout(watchdog);
      await blocker.rollback();
      await blocker.executionPromise;
      await limited.shutdown();
    }

    // Act / Assert: successful reads still work after releasing the blocker.
    const result = await store.query.getEntityAsOf(request);
    expect(result.snapshot).toBeDefined();
    expect(await timeoutSetting(db)).toBe(previous);
  });
});
