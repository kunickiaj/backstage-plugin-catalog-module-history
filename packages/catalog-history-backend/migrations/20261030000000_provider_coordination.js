// @ts-check

/** @param {import('knex').Knex} knex */
exports.up = async function up(knex) {
  // This floor survives retention, including deletion of an entire stream.
  await knex.schema.createTable(
    'catalog_history_provider_coordination',
    table => {
      table.text('provider').notNullable();
      table.text('source').notNullable();
      table.timestamp('last_timestamp', { useTz: true }).notNullable();
      table.primary(['provider', 'source']);
    },
  );
};

/** @param {import('knex').Knex} knex */
exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('catalog_history_provider_coordination');
};
