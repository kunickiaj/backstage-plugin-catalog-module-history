import { knex, type Knex } from 'knex';

/** A separate pool leaves catalog connections available during forwarding. */
export function createProviderCoordinationDatabase(db: Knex): Knex {
  const config = db.client.config;
  return knex({
    // Keep dynamic credentials, SSL, searchPath, and connection setup hooks.
    ...config,
    acquireConnectionTimeout: 5_000,
    pool: {
      ...config.pool,
      min: 0,
      max: Math.min(config.pool?.max ?? 10, 10),
      acquireTimeoutMillis: 5_000,
      // Connection failures must reject rather than look like pool contention.
      propagateCreateError: true,
    },
  });
}
