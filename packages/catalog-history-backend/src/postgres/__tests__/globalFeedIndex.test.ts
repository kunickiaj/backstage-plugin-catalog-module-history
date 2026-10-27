import { TestDatabases } from '@backstage/backend-test-utils';
import { resolvePackagePath } from '@backstage/backend-plugin-api';
import type { Knex } from 'knex';
import { ensureSchema } from '../ensureSchema';

const migrationsDir = resolvePackagePath(
  '@kunickiaj/backstage-plugin-catalog-history-storage-node',
  'migrations',
);
const ledger = 'catalog_history_knex_migrations';
const migrationNames = [
  '20260512000000_initial.js',
  '20260705000000_source_and_stitched_fields.js',
  '20261023000000_global_feed_ordering_index.js',
  '20261025000000_entity_discovery_name_index.js',
];
const indexName = 'catalog_history_entities_changed_at_id_idx';
const cycleId = '00000000-0000-4000-8000-000000000001';
const entities = 'catalog_history_entities';
const feedColumns = [
  'id',
  'cycle_id',
  'entity_ref',
  'kind',
  'namespace',
  'name',
  'source',
  'provider',
  'op',
  'changed_at',
  'etag',
];

jest.setTimeout(30000);

async function indexes(db: Knex) {
  return db('pg_indexes')
    .where({ schemaname: 'public', tablename: entities })
    .orderBy('indexname')
    .select('indexname', 'indexdef');
}

async function historyData(db: Knex) {
  return {
    cycles: await db('catalog_history_cycles').orderBy('cycle_id'),
    entities: await db(entities).orderBy('id'),
    columns: await db(entities).columnInfo(),
    cycleColumns: await db('catalog_history_cycles').columnInfo(),
  };
}

async function seedHistory(db: Knex, count = 1) {
  await db('catalog_history_cycles').insert({
    cycle_id: cycleId,
    provider: 'fixture-provider',
    source: 'processing',
    mutation_type: 'full',
    started_at: '2026-10-23T00:00:00Z',
    finished_at: '2026-10-23T00:00:01Z',
    n_added: count,
  });
  // Group timestamps to exercise the id tie-breaker with a real foreign key.
  await db.raw(
    `INSERT INTO catalog_history_entities
      (cycle_id, entity_ref, kind, namespace, name, provider, source, op,
       etag, metadata, spec, relations, status_items, orphan, changed_at)
     SELECT ?::uuid, 'component:default/fixture-' || n, 'Component', 'default',
       'fixture-' || n, 'fixture-provider', 'processing', 'insert',
       'etag-' || n, '{"name":"fixture"}'::jsonb, '{"type":"service"}'::jsonb,
       '[]'::jsonb, '[]'::jsonb, false,
       ?::timestamptz + (n / 10) * interval '1 second'
     FROM generate_series(1, ?::integer) AS fixture(n)`,
    [cycleId, '2026-10-23T00:00:00Z', count],
  );
}

type PlanNode = {
  'Node Type': string;
  'Index Name'?: string;
  Plans?: PlanNode[];
};

function planNodes(node: PlanNode): PlanNode[] {
  return [node, ...(node.Plans ?? []).flatMap(planNodes)];
}

describe('global feed ordering index', () => {
  const databases = TestDatabases.create({ ids: ['POSTGRES_16'] });
  let db: Knex;

  beforeEach(async () => {
    db = await databases.init('POSTGRES_16');
  });

  it('creates a valid descending B-tree index on a fresh schema without a predicate', async () => {
    // Arrange: TestDatabases supplies an empty isolated database.
    // Act
    await ensureSchema(db);

    // Assert: both keys, their order, and validity matter for unfiltered feeds.
    expect(
      (await indexes(db)).find(index => index.indexname === indexName),
    ).toEqual({
      indexname: indexName,
      indexdef: `CREATE INDEX ${indexName} ON public.${entities} USING btree (changed_at DESC, id DESC)`,
    });
    const { rows } = await db.raw(
      `SELECT indisvalid, indisready FROM pg_index
       WHERE indexrelid = ?::regclass`,
      [indexName],
    );
    expect(rows).toEqual([{ indisvalid: true, indisready: true }]);
  });

  it('upgrades the previous ledger without changing history or unrelated metadata and does not rebuild on retry', async () => {
    // Arrange: apply only the two migrations present before the index fix.
    for (const name of migrationNames.slice(0, 2)) {
      await db.migrate.up({
        directory: migrationsDir,
        tableName: ledger,
        name,
      });
    }
    await seedHistory(db);
    await db.schema.createTable('unrelated_metadata', table => {
      table.text('marker').primary();
    });
    await db('unrelated_metadata').insert({ marker: 'preserve-me' });
    const before = await historyData(db);
    const oldLedger = await db(ledger).orderBy('id');
    const oldIndexes = await indexes(db);
    expect(oldIndexes.map(index => index.indexname)).not.toContain(indexName);

    // Act
    await ensureSchema(db);
    const upgradedLedger = await db(ledger).orderBy('id');
    const { rows: indexBeforeRetry } = await db.raw(
      'SELECT ?::regclass::oid AS oid',
      [indexName],
    );
    await ensureSchema(db);

    // Assert: a retry preserves the physical index and every ledger record.
    expect(await historyData(db)).toEqual(before);
    expect(await db('unrelated_metadata').select('*')).toEqual([
      { marker: 'preserve-me' },
    ]);
    expect(upgradedLedger.slice(0, 2)).toEqual(oldLedger);
    expect(upgradedLedger.map(row => row.name)).toEqual(migrationNames);
    expect(await db(ledger).orderBy('id')).toEqual(upgradedLedger);
    expect(
      (await indexes(db)).filter(
        index =>
          ![indexName, 'catalog_history_entities_name_prefix_idx'].includes(
            index.indexname,
          ),
      ),
    ).toEqual(oldIndexes);
    expect(
      (await indexes(db)).filter(index => index.indexname === indexName),
    ).toHaveLength(1);
    expect(
      (await db.raw('SELECT ?::regclass::oid AS oid', [indexName])).rows,
    ).toEqual(indexBeforeRetry);
  });

  it('rolls back only the new index and can reapply it without losing rows or source fields', async () => {
    // Arrange
    await ensureSchema(db);
    await seedHistory(db);
    const before = await historyData(db);
    const beforeIndexes = await indexes(db);
    const previousLedger = (await db(ledger).orderBy('id')).filter(
      row => row.name !== migrationNames[2],
    );

    // Act
    await db.migrate.down({
      directory: migrationsDir,
      tableName: ledger,
      name: migrationNames[2],
    });
    const rolledBackIndexes = await indexes(db);
    const rolledBackData = await historyData(db);
    const rolledBackLedger = await db(ledger).orderBy('id');
    await ensureSchema(db);

    // Assert: down must not undo the preceding source/stitched migration.
    expect(rolledBackIndexes).toEqual(
      beforeIndexes.filter(index => index.indexname !== indexName),
    );
    expect(rolledBackData).toEqual(before);
    expect(rolledBackLedger).toEqual(previousLedger);
    expect(await historyData(db)).toEqual(before);
    expect(await indexes(db)).toEqual(beforeIndexes);
    expect(await db(ledger).orderBy('name').pluck('name')).toEqual(
      migrationNames,
    );
  });

  it.each(['first', 'cursor'] as const)(
    'uses the ordering index without sorting the %s feed page under default planner settings',
    async page => {
      // Arrange: enough rows for a normal planner decision, not a timing claim.
      await ensureSchema(db);
      await seedHistory(db, 20000);
      await db.raw('ANALYZE catalog_history_entities');
      const query = db(entities).select(feedColumns);
      if (page === 'cursor') {
        const anchor = await db(entities)
          .orderBy('id', 'desc')
          .offset(9999)
          .first();
        query.whereRaw(
          '(changed_at, id) < (select changed_at, id from catalog_history_entities where id = ?)',
          [anchor.id],
        );
      }
      const sql = query
        .orderBy('changed_at', 'desc')
        .orderBy('id', 'desc')
        .limit(26)
        .toSQL();

      // Act: explain actual bound PostgreSQL SQL matching getChangeFeed.
      const { rows } = await db.raw(`EXPLAIN (FORMAT JSON) ${sql.sql}`, [
        ...sql.bindings,
      ]);
      const nodes = planNodes(rows[0]['QUERY PLAN'][0].Plan);

      // Assert: a PK lookup in the cursor subplan is allowed, a feed sort is not.
      expect(nodes).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            'Node Type': 'Index Scan',
            'Index Name': indexName,
          }),
        ]),
      );
      expect(nodes.map(node => node['Node Type'])).not.toEqual(
        expect.arrayContaining(['Sort']),
      );
      expect(nodes.map(node => node['Node Type'])).not.toContain(
        'Incremental Sort',
      );
    },
  );
});
