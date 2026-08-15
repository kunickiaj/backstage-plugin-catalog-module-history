import { Knex } from 'knex';
import { resolvePackagePath } from '@backstage/backend-plugin-api';

// Note: resolvePackagePath runs at module-load time and requires this
// package to be resolvable in node_modules; bundling this package into a
// single file will break migration resolution.
const migrationsDir = resolvePackagePath(
  '@kunickiaj/catalog-history-backend',
  'migrations',
);

export async function ensureSchema(db: Knex): Promise<void> {
  await db.migrate.latest({
    directory: migrationsDir,
  });
}
