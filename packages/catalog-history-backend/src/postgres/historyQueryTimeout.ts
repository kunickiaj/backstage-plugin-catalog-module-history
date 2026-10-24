import type { Knex } from 'knex';

const DEFAULT_QUERY_TIMEOUT_MS = 10_000;
const MAX_QUERY_TIMEOUT_MS = 2_147_483_647;

export function normalizeQueryTimeoutMs(value: number | undefined): number {
  if (value === undefined) {
    return DEFAULT_QUERY_TIMEOUT_MS;
  }
  if (!Number.isInteger(value) || value < 0 || value > MAX_QUERY_TIMEOUT_MS) {
    throw new Error(
      'catalog.history.api.queryTimeoutMs must be an integer between 0 and 2147483647',
    );
  }
  return value;
}

export async function withHistoryQueryTimeout<T>(
  db: Knex,
  queryTimeoutMs: number,
  read: (executor: Knex) => PromiseLike<T>,
): Promise<T> {
  if (queryTimeoutMs === 0) {
    return read(db);
  }
  return db.transaction(async trx => {
    // pg_settings normalizes statement_timeout to milliseconds, unlike SHOW.
    const previous = await trx<{ setting: string }>('pg_catalog.pg_settings')
      .select('setting')
      .where('name', 'statement_timeout')
      .first();
    if (!previous) {
      throw new Error('PostgreSQL statement_timeout setting is unavailable');
    }
    const previousMs = Number(previous.setting);
    const effectiveMs =
      previousMs > 0 ? Math.min(queryTimeoutMs, previousMs) : queryTimeoutMs;
    await trx.raw('select pg_catalog.set_config(?, ?, true)', [
      'statement_timeout',
      String(effectiveMs),
    ]);
    const result = await read(trx);
    // RELEASE SAVEPOINT preserves SET LOCAL in a parent transaction. Restore
    // on success; on errors, Knex rollback reverts it without masking SQL errors.
    await trx.raw('select pg_catalog.set_config(?, ?, true)', [
      'statement_timeout',
      previous.setting,
    ]);
    return result;
  });
}
