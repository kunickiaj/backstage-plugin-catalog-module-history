import { Entity } from '@backstage/catalog-model';
import { CatalogClient } from '@backstage/catalog-client';
import { LoggerService } from '@backstage/backend-plugin-api';
import { knex as createKnex } from 'knex';
import { ensureSchema } from '../postgres/ensureSchema';
import { PostgresHistoryStore } from '../postgres/PostgresHistoryStore';
import { reconcile } from '../reconciler/reconcile';
import { EntityFetcher } from '../reconciler/EntityFetcher';

const stderrLogger: LoggerService = {
  info(message, meta) {
    process.stdout.write(
      `info  ${message}${meta ? ` ${formatMeta(meta)}` : ''}\n`,
    );
  },
  warn(message, meta) {
    process.stderr.write(
      `warn  ${message}${meta ? ` ${formatMeta(meta)}` : ''}\n`,
    );
  },
  error(message, meta) {
    process.stderr.write(
      `error ${message}${meta ? ` ${formatMeta(meta)}` : ''}\n`,
    );
  },
  debug(message, meta) {
    if (process.env.DEBUG) {
      process.stderr.write(
        `debug ${message}${meta ? ` ${formatMeta(meta)}` : ''}\n`,
      );
    }
  },
  child() {
    return stderrLogger;
  },
};

function formatMeta(meta: Error | Record<string, unknown>): string {
  if (meta instanceof Error) {
    return `(${meta.message})`;
  }
  return JSON.stringify(meta);
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
}

/**
 * Standalone entry point: reads connection info from env vars, snapshots
 * the catalog over HTTP via CatalogClient, and reconciles drift into the
 * Postgres history store.
 *
 * In a default Backstage deployment this CLI is unnecessary: the module
 * (Phase 7) registers an in-process scheduled task that calls reconcile()
 * with the in-process catalog service. Use this CLI for ad-hoc backfills,
 * debugging, or as the entry point for an external CronJob when you want
 * the reconciler decoupled from the backend's lifecycle.
 */
export async function main(): Promise<void> {
  const backstageBaseUrl = required('BACKSTAGE_BASE_URL').replace(/\/$/, '');
  const backstageToken = process.env.BACKSTAGE_TOKEN;
  const pgConnection = required('PG_CONNECTION_STRING');

  const catalogClient = new CatalogClient({
    discoveryApi: {
      async getBaseUrl(pluginId: string): Promise<string> {
        return `${backstageBaseUrl}/api/${pluginId}`;
      },
    },
  });

  const fetcher: EntityFetcher = {
    async getEntities(): Promise<Entity[]> {
      const response = await catalogClient.getEntities(
        {},
        backstageToken ? { token: backstageToken } : undefined,
      );
      return response.items;
    },
  };

  const db = createKnex({
    client: 'pg',
    connection: pgConnection,
  });

  try {
    await ensureSchema(db);
    const store = new PostgresHistoryStore(db);
    await reconcile({ fetcher, store, logger: stderrLogger });
  } finally {
    await db.destroy();
  }
}
