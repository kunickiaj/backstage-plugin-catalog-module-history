import { randomUUID } from 'node:crypto';
import { createHash } from 'node:crypto';
import { resolvePackagePath } from '@backstage/backend-plugin-api';
import { TestDatabases } from '@backstage/backend-test-utils';
import type { EntityRow } from '@kunickiaj/backstage-plugin-catalog-history-node';
import type { Knex } from 'knex';
import { ensureSchema } from '../ensureSchema';
import { PostgresHistoryStore } from '../PostgresHistoryStore';

jest.setTimeout(30000);
const directory = resolvePackagePath(
  '@kunickiaj/backstage-plugin-catalog-history-storage-node',
  'migrations',
);
const tableName = 'catalog_history_knex_migrations';
const migration = '20261025000000_entity_discovery_name_index.js';
const previous = [
  '20260512000000_initial.js',
  '20260705000000_source_and_stitched_fields.js',
  '20261023000000_global_feed_ordering_index.js',
];
const indexName = 'catalog_history_entities_name_prefix_idx';

function opaqueName(bytes: number) {
  return Array.from({ length: Math.ceil(bytes / 64) }, (_, n) =>
    createHash('sha256').update(String(n)).digest('hex'),
  )
    .join('')
    .slice(0, bytes);
}

function entity(name: string, suffix: string): EntityRow {
  return {
    entityRef: `component:default/${suffix}`,
    name,
    kind: 'Component',
    namespace: 'default',
    etag: 'fixture',
    metadata: { name: suffix },
    spec: { private: 'preserve-payload' },
  };
}

async function indexes(db: Knex) {
  return db('pg_indexes')
    .where({ schemaname: 'public', tablename: 'catalog_history_entities' })
    .orderBy('indexname')
    .select('indexname', 'indexdef');
}

async function record(store: PostgresHistoryStore, row: EntityRow) {
  await store.recordCycle({
    cycleId: randomUUID(),
    provider: 'fixture',
    source: 'provider',
    mutationType: 'delta',
    startedAt: new Date('2026-10-25T00:00:00Z'),
    finishedAt: new Date('2026-10-25T00:00:00Z'),
    inserts: [row],
    updates: [],
    deletes: [],
    unchangedCount: 0,
  });
}

describe('entity discovery name index migration', () => {
  const databases = TestDatabases.create({ ids: ['POSTGRES_16'] });
  let db: Knex;

  beforeEach(async () => {
    db = await databases.init('POSTGRES_16');
  });
  afterEach(async () => {
    await db?.destroy();
  });

  it('installs a valid 128-character folded C pattern B-tree without unbounded included fields and analyzes it', async () => {
    // Arrange
    const statements: string[] = [];
    const listener = (query: { sql: string }) => statements.push(query.sql);
    db.on('query', listener);
    try {
      // Act
      await ensureSchema(db);
      const definition = (await indexes(db)).find(
        index => index.indexname === indexName,
      )?.indexdef;
      const validity = (
        await db.raw(
          'select indisvalid, indisready from pg_index where indexrelid = ?::regclass',
          [indexName],
        )
      ).rows;

      // Assert: inspect the installed schema, not a forced query plan or cost ratio.
      expect(definition).toMatch(/USING btree/);
      expect(definition).toMatch(
        /"?left"?\(lower\(name\), 128\).*COLLATE "C".*text_pattern_ops/,
      );
      expect(definition).not.toMatch(/INCLUDE|WHERE|entity_ref|namespace|kind/);
      expect(validity).toEqual([{ indisvalid: true, indisready: true }]);
      const createAt = statements.findIndex(
        sql => sql.includes(indexName) && /create index/i.test(sql),
      );
      const analyzeAt = statements.findIndex(sql =>
        /analyze catalog_history_entities/i.test(sql),
      );
      expect(createAt).toBeGreaterThanOrEqual(0);
      expect(analyzeAt).toBeGreaterThan(createAt);
    } finally {
      db.off('query', listener);
    }
  });

  it('upgrades baseline-valid 6890-byte opaque names unchanged and accepts 12000-byte names afterward', async () => {
    // Arrange: use the old schema without invoking the new ensureReady path.
    for (const name of previous)
      await db.migrate.up({ directory, tableName, name });
    const old = entity(opaqueName(6890), 'old-short-ref');
    const cycleId = randomUUID();
    await db('catalog_history_cycles').insert({
      cycle_id: cycleId,
      provider: 'fixture',
      source: 'provider',
      mutation_type: 'delta',
      started_at: '2026-10-25T00:00:00Z',
      finished_at: '2026-10-25T00:00:00Z',
      n_added: 1,
    });
    await db('catalog_history_entities').insert({
      cycle_id: cycleId,
      entity_ref: old.entityRef,
      kind: old.kind,
      namespace: old.namespace,
      name: old.name,
      etag: old.etag,
      metadata: old.metadata,
      spec: old.spec,
      source: 'provider',
      provider: 'fixture',
      op: 'insert',
      changed_at: '2026-10-25T00:00:00Z',
    });
    const before = await db('catalog_history_entities').orderBy('id');
    const ledgerBefore = await db(tableName).orderBy('id');
    const oldIndexes = await indexes(db);
    const store = new PostgresHistoryStore(db);

    // Act
    await store.ensureReady();
    const upgraded = await db('catalog_history_entities').orderBy('id');
    const oid = (await db.raw('select ?::regclass::oid as oid', [indexName]))
      .rows;
    await ensureSchema(db);
    await record(store, entity(opaqueName(12000), 'new-short-ref'));

    // Assert: no input limit or destructive rewrite is needed to build the index.
    expect(upgraded).toEqual(before);
    expect((await db(tableName).orderBy('id')).slice(0, 3)).toEqual(
      ledgerBefore,
    );
    expect(await db(tableName).orderBy('id').pluck('name')).toEqual([
      ...previous,
      migration,
    ]);
    expect(
      (await indexes(db)).filter(index => index.indexname !== indexName),
    ).toEqual(oldIndexes);
    expect(
      (await db.raw('select ?::regclass::oid as oid', [indexName])).rows,
    ).toEqual(oid);
    expect(
      await db('catalog_history_entities').orderBy('id').pluck('name'),
    ).toEqual([old.name, opaqueName(12000)]);
  });

  it('rolls back only the discovery index and reapplies it without changing payloads or older indexes', async () => {
    // Arrange
    const store = new PostgresHistoryStore(db);
    await record(store, entity('retained', 'retained'));
    const before = await db('catalog_history_entities').orderBy('id');
    const cycles = await db('catalog_history_cycles').orderBy('cycle_id');
    const beforeIndexes = await indexes(db);

    // Act
    await db.migrate.down({ directory, tableName, name: migration });
    const downIndexes = await indexes(db);
    const downLedger = await db(tableName).orderBy('id').pluck('name');
    await ensureSchema(db);

    // Assert
    expect(downIndexes).toEqual(
      beforeIndexes.filter(index => index.indexname !== indexName),
    );
    expect(downLedger).toEqual(previous);
    expect(await db('catalog_history_entities').orderBy('id')).toEqual(before);
    expect(await db('catalog_history_cycles').orderBy('cycle_id')).toEqual(
      cycles,
    );
    expect(await indexes(db)).toEqual(beforeIndexes);
  });
});
