import { Knex } from 'knex';
import { resolvePackagePath } from '@backstage/backend-plugin-api';

const migrationsDir = resolvePackagePath(
  'backstage-plugin-catalog-backend-module-history',
  'migrations',
);

export async function ensureSchema(db: Knex): Promise<void> {
  await db.migrate.latest({
    directory: migrationsDir,
  });
}
