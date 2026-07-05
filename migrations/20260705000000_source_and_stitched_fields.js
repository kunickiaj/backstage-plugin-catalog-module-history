// @ts-check

/**
 * @param {import('knex').Knex} knex
 */
exports.up = async function up(knex) {
  await knex.schema.alterTable('catalog_history_cycles', table => {
    table.text('source').notNullable().defaultTo('provider');
  });

  await knex.raw(`
    ALTER TABLE catalog_history_cycles
    ADD CONSTRAINT catalog_history_cycles_source_check
    CHECK (source IN ('provider', 'processing', 'reconciler'))
  `);

  await knex.raw(`
    UPDATE catalog_history_cycles
    SET source = 'reconciler'
    WHERE provider = 'reconciler'
  `);

  await knex.schema.alterTable('catalog_history_entities', table => {
    table.text('source').notNullable().defaultTo('provider');
    table.jsonb('relations');
    table.jsonb('status_items');
    table.boolean('orphan');

    table.index(['source', 'changed_at']);
  });

  await knex.raw(`
    ALTER TABLE catalog_history_entities
    ADD CONSTRAINT catalog_history_entities_source_check
    CHECK (source IN ('provider', 'processing', 'reconciler'))
  `);

  await knex.raw(`
    UPDATE catalog_history_entities
    SET source = 'reconciler'
    WHERE provider = 'reconciler'
  `);
};

/**
 * @param {import('knex').Knex} knex
 */
exports.down = async function down(knex) {
  await knex.raw(`
    ALTER TABLE catalog_history_entities
    DROP CONSTRAINT IF EXISTS catalog_history_entities_source_check
  `);

  await knex.raw(`
    ALTER TABLE catalog_history_cycles
    DROP CONSTRAINT IF EXISTS catalog_history_cycles_source_check
  `);

  await knex.schema.alterTable('catalog_history_entities', table => {
    table.dropIndex(['source', 'changed_at']);
    table.dropColumn('orphan');
    table.dropColumn('status_items');
    table.dropColumn('relations');
    table.dropColumn('source');
  });

  await knex.schema.alterTable('catalog_history_cycles', table => {
    table.dropColumn('source');
  });
};
