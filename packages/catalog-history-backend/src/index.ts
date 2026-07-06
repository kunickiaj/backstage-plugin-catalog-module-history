/**
 * Storage, migrations, and history service factories for the Backstage
 * catalog history plugin family.
 *
 * @packageDocumentation
 */

export { ensureSchema } from './postgres/ensureSchema';
export { PostgresHistoryStore } from './postgres/PostgresHistoryStore';
export { historyStoreServiceFactory } from './service/historyStoreServiceFactory';
