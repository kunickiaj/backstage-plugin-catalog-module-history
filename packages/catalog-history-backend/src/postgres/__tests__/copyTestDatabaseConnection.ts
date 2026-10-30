import type { Knex } from 'knex';

/** Preserve Knex's non-enumerable password when spreading or sending over IPC. */
export function copyTestDatabaseConnection(
  connection: Knex.PgConnectionConfig | string,
): Knex.PgConnectionConfig {
  if (typeof connection === 'string') return { connectionString: connection };
  return { ...connection, password: connection.password };
}
