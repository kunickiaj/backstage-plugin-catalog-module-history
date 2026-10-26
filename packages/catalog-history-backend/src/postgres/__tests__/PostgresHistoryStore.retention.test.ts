import { randomUUID } from 'node:crypto';
import { TestDatabases } from '@backstage/backend-test-utils';
import { InputError } from '@backstage/errors';
import { knex, type Knex } from 'knex';
import type {
  CaptureSource,
  HistoryRetentionCounts,
} from '@kunickiaj/backstage-plugin-catalog-history-node';
import { ensureSchema } from '../ensureSchema';
import { PostgresHistoryStore } from '../PostgresHistoryStore';
import { metricsJournal } from './metricsJournal';

jest.setTimeout(60000);

const storageDuration = 'catalog.history.storage.operation.duration';
const CUTOFF = new Date('2026-06-01T00:00:00Z');
const JAN = '2026-01-01T00:00:00Z';
const FEB = '2026-02-01T00:00:00Z';
const MAR = '2026-03-01T00:00:00Z';
const JUL = '2026-07-01T00:00:00Z';
const ZERO: HistoryRetentionCounts = {
  deletedEntityRows: 0,
  supersededRows: 0,
  emptyCycles: 0,
};

type Op = 'insert' | 'update' | 'delete';

async function seedCycle(
  db: Knex,
  at: string,
  provider = 'p',
  source: CaptureSource = 'provider',
): Promise<string> {
  const cycleId = randomUUID();
  await db('catalog_history_cycles').insert({
    cycle_id: cycleId,
    provider,
    source,
    mutation_type: 'full',
    started_at: at,
    finished_at: at,
  });
  return cycleId;
}

async function seedRow(
  db: Knex,
  row: {
    cycleId: string;
    ref: string;
    op: Op;
    at: string;
    provider?: string;
    source?: CaptureSource;
  },
): Promise<number> {
  const [kind, rest] = row.ref.split(':');
  const [namespace, name] = rest.split('/');
  const [inserted] = await db('catalog_history_entities')
    .insert({
      cycle_id: row.cycleId,
      entity_ref: row.ref,
      kind,
      namespace,
      name,
      provider: row.provider ?? 'p',
      source: row.source ?? 'provider',
      op: row.op,
      etag: row.op === 'delete' ? null : `${row.ref}@${row.at}#${randomUUID()}`,
      changed_at: row.at,
    })
    .returning('id');
  return Number(inserted.id);
}

async function rowIds(db: Knex): Promise<number[]> {
  const rows = await db('catalog_history_entities').select('id').orderBy('id');
  return rows.map(row => Number(row.id));
}

async function cycleIds(db: Knex): Promise<string[]> {
  const rows = await db('catalog_history_cycles')
    .select('cycle_id')
    .orderBy('cycle_id');
  return rows.map(row => row.cycle_id);
}

const SOURCES = [undefined, 'provider', 'processing', 'reconciler'] as const;
const PROVIDERS = ['p', 'p2'];

// Every capture baseline the store can produce for the providers used here.
async function baselines(store: PostgresHistoryStore) {
  const result: Record<string, unknown> = {};
  for (const source of SOURCES) {
    const all = await store.loadAllCurrentEtags({ source });
    result[`all:${source}`] = Object.fromEntries(all);
    for (const provider of PROVIDERS) {
      const etags = await store.loadCurrentEtags(provider, { source });
      result[`${provider}:${source}`] = Object.fromEntries(etags);
    }
  }
  return result;
}

// Fixture covering every rule. Expected outcome for CUTOFF:
// - X (r2, r6) ends in an old delete in its only stream: purged.
// - r1, r3, r8 are superseded in their streams.
// - Y keeps its tombstone r5 because its p2 stream still ends in insert r7.
// - cycles `jan` (all rows removed) and `heartbeat` (no rows) are emptied.
async function seedMixed(db: Knex) {
  const jan = await seedCycle(db, JAN);
  const feb = await seedCycle(db, FEB);
  const mar = await seedCycle(db, MAR, 'p2');
  const jul = await seedCycle(db, JUL, 'p2');
  await seedCycle(db, JAN); // old heartbeat with no rows
  const newHeartbeat = await seedCycle(db, JUL);
  const a = 'component:default/a';
  const b = 'component:default/b';
  const x = 'component:default/x';
  const y = 'component:default/y';
  await seedRow(db, { cycleId: jan, ref: a, op: 'insert', at: JAN });
  await seedRow(db, { cycleId: jan, ref: x, op: 'insert', at: JAN });
  await seedRow(db, { cycleId: jan, ref: y, op: 'insert', at: JAN });
  const r4 = await seedRow(db, { cycleId: feb, ref: a, op: 'update', at: FEB });
  const r5 = await seedRow(db, { cycleId: feb, ref: y, op: 'delete', at: FEB });
  await seedRow(db, { cycleId: feb, ref: x, op: 'delete', at: FEB });
  const r7 = await seedRow(db, {
    cycleId: mar,
    ref: y,
    op: 'insert',
    at: MAR,
    provider: 'p2',
  });
  await seedRow(db, {
    cycleId: mar,
    ref: b,
    op: 'insert',
    at: MAR,
    provider: 'p2',
  });
  const r9 = await seedRow(db, {
    cycleId: jul,
    ref: b,
    op: 'update',
    at: JUL,
    provider: 'p2',
  });
  return {
    counts: { deletedEntityRows: 2, supersededRows: 3, emptyCycles: 2 },
    survivors: [r4, r5, r7, r9],
    cycles: [feb, mar, jul, newHeartbeat].sort(),
  };
}

describe('PostgresHistoryStore retention', () => {
  const databases = TestDatabases.create({ ids: ['POSTGRES_16'] });
  let fixture: Knex;
  let db: Knex;
  let journal: ReturnType<typeof metricsJournal>;
  let store: PostgresHistoryStore;

  const retentionSamples = () =>
    journal
      .values(storageDuration)
      .map(point => point.attributes)
      .filter(attrs => String(attrs.operation).endsWith('_retention'));

  beforeEach(async () => {
    fixture = await databases.init('POSTGRES_16');
    db = knex({ ...fixture.client.config, pool: { min: 0, max: 1 } });
    await ensureSchema(db);
    journal = metricsJournal();
    store = new PostgresHistoryStore(db, { metrics: journal.metrics });
  });

  afterEach(async () => {
    await store?.shutdown();
    await db?.destroy();
    await fixture?.destroy();
  });

  it('removes superseded rows but keeps each stream-newest row and its baseline', async () => {
    // Arrange: A is entirely old; B's newest row is after the cutoff.
    const old = await seedCycle(db, JAN);
    const recent = await seedCycle(db, JUL);
    const a = 'user:default/a';
    const b = 'user:default/b';
    await seedRow(db, { cycleId: old, ref: a, op: 'insert', at: JAN });
    await seedRow(db, { cycleId: old, ref: a, op: 'update', at: FEB });
    const aNewest = await seedRow(db, {
      cycleId: old,
      ref: a,
      op: 'update',
      at: MAR,
    });
    await seedRow(db, { cycleId: old, ref: b, op: 'insert', at: JAN });
    const bNewest = await seedRow(db, {
      cycleId: recent,
      ref: b,
      op: 'update',
      at: JUL,
    });
    const before = await baselines(store);
    // Act
    const counts = await store.applyRetention({
      cutoff: CUTOFF,
      batchSize: 100,
    });
    // Assert
    expect(counts).toEqual({ ...ZERO, supersededRows: 3 });
    expect(await rowIds(db)).toEqual([aNewest, bNewest]);
    expect(await cycleIds(db)).toEqual([old, recent].sort());
    expect(await baselines(store)).toEqual(before);
    expect(Object.keys(before['p:undefined'] as object)).toEqual([a, b]);
  });

  it('keeps the newest row of each stream of one entity', async () => {
    // Arrange: same entity in (p, provider), (p2, provider), (p, processing).
    const cycleId = await seedCycle(db, JAN);
    const ref = 'user:default/multi';
    const base = { cycleId, ref };
    await seedRow(db, { ...base, op: 'insert', at: JAN });
    const pNewest = await seedRow(db, { ...base, op: 'update', at: FEB });
    await seedRow(db, { ...base, op: 'insert', at: JAN, provider: 'p2' });
    const p2Newest = await seedRow(db, {
      ...base,
      op: 'update',
      at: MAR,
      provider: 'p2',
    });
    const processingOnly = await seedRow(db, {
      ...base,
      op: 'insert',
      at: JAN,
      source: 'processing',
    });
    const before = await baselines(store);
    // Act
    const counts = await store.applyRetention({ cutoff: CUTOFF, batchSize: 5 });
    // Assert
    expect(counts).toEqual({ ...ZERO, supersededRows: 2 });
    expect(await rowIds(db)).toEqual([pNewest, p2Newest, processingOnly]);
    expect(await baselines(store)).toEqual(before);
  });

  it('purges an entity whose every stream ends in an old delete', async () => {
    // Arrange: two streams, both ending in deletes before the cutoff.
    const cycleId = await seedCycle(db, JAN);
    const ref = 'user:default/gone';
    await seedRow(db, { cycleId, ref, op: 'insert', at: JAN });
    await seedRow(db, { cycleId, ref, op: 'update', at: FEB });
    await seedRow(db, { cycleId, ref, op: 'delete', at: MAR });
    await seedRow(db, { cycleId, ref, op: 'delete', at: JAN, provider: 'p2' });
    const before = await baselines(store);
    // Act
    const counts = await store.applyRetention({ cutoff: CUTOFF, batchSize: 1 });
    // Assert
    expect(counts).toEqual({ ...ZERO, deletedEntityRows: 4, emptyCycles: 1 });
    expect(await rowIds(db)).toEqual([]);
    expect(await baselines(store)).toEqual(before);
    expect(JSON.stringify(before)).not.toContain(ref);
  });

  it('does not purge entities with a live stream or a row at or after the cutoff', async () => {
    // Arrange
    const cycleId = await seedCycle(db, JAN);
    const live = 'user:default/live-elsewhere';
    const recentRow = 'user:default/recent-row';
    const recentTombstone = 'user:default/recent-tombstone';
    const liveOld = await seedRow(db, {
      cycleId,
      ref: live,
      op: 'insert',
      at: JAN,
    });
    const liveTomb = await seedRow(db, {
      cycleId,
      ref: live,
      op: 'delete',
      at: FEB,
    });
    const liveOther = await seedRow(db, {
      cycleId,
      ref: live,
      op: 'insert',
      at: JAN,
      provider: 'p2',
    });
    const rowTomb = await seedRow(db, {
      cycleId,
      ref: recentRow,
      op: 'delete',
      at: FEB,
    });
    const rowRecent = await seedRow(db, {
      cycleId,
      ref: recentRow,
      op: 'delete',
      at: JUL,
      provider: 'p2',
    });
    await seedRow(db, { cycleId, ref: recentTombstone, op: 'insert', at: JAN });
    const tombRecent = await seedRow(db, {
      cycleId,
      ref: recentTombstone,
      op: 'delete',
      at: JUL,
    });
    const before = await baselines(store);
    // Act
    const counts = await store.applyRetention({ cutoff: CUTOFF, batchSize: 3 });
    // Assert: only the superseded inserts go; every tombstone stays.
    expect(counts).toEqual({ ...ZERO, supersededRows: 2 });
    expect(await rowIds(db)).toEqual(
      [liveTomb, liveOther, rowTomb, rowRecent, tombRecent].sort(
        (l, r) => l - r,
      ),
    );
    expect(await rowIds(db)).not.toContain(liveOld);
    expect(await baselines(store)).toEqual(before);
  });

  it('uses a strict changed_at < cutoff boundary', async () => {
    // Arrange
    const cycleId = await seedCycle(db, JAN);
    const ref = 'user:default/edge';
    const justBefore = new Date(CUTOFF.getTime() - 1).toISOString();
    const at = CUTOFF.toISOString();
    const after = new Date(CUTOFF.getTime() + 1).toISOString();
    await seedRow(db, { cycleId, ref, op: 'insert', at: justBefore });
    const atCutoff = await seedRow(db, { cycleId, ref, op: 'update', at });
    const newest = await seedRow(db, { cycleId, ref, op: 'update', at: after });
    const tombAtCutoff = await seedRow(db, {
      cycleId,
      ref: 'user:default/tomb-at-cutoff',
      op: 'delete',
      at,
    });
    // Act
    const counts = await store.applyRetention({
      cutoff: CUTOFF,
      batchSize: 10,
    });
    // Assert
    expect(counts).toEqual({ ...ZERO, supersededRows: 1 });
    expect(await rowIds(db)).toEqual([atCutoff, newest, tombAtCutoff]);
  });

  it('removes only cycles that are or become empty and never cascades kept rows', async () => {
    // Arrange: an old heartbeat, a recent heartbeat, and a cycle to be emptied.
    await seedCycle(db, JAN);
    const recentHeartbeat = await seedCycle(db, JUL);
    const emptied = await seedCycle(db, JAN);
    const holder = await seedCycle(db, FEB);
    const ref = 'user:default/held';
    await seedRow(db, { cycleId: emptied, ref, op: 'insert', at: JAN });
    const kept = await seedRow(db, {
      cycleId: holder,
      ref,
      op: 'update',
      at: FEB,
    });
    // Act
    const counts = await store.applyRetention({
      cutoff: CUTOFF,
      batchSize: 10,
    });
    // Assert
    expect(counts).toEqual({ ...ZERO, supersededRows: 1, emptyCycles: 2 });
    expect(await cycleIds(db)).toEqual([holder, recentHeartbeat].sort());
    expect(await rowIds(db)).toEqual([kept]);
  });

  it('plans exactly what apply removes without changing data', async () => {
    // Arrange
    const expected = await seedMixed(db);
    const rowsBefore = await rowIds(db);
    const cyclesBefore = await cycleIds(db);
    // Act
    const plan = await store.planRetention({ cutoff: CUTOFF });
    const rowsAfterPlan = await rowIds(db);
    const cyclesAfterPlan = await cycleIds(db);
    const applied = await store.applyRetention({
      cutoff: CUTOFF,
      batchSize: 10000,
    });
    // Assert
    expect(plan).toEqual(expected.counts);
    expect(applied).toEqual(plan);
    expect(rowsAfterPlan).toEqual(rowsBefore);
    expect(cyclesAfterPlan).toEqual(cyclesBefore);
    expect(await rowIds(db)).toEqual(expected.survivors);
    expect(await cycleIds(db)).toEqual(expected.cycles);
    expect(retentionSamples()).toEqual([
      { operation: 'plan_retention', source: 'all', outcome: 'success' },
      { operation: 'apply_retention', source: 'all', outcome: 'success' },
    ]);
  });

  it.each([1, 2])(
    'reaches the same result with batchSize %i and keeps baselines',
    async batchSize => {
      // Arrange
      const expected = await seedMixed(db);
      const before = await baselines(store);
      // Act
      const counts = await store.applyRetention({ cutoff: CUTOFF, batchSize });
      // Assert
      expect(counts).toEqual(expected.counts);
      expect(await rowIds(db)).toEqual(expected.survivors);
      expect(await cycleIds(db)).toEqual(expected.cycles);
      expect(await baselines(store)).toEqual(before);
    },
  );

  it('stops before the first batch when the signal is already aborted', async () => {
    // Arrange
    await seedMixed(db);
    const rowsBefore = await rowIds(db);
    const controller = new AbortController();
    controller.abort();
    // Act
    const result = store.applyRetention({
      cutoff: CUTOFF,
      batchSize: 2,
      signal: controller.signal,
    });
    // Assert
    await expect(result).rejects.toMatchObject({
      name: 'HistoryRetentionAbortedError',
      counts: ZERO,
      cause: { name: 'AbortError' },
    });
    expect(await rowIds(db)).toEqual(rowsBefore);
    expect(retentionSamples()).toEqual([
      { operation: 'apply_retention', source: 'all', outcome: 'error' },
    ]);
  });

  it('commits batches before an abort and a later run finishes the rest', async () => {
    // Arrange: abort while the first DELETE runs, so it still commits.
    const expected = await seedMixed(db);
    const rowsBefore = await rowIds(db);
    const controller = new AbortController();
    const reason = new Error('shutdown');
    db.on('query', (query: { sql: string }) => {
      if (/^delete/i.test(query.sql)) controller.abort(reason);
    });
    // Act
    const first = store.applyRetention({
      cutoff: CUTOFF,
      batchSize: 2,
      signal: controller.signal,
    });
    await expect(first).rejects.toMatchObject({
      name: 'HistoryRetentionAbortedError',
      counts: { ...ZERO, deletedEntityRows: 1 },
      cause: reason,
    });
    const rowsAfterAbort = await rowIds(db);
    const second = await store.applyRetention({ cutoff: CUTOFF, batchSize: 2 });
    // Assert: the first batch removed X's superseded insert only.
    expect(rowsAfterAbort).toHaveLength(rowsBefore.length - 1);
    expect(second).toEqual({ ...expected.counts, deletedEntityRows: 1 });
    expect(await rowIds(db)).toEqual(expected.survivors);
    expect(await cycleIds(db)).toEqual(expected.cycles);
  });

  it('breaks changed_at ties by id when choosing the stream-newest row', async () => {
    // Arrange
    const cycleId = await seedCycle(db, JAN);
    const tied = 'user:default/tied';
    const tombLast = 'user:default/tomb-last';
    const liveLast = 'user:default/live-last';
    await seedRow(db, { cycleId, ref: tied, op: 'insert', at: JAN });
    const tiedNewest = await seedRow(db, {
      cycleId,
      ref: tied,
      op: 'update',
      at: JAN,
    });
    await seedRow(db, { cycleId, ref: tombLast, op: 'insert', at: FEB });
    await seedRow(db, { cycleId, ref: tombLast, op: 'delete', at: FEB });
    await seedRow(db, { cycleId, ref: liveLast, op: 'delete', at: FEB });
    const liveNewest = await seedRow(db, {
      cycleId,
      ref: liveLast,
      op: 'insert',
      at: FEB,
    });
    const before = await baselines(store);
    // Act
    const plan = await store.planRetention({ cutoff: CUTOFF });
    const counts = await store.applyRetention({
      cutoff: CUTOFF,
      batchSize: 10,
    });
    // Assert
    expect(counts).toEqual({
      ...ZERO,
      deletedEntityRows: 2,
      supersededRows: 2,
    });
    expect(plan).toEqual(counts);
    expect(await rowIds(db)).toEqual([tiedNewest, liveNewest]);
    expect(await baselines(store)).toEqual(before);
  });

  it.each([
    ['batchSize 0', { batchSize: 0 }],
    ['negative batchSize', { batchSize: -1 }],
    ['fractional batchSize', { batchSize: 1.5 }],
    ['batchSize over 10000', { batchSize: 10001 }],
    ['NaN batchSize', { batchSize: Number.NaN }],
    ['string batchSize', { batchSize: '5' as unknown as number }],
    ['invalid cutoff', { cutoff: new Date('not a date') }],
    ['string cutoff', { cutoff: JAN as unknown as Date }],
  ])(
    'rejects %s with InputError before running SQL',
    async (_name, override) => {
      // Arrange: a fresh store has not run migrations, so any SQL is visible.
      const sql = jest.fn();
      db.on('query', sql);
      const fresh = new PostgresHistoryStore(db, { metrics: journal.metrics });
      // Act
      const result = fresh.applyRetention({
        cutoff: CUTOFF,
        batchSize: 10,
        ...override,
      });
      // Assert
      await expect(result).rejects.toBeInstanceOf(InputError);
      expect(sql).not.toHaveBeenCalled();
      expect(retentionSamples()).toEqual([
        { operation: 'apply_retention', source: 'all', outcome: 'error' },
      ]);
    },
  );

  it('rejects an invalid plan cutoff with InputError before running SQL', async () => {
    // Arrange
    const sql = jest.fn();
    db.on('query', sql);
    const fresh = new PostgresHistoryStore(db, { metrics: journal.metrics });
    // Act
    const result = fresh.planRetention({ cutoff: new Date(Number.NaN) });
    // Assert
    await expect(result).rejects.toBeInstanceOf(InputError);
    expect(sql).not.toHaveBeenCalled();
    expect(retentionSamples()).toEqual([
      { operation: 'plan_retention', source: 'all', outcome: 'error' },
    ]);
  });

  it('is idempotent once retention has been applied', async () => {
    // Arrange
    const expected = await seedMixed(db);
    await store.applyRetention({ cutoff: CUTOFF, batchSize: 3 });
    // Act
    const plan = await store.planRetention({ cutoff: CUTOFF });
    const second = await store.applyRetention({ cutoff: CUTOFF, batchSize: 3 });
    // Assert
    expect(plan).toEqual(ZERO);
    expect(second).toEqual(ZERO);
    expect(await rowIds(db)).toEqual(expected.survivors);
  });
  it('purges a stream whose tombstone has a lower id than its older rows', async () => {
    // Arrange: rows inserted out of time order, so the newest row (the old
    // delete) gets the lowest id in its stream.
    const cycle = await seedCycle(db, JAN);
    const ref = 'component:default/out-of-order';
    await seedRow(db, { cycleId: cycle, ref, op: 'delete', at: MAR });
    await seedRow(db, { cycleId: cycle, ref, op: 'update', at: FEB });
    await seedRow(db, { cycleId: cycle, ref, op: 'insert', at: JAN });
    const before = await baselines(store);
    const plan = await store.planRetention({ cutoff: CUTOFF });
    // Act
    const applied = await store.applyRetention({
      cutoff: CUTOFF,
      batchSize: 1,
    });
    // Assert
    expect(plan).toEqual({
      deletedEntityRows: 3,
      supersededRows: 0,
      emptyCycles: 1,
    });
    expect(applied).toEqual(plan);
    expect(await rowIds(db)).toEqual([]);
    expect(await baselines(store)).toEqual(before);
  });

  it('keeps every kept row while paging past them one row at a time', async () => {
    // Arrange: interleave kept stream-newest rows with deletable older rows.
    const old = await seedCycle(db, JAN);
    const newer = await seedCycle(db, FEB);
    const kept: number[] = [];
    for (let i = 0; i < 8; i++) {
      const ref = `component:default/live-${i}`;
      await seedRow(db, { cycleId: old, ref, op: 'insert', at: JAN });
      kept.push(
        await seedRow(db, { cycleId: newer, ref, op: 'update', at: FEB }),
      );
    }
    const before = await baselines(store);
    // Act
    const applied = await store.applyRetention({
      cutoff: CUTOFF,
      batchSize: 1,
    });
    // Assert
    expect(applied).toEqual({
      deletedEntityRows: 0,
      supersededRows: 8,
      emptyCycles: 1,
    });
    expect(await rowIds(db)).toEqual(kept);
    expect(await baselines(store)).toEqual(before);
  });
  it('keeps every capture baseline unchanged after each committed batch', async () => {
    // Arrange: one entity with two streams that each end in a delete after an
    // older live row. Each tombstone is inserted first, so it has the lowest
    // id and an id-ordered walk reaches it before the stream's older rows.
    // Deleting it first would expose a live baseline between batches.
    const cycle = await seedCycle(db, JAN);
    const ref = 'component:default/two-streams';
    for (const provider of ['p', 'p2']) {
      await seedRow(db, {
        cycleId: cycle,
        ref,
        op: 'delete',
        at: MAR,
        provider,
      });
      await seedRow(db, {
        cycleId: cycle,
        ref,
        op: 'update',
        at: FEB,
        provider,
      });
      await seedRow(db, {
        cycleId: cycle,
        ref,
        op: 'insert',
        at: JAN,
        provider,
      });
    }
    await seedMixed(db);
    const expected = await baselines(store);
    const pending: Array<Promise<void>> = [];
    let batches = 0;
    // Check baselines through a separate pool after every DELETE commits.
    const observer = knex({
      ...fixture.client.config,
      pool: { min: 0, max: 1 },
    });
    const observerStore = new PostgresHistoryStore(observer);
    db.on('query-response', (_response: unknown, query: { sql: string }) => {
      if (!/^delete/i.test(query.sql)) return;
      batches += 1;
      pending.push(
        baselines(observerStore).then(actual => {
          expect(actual).toEqual(expected);
        }),
      );
    });
    try {
      // Act
      await store.applyRetention({ cutoff: CUTOFF, batchSize: 1 });
      await Promise.all(pending);
    } finally {
      await observerStore.shutdown();
      await observer.destroy();
    }
    // Assert
    expect(batches).toBeGreaterThan(10);
    expect(await baselines(store)).toEqual(expected);
  });
});
