// @ts-check

const indexName = 'catalog_history_entities_name_prefix_idx';

/**
 * Index only 128 folded characters so existing unbounded names remain writable.
 * The regular build blocks entity writes until the migration commits. ANALYZE
 * supplies expression statistics before discovery queries use the new index.
 *
 * @param {import('knex').Knex} knex
 */
exports.up = async function up(knex) {
  await knex.raw(
    'CREATE INDEX ?? ON catalog_history_entities ((left(lower(name), 128) COLLATE "C") text_pattern_ops)',
    [indexName],
  );
  await knex.raw('ANALYZE catalog_history_entities');
};

/** @param {import('knex').Knex} knex */
exports.down = async function down(knex) {
  await knex.raw('DROP INDEX IF EXISTS ??', [indexName]);
};
