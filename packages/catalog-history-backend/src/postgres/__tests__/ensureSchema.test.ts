import { randomUUID } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import { TestDatabases } from '@backstage/backend-test-utils';
import knex, { Knex } from 'knex';
import { resolvePackagePath } from '@backstage/backend-plugin-api';
import { ensureSchema } from '../ensureSchema';

const migrationsDir = resolvePackagePath(
  '@kunickiaj/backstage-plugin-catalog-history-storage-node',
  'migrations',
);

const historyLedger = 'catalog_history_knex_migrations';
const legacyLedger = 'knex_migrations';
const initialMigration = '20260512000000_initial.js';
const sourceMigration = '20260705000000_source_and_stitched_fields.js';
const globalFeedMigration = '20261023000000_global_feed_ordering_index.js';
const historyMigrationNames = [
  initialMigration,
  sourceMigration,
  globalFeedMigration,
  '20261025000000_entity_discovery_name_index.js',
];
const catalogMigrationsDir = resolvePackagePath(
  '@backstage/plugin-catalog-backend',
  'migrations',
);

jest.setTimeout(30000);

async function snapshotTables(db: Knex) {
  const tables = await db('information_schema.tables')
    .whereIn('table_schema', ['public', 'history_metadata'])
    .where('table_type', 'BASE TABLE')
    .orderBy(['table_schema', 'table_name'])
    .select('table_schema', 'table_name');
  return Promise.all(
    tables.map(async ({ table_schema: schema, table_name: table }) => ({
      schema,
      table,
      columns: await db(table).withSchema(schema).columnInfo(),
      rows: (await db(table).withSchema(schema).select('*')).sort((a, b) =>
        JSON.stringify(a).localeCompare(JSON.stringify(b)),
      ),
    })),
  );
}

async function seedHistory(db: Knex) {
  const cycleId = randomUUID();
  await db('catalog_history_cycles').insert({
    cycle_id: cycleId,
    provider: 'example-provider',
    mutation_type: 'full',
    started_at: '2026-05-12T10:00:00Z',
    finished_at: '2026-05-12T10:00:01Z',
    n_added: 1,
  });
  await db('catalog_history_entities').insert({
    cycle_id: cycleId,
    entity_ref: 'component:default/example',
    kind: 'Component',
    namespace: 'default',
    name: 'example',
    provider: 'example-provider',
    op: 'insert',
    etag: 'example-v1',
    metadata: { name: 'example' },
    spec: { type: 'service' },
  });
}

describe('ensureSchema', () => {
  const databases = TestDatabases.create({ ids: ['POSTGRES_16'] });
  let db: Knex;

  beforeEach(async () => {
    db = await databases.init('POSTGRES_16');
  });

  afterEach(async () => {
    // Release each case's pool before parallel suites need these connections.
    await db?.destroy();
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
        'source',
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
        'orphan',
        'owner',
        'parent',
        'provider',
        'relations',
        'source',
        'spec',
        'status_items',
      ].sort(),
    );
  });

  it('drops the source and stitched fields when their migration is rolled back', async () => {
    // Arrange: the ordering index follows the source and stitched fields.
    await ensureSchema(db);
    // Act: roll back both indexes first, then the source migration.
    await db.migrate.down({
      directory: migrationsDir,
      tableName: historyLedger,
    });
    await db.migrate.down({
      directory: migrationsDir,
      tableName: historyLedger,
    });
    await db.migrate.down({
      directory: migrationsDir,
      tableName: historyLedger,
    });

    // Assert: rolling back the source migration still removes its columns.
    const cycleCols = await db('information_schema.columns')
      .where({ table_name: 'catalog_history_cycles' })
      .pluck('column_name');
    const entityCols = await db('information_schema.columns')
      .where({ table_name: 'catalog_history_entities' })
      .pluck('column_name');

    expect(cycleCols).not.toContain('source');
    for (const col of ['source', 'relations', 'status_items', 'orphan']) {
      expect(entityCols).not.toContain(col);
    }
  });

  it('is idempotent: a second call is a no-op', async () => {
    await ensureSchema(db);
    const before = await snapshotTables(db);
    await ensureSchema(db);

    expect(await snapshotTables(db)).toEqual(before);

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
        expect.stringMatching(/catalog_history_entities_source_changed_at/),
        'catalog_history_entities_changed_at_id_idx',
        expect.stringMatching(/catalog_history_entities_owner/),
        expect.stringMatching(/catalog_history_entities_parent/),
        expect.stringMatching(/catalog_history_entities_member_of/),
      ]),
    );
  });

  it('creates a dedicated history ledger without creating a legacy ledger', async () => {
    await ensureSchema(db);

    expect(await db(historyLedger).orderBy('id').pluck('name')).toEqual(
      historyMigrationNames,
    );
    expect(await db.schema.hasTable(legacyLedger)).toBe(false);
    expect(await db.schema.hasTable(`${legacyLedger}_lock`)).toBe(false);
  });

  it('coexists with the actual catalog migrations without changing catalog data or metadata', async () => {
    const catalogNames = (await readdir(catalogMigrationsDir))
      .filter(name => name.endsWith('.js'))
      .sort();
    expect(catalogNames).toHaveLength(46);
    await db.migrate.latest({
      directory: catalogMigrationsDir,
      tableName: legacyLedger,
    });
    expect(await db(legacyLedger).orderBy('id').pluck('name')).toEqual(
      catalogNames,
    );
    await db('locations').insert({
      id: randomUUID(),
      type: 'url',
      target: 'https://example.test/catalog.yaml',
      location_entity_ref: 'location:default/example',
    });
    const before = await snapshotTables(db);

    await ensureSchema(db);
    await ensureSchema(db);

    const after = await snapshotTables(db);
    expect(
      after.filter(table => !table.table.startsWith('catalog_history_')),
    ).toEqual(before);
    expect(await db(historyLedger).orderBy('id').pluck('name')).toEqual(
      historyMigrationNames,
    );
  });

  it('retains a complete legacy history ledger and existing cycle and entity data', async () => {
    await db.migrate.latest({
      directory: migrationsDir,
      tableName: legacyLedger,
    });
    await seedHistory(db);
    const before = await snapshotTables(db);

    await ensureSchema(db);

    expect(await snapshotTables(db)).toEqual(before);
    expect(await db.schema.hasTable(historyLedger)).toBe(false);
  });

  it('initializes history concurrently across independent pools without changing catalog data or metadata', async () => {
    // Arrange: each replica shares the database, not a Knex migrator instance.
    await db.migrate.latest({
      directory: catalogMigrationsDir,
      tableName: legacyLedger,
    });
    await db('locations').insert({
      id: randomUUID(),
      type: 'url',
      target: 'https://example.test/catalog.yaml',
      location_entity_ref: 'location:default/example',
    });
    const before = await snapshotTables(db);
    const clients = Array.from({ length: 8 }, () =>
      knex({ ...db.client.config, pool: { min: 0, max: 1 } }),
    );

    try {
      // Act: no history ledger or lock table exists before these calls start.
      const results = await Promise.allSettled(
        clients.map(client => ensureSchema(client)),
      );

      // Assert: every replica succeeds and only history-owned tables change.
      expect(
        results
          .filter(result => result.status === 'rejected')
          .map(result => ({
            code: result.reason.code,
            message: result.reason.message,
          })),
      ).toEqual([]);
      expect(results).toEqual(
        clients.map(() => ({ status: 'fulfilled', value: undefined })),
      );
      expect(await db(historyLedger).orderBy('id').pluck('name')).toEqual(
        historyMigrationNames,
      );
      expect(await db(`${historyLedger}_lock`).select('*')).toEqual([
        { index: 1, is_locked: 0 },
      ]);
      expect(await db.schema.hasTable('catalog_history_cycles')).toBe(true);
      expect(await db.schema.hasTable('catalog_history_entities')).toBe(true);
      expect(
        (await snapshotTables(db)).filter(
          table => !table.table.startsWith('catalog_history_'),
        ),
      ).toEqual(before);
    } finally {
      await Promise.all(clients.map(client => client.destroy()));
    }
  });

  it('finishes a partial legacy upgrade concurrently without replaying migrations or losing history', async () => {
    // Arrange: preserve the initial record and data while replicas apply the rest.
    await db.migrate.up({
      directory: migrationsDir,
      tableName: legacyLedger,
      name: initialMigration,
    });
    await seedHistory(db);
    const initialRecord = await db(legacyLedger).first();
    const cycle = await db('catalog_history_cycles').first();
    const entity = await db('catalog_history_entities').first();
    const clients = Array.from({ length: 8 }, () =>
      knex({ ...db.client.config, pool: { min: 0, max: 1 } }),
    );

    try {
      // Act: independent migrators contend for the same unfinished upgrade.
      const results = await Promise.allSettled(
        clients.map(client => ensureSchema(client)),
      );

      // Assert: all migrations appear once, and existing records survive.
      expect(results).toEqual(
        clients.map(() => ({ status: 'fulfilled', value: undefined })),
      );
      expect(await db(legacyLedger).orderBy('id').pluck('name')).toEqual(
        historyMigrationNames,
      );
      expect(
        await db(legacyLedger).where({ id: initialRecord.id }).first(),
      ).toEqual(initialRecord);
      expect(await db('catalog_history_cycles').first()).toMatchObject(cycle);
      expect(await db('catalog_history_entities').first()).toMatchObject(
        entity,
      );
      expect(await db('catalog_history_cycles').columnInfo()).toHaveProperty(
        'source',
      );
      expect(await db('catalog_history_entities').columnInfo()).toHaveProperty(
        'relations',
      );
      expect(await db(`${legacyLedger}_lock`).select('*')).toEqual([
        { index: 1, is_locked: 0 },
      ]);
      expect(await db.schema.hasTable(historyLedger)).toBe(false);
      expect(await db.schema.hasTable(`${historyLedger}_lock`)).toBe(false);
    } finally {
      await Promise.all(clients.map(client => client.destroy()));
    }
  });

  it('allows another independent client to reject an unsafe state after initialization fails', async () => {
    // Arrange: failures must leave both data and initialization access intact.
    await db.migrate.latest({
      directory: migrationsDir,
      tableName: legacyLedger,
    });
    await seedHistory(db);
    await db(legacyLedger).insert({
      name: '20200101000000_unrelated.js',
      batch: 2,
      migration_time: new Date('2026-05-12T10:00:00Z'),
    });
    const before = await snapshotTables(db);
    const clients = Array.from({ length: 2 }, () =>
      knex({ ...db.client.config, pool: { min: 0, max: 1 } }),
    );

    try {
      // Act: a second pool retries while the first pool stays open.
      const errors = [];
      for (const client of clients) {
        errors.push(
          await ensureSchema(client).then(
            () => undefined,
            error => error,
          ),
        );
      }

      // Assert: each attempt rejects the unsafe state without changing it.
      expect(errors).toEqual(
        clients.map(() =>
          expect.objectContaining({
            message: expect.stringMatching(/mixed with unrelated migrations/),
          }),
        ),
      );
      expect(await snapshotTables(db)).toEqual(before);
      expect(await db.schema.hasTable(historyLedger)).toBe(false);
      expect(await db.schema.hasTable(`${historyLedger}_lock`)).toBe(false);
    } finally {
      await Promise.all(clients.map(client => client.destroy()));
    }
  });

  it('finishes a partially applied legacy history ledger without replaying the initial migration', async () => {
    await db.migrate.up({
      directory: migrationsDir,
      tableName: legacyLedger,
      name: initialMigration,
    });
    await seedHistory(db);
    const initialRecord = await db(legacyLedger).first();
    const cycle = await db('catalog_history_cycles').first();
    const entity = await db('catalog_history_entities').first();
    expect(await db('catalog_history_cycles').columnInfo()).not.toHaveProperty(
      'source',
    );

    await ensureSchema(db);

    expect(await db(legacyLedger).orderBy('id').pluck('name')).toEqual(
      historyMigrationNames,
    );
    expect(
      await db(legacyLedger).where({ id: initialRecord.id }).first(),
    ).toEqual(initialRecord);
    expect(await db('catalog_history_cycles').first()).toMatchObject(cycle);
    expect(await db('catalog_history_entities').first()).toMatchObject(entity);
    expect(await db('catalog_history_cycles').columnInfo()).toHaveProperty(
      'source',
    );
    expect(await db('catalog_history_entities').columnInfo()).toHaveProperty(
      'relations',
    );
    expect(await db.schema.hasTable(historyLedger)).toBe(false);
  });

  it('rejects mixed history and unrelated legacy records before changing any tables', async () => {
    await db.migrate.latest({
      directory: migrationsDir,
      tableName: legacyLedger,
    });
    await seedHistory(db);
    await db(legacyLedger).insert({
      name: '20200101000000_unrelated.js',
      batch: 2,
      migration_time: new Date('2026-05-12T10:00:00Z'),
    });
    const before = await snapshotTables(db);

    await expect(ensureSchema(db)).rejects.toThrow(
      /mixed with unrelated migrations/,
    );

    expect(await snapshotTables(db)).toEqual(before);
    expect(await db.schema.hasTable(historyLedger)).toBe(false);
  });

  it.each(['catalog_history_cycles', 'catalog_history_entities'])(
    'rejects an orphan %s table without creating a ledger',
    async tableName => {
      await db.schema.createTable(tableName, table => {
        table.text('marker');
      });
      await db(tableName).insert({ marker: 'keep-existing-data' });
      const before = await snapshotTables(db);

      await expect(ensureSchema(db)).rejects.toThrow(
        /without recognized history migration records/,
      );

      expect(await snapshotTables(db)).toEqual(before);
      expect(await db.schema.hasTable(historyLedger)).toBe(false);
      expect(await db.schema.hasTable(`${historyLedger}_lock`)).toBe(false);
    },
  );

  it('retains a configured custom legacy history ledger', async () => {
    db.client.config.migrations = { tableName: 'custom_history_migrations' };
    await db.migrate.latest({ directory: migrationsDir });
    await seedHistory(db);
    const before = await snapshotTables(db);

    await ensureSchema(db);

    expect(await snapshotTables(db)).toEqual(before);
    expect(await db.schema.hasTable(historyLedger)).toBe(false);
    expect(await db.schema.hasTable(legacyLedger)).toBe(false);
  });

  it('uses valid legacy history records when the dedicated ledger exists but is empty', async () => {
    await db.migrate.latest({
      directory: migrationsDir,
      tableName: legacyLedger,
    });
    await seedHistory(db);
    await db.migrate.list({
      directory: migrationsDir,
      tableName: historyLedger,
    });
    expect(await db(historyLedger).select('*')).toEqual([]);
    const before = await snapshotTables(db);

    await ensureSchema(db);

    expect(await snapshotTables(db)).toEqual(before);
  });

  it('prioritizes an existing dedicated ledger over unrelated legacy records', async () => {
    await ensureSchema(db);
    await seedHistory(db);
    await db.migrate.list({
      directory: migrationsDir,
      tableName: legacyLedger,
    });
    await db(legacyLedger).insert({
      name: '20200101000000_unrelated.js',
      batch: 1,
      migration_time: new Date('2026-05-12T10:00:00Z'),
    });
    const before = await snapshotTables(db);

    await ensureSchema(db);

    expect(await snapshotTables(db)).toEqual(before);
  });

  it('reuses legacy metadata in a configured schema while keeping history data in public', async () => {
    await db.schema.createSchema('history_metadata');
    db.client.config.migrations = { schemaName: 'history_metadata' };
    await db.migrate.latest({
      directory: migrationsDir,
      tableName: legacyLedger,
    });
    await seedHistory(db);
    expect(
      await db.schema.withSchema('public').hasTable('catalog_history_cycles'),
    ).toBe(true);
    expect(
      await db.schema.withSchema('history_metadata').hasTable(legacyLedger),
    ).toBe(true);
    const before = await snapshotTables(db);

    await ensureSchema(db);

    expect(await snapshotTables(db)).toEqual(before);
    expect(
      await db.schema.withSchema('history_metadata').hasTable(historyLedger),
    ).toBe(false);
  });

  it('rejects orphan public history data even when migration metadata uses another schema', async () => {
    await db.schema.createSchema('history_metadata');
    db.client.config.migrations = { schemaName: 'history_metadata' };
    await db.schema.createTable('catalog_history_cycles', table => {
      table.text('marker');
    });
    await db('catalog_history_cycles').insert({ marker: 'keep-existing-data' });
    const before = await snapshotTables(db);

    await expect(ensureSchema(db)).rejects.toThrow(
      /without recognized history migration records/,
    );

    expect(await snapshotTables(db)).toEqual(before);
    expect(
      await db.schema.withSchema('history_metadata').hasTable(historyLedger),
    ).toBe(false);
    expect(
      await db.schema
        .withSchema('history_metadata')
        .hasTable(`${historyLedger}_lock`),
    ).toBe(false);
  });

  it('initializes an empty dedicated ledger left by an interrupted first run', async () => {
    await db.migrate.list({
      directory: migrationsDir,
      tableName: historyLedger,
    });
    expect(await db(historyLedger).select('*')).toEqual([]);

    await ensureSchema(db);

    expect(await db(historyLedger).orderBy('id').pluck('name')).toEqual(
      historyMigrationNames,
    );
    expect(await db.schema.hasTable('catalog_history_cycles')).toBe(true);
    expect(await db.schema.hasTable('catalog_history_entities')).toBe(true);
    expect(await db.schema.hasTable(legacyLedger)).toBe(false);
  });

  it('initializes and repeats initialization using a pool with one connection', async () => {
    // Arrange: migration work must reuse the transaction's only connection.
    const client = knex({
      ...db.client.config,
      pool: { min: 0, max: 1 },
      acquireConnectionTimeout: 2000,
    });

    try {
      // Act: both fresh setup and a no-op retry must release the connection.
      await ensureSchema(client);
      const before = await snapshotTables(client);
      await ensureSchema(client);

      // Assert: queries still acquire the connection and metadata is unchanged.
      expect(await snapshotTables(client)).toEqual(before);
      expect(await client(historyLedger).orderBy('id').pluck('name')).toEqual(
        historyMigrationNames,
      );
      expect(await client(`${historyLedger}_lock`).select('*')).toEqual([
        { index: 1, is_locked: 0 },
      ]);
      expect(await client.schema.hasTable('catalog_history_cycles')).toBe(true);
      expect(await client.schema.hasTable('catalog_history_entities')).toBe(
        true,
      );
      expect(await client.schema.hasTable(legacyLedger)).toBe(false);
    } finally {
      await client.destroy();
    }
  });
});
