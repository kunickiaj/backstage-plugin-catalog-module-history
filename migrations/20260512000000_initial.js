// @ts-check

/**
 * @param {import('knex').Knex} knex
 */
exports.up = async function up(knex) {
  await knex.schema.createTable('catalog_history_cycles', table => {
    table.uuid('cycle_id').primary();
    table.text('provider').notNullable();
    table.text('mutation_type').notNullable();
    table.timestamp('started_at', { useTz: true }).notNullable();
    table.timestamp('finished_at', { useTz: true }).notNullable();
    table.integer('n_added').notNullable().defaultTo(0);
    table.integer('n_modified').notNullable().defaultTo(0);
    table.integer('n_removed').notNullable().defaultTo(0);
    table.integer('n_unchanged').notNullable().defaultTo(0);

    table.index(['provider', 'started_at']);
    table.index('started_at');
  });

  await knex.raw(`
    ALTER TABLE catalog_history_cycles
    ADD CONSTRAINT catalog_history_cycles_mutation_type_check
    CHECK (mutation_type IN ('full', 'delta'))
  `);

  await knex.schema.createTable('catalog_history_entities', table => {
    table.bigIncrements('id').primary();
    table
      .uuid('cycle_id')
      .notNullable()
      .references('cycle_id')
      .inTable('catalog_history_cycles')
      .onDelete('CASCADE');
    table.text('entity_ref').notNullable();
    table.text('kind').notNullable();
    table.text('namespace').notNullable();
    table.text('name').notNullable();
    table.text('provider').notNullable();
    table.text('op').notNullable();
    table.text('etag');
    table.text('display_name');
    table.text('email');
    table.text('parent');
    table.jsonb('member_of');
    table.text('owner');
    table.jsonb('metadata');
    table.jsonb('spec');
    table
      .timestamp('changed_at', { useTz: true })
      .notNullable()
      .defaultTo(knex.fn.now());

    table.index(['entity_ref', 'changed_at']);
    table.index('cycle_id');
    table.index(['provider', 'changed_at']);
  });

  await knex.raw(`
    ALTER TABLE catalog_history_entities
    ADD CONSTRAINT catalog_history_entities_op_check
    CHECK (op IN ('insert', 'update', 'delete'))
  `);

  await knex.raw(`
    CREATE INDEX catalog_history_entities_owner_partial_idx
    ON catalog_history_entities (owner)
    WHERE op <> 'delete'
  `);

  await knex.raw(`
    CREATE INDEX catalog_history_entities_parent_partial_idx
    ON catalog_history_entities (parent)
    WHERE op <> 'delete'
  `);

  await knex.raw(`
    CREATE INDEX catalog_history_entities_member_of_gin_idx
    ON catalog_history_entities
    USING GIN (member_of)
  `);
};

/**
 * @param {import('knex').Knex} knex
 */
exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('catalog_history_entities');
  await knex.schema.dropTableIfExists('catalog_history_cycles');
};
