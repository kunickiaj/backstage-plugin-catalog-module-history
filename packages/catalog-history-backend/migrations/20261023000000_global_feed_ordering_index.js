// @ts-check

const indexName = 'catalog_history_entities_changed_at_id_idx';

/**
 * Supports unfiltered history pages and their timestamp/ID cursor order.
 *
 * ensureSchema runs migrations inside a transaction, so this is a regular
 * index build, not CREATE INDEX CONCURRENTLY. It blocks history entity writes
 * while building; schedule upgrades of large retained histories accordingly.
 *
 * @param {import('knex').Knex} knex
 */
exports.up = async function up(knex) {
  await knex.raw('CREATE INDEX ?? ON ?? (?? DESC, ?? DESC)', [
    indexName,
    'catalog_history_entities',
    'changed_at',
    'id',
  ]);
};

/**
 * Removes only this index; recorded entity and cycle data are unchanged.
 *
 * @param {import('knex').Knex} knex
 */
exports.down = async function down(knex) {
  await knex.raw('DROP INDEX IF EXISTS ??', [indexName]);
};
