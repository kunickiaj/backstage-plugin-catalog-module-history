import { readdir } from 'node:fs/promises';
import type { Knex } from 'knex';
import { resolvePackagePath } from '@backstage/backend-plugin-api';

// Note: resolvePackagePath runs at module-load time and requires this
// package to be resolvable in node_modules; bundling this package into a
// single file will break migration resolution.
const migrationsDir = resolvePackagePath(
  '@kunickiaj/backstage-plugin-catalog-history-storage-node',
  'migrations',
);

const HISTORY_MIGRATIONS_TABLE = 'catalog_history_knex_migrations';

async function migrationNames(
  db: Knex,
  tableName: string,
  schemaName?: string,
): Promise<string[]> {
  const schema = schemaName ? db.schema.withSchema(schemaName) : db.schema;
  if (!(await schema.hasTable(tableName))) return [];
  const query = db<{ name: string }>(tableName);
  if (schemaName) query.withSchema(schemaName);
  return (await query.select('name')).map(row => row.name);
}

async function migrationTable(db: Knex): Promise<string> {
  const configured = db.client.config.migrations;
  const schemaName = configured?.schemaName;
  const dedicated = await migrationNames(
    db,
    HISTORY_MIGRATIONS_TABLE,
    schemaName,
  );
  if (dedicated.length > 0) return HISTORY_MIGRATIONS_TABLE;

  const legacyTable = configured?.tableName ?? 'knex_migrations';
  const legacy = await migrationNames(db, legacyTable, schemaName);
  const files = new Set(
    (await readdir(migrationsDir)).filter(name => name.endsWith('.js')),
  );
  const historyCount = legacy.filter(name => files.has(name)).length;
  if (historyCount > 0 && historyCount === legacy.length) return legacyTable;
  if (historyCount > 0) {
    throw new Error(
      `History migration records are mixed with unrelated migrations in ${schemaName ? `${schemaName}.` : ''}${legacyTable}; automatic migration refused. Back up and reconcile the migration records before retrying.`,
    );
  }

  // migrations.schemaName scopes Knex's ledger, not the history data tables.
  if (
    (await db.schema.hasTable('catalog_history_cycles')) ||
    (await db.schema.hasTable('catalog_history_entities'))
  ) {
    // Another initializer may have committed after the first ledger read.
    if (
      (await migrationNames(db, HISTORY_MIGRATIONS_TABLE, schemaName)).length >
      0
    ) {
      return HISTORY_MIGRATIONS_TABLE;
    }
    throw new Error(
      'History tables exist without recognized history migration records; automatic migration refused. Back up and reconcile the schema and migration records before retrying.',
    );
  }
  return HISTORY_MIGRATIONS_TABLE;
}

export async function ensureSchema(db: Knex): Promise<void> {
  await db.transaction(async trx => {
    // Knex creates migration metadata before it can acquire its own lock.
    await trx.raw('SELECT pg_advisory_xact_lock(hashtext(?))', [
      'catalog-history:ensure-schema',
    ]);
    await trx.migrate.latest({
      directory: migrationsDir,
      tableName: await migrationTable(trx),
    });
  });
}
