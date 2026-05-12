import knex, { Knex } from 'knex';
import { ensureSchema } from '../ensureSchema';

const TEST_CONFIG = {
  host: process.env.PG_HOST ?? 'localhost',
  port: Number(process.env.PG_PORT ?? 5432),
  user: process.env.PG_USER ?? 'postgres',
  password: process.env.PG_PASSWORD ?? 'postgres',
  database: process.env.PG_DATABASE ?? 'backstage_plugin_history_test',
};

describe('ensureSchema', () => {
  let db: Knex;

  beforeAll(() => {
    db = knex({
      client: 'pg',
      connection: TEST_CONFIG,
    });
  });

  afterAll(async () => {
    await db.destroy();
  });

  beforeEach(async () => {
    await db.raw('DROP TABLE IF EXISTS catalog_history_entities CASCADE');
    await db.raw('DROP TABLE IF EXISTS catalog_history_cycles CASCADE');
    await db.raw('DROP TABLE IF EXISTS knex_migrations CASCADE');
    await db.raw('DROP TABLE IF EXISTS knex_migrations_lock CASCADE');
  });

  it('creates both history tables', async () => {
    await ensureSchema(db);

    const cycleCols = await db('information_schema.columns')
      .where({ table_name: 'catalog_history_cycles' })
      .pluck('column_name');
    expect(cycleCols.sort()).toEqual(
      [
        'cycle_id',
        'finished_at',
        'mutation_type',
        'n_added',
        'n_modified',
        'n_removed',
        'n_unchanged',
        'provider',
        'started_at',
      ].sort(),
    );

    const entityCols = await db('information_schema.columns')
      .where({ table_name: 'catalog_history_entities' })
      .pluck('column_name');
    expect(entityCols.sort()).toEqual(
      [
        'changed_at',
        'cycle_id',
        'display_name',
        'email',
        'entity_ref',
        'etag',
        'id',
        'kind',
        'member_of',
        'metadata',
        'name',
        'namespace',
        'op',
        'owner',
        'parent',
        'provider',
        'spec',
      ].sort(),
    );
  });

  it('is idempotent: a second call is a no-op', async () => {
    await ensureSchema(db);
    await ensureSchema(db);

    const tables = await db('information_schema.tables')
      .whereIn('table_name', [
        'catalog_history_cycles',
        'catalog_history_entities',
      ])
      .pluck('table_name');
    expect(tables.sort()).toEqual(
      ['catalog_history_cycles', 'catalog_history_entities'].sort(),
    );
  });

  it('creates the expected indexes', async () => {
    await ensureSchema(db);

    const indexes = await db('pg_indexes')
      .whereIn('tablename', [
        'catalog_history_cycles',
        'catalog_history_entities',
      ])
      .pluck('indexname');

    expect(indexes).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/catalog_history_cycles_provider_started_at/),
        expect.stringMatching(/catalog_history_cycles_started_at/),
        expect.stringMatching(/catalog_history_entities_entity_ref_changed_at/),
        expect.stringMatching(/catalog_history_entities_cycle_id/),
        expect.stringMatching(/catalog_history_entities_provider_changed_at/),
        expect.stringMatching(/catalog_history_entities_owner/),
        expect.stringMatching(/catalog_history_entities_parent/),
        expect.stringMatching(/catalog_history_entities_member_of/),
      ]),
    );
  });
});
