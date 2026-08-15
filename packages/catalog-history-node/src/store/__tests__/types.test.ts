import {
  HISTORY_MUTATION_TYPES,
  HISTORY_SOURCES,
} from '@kunickiaj/catalog-history-common';

/**
 * The store serializes CaptureSource/MutationType values into the Postgres
 * `source` and `mutation_type` columns, which carry CHECK constraints on
 * these exact literals. These tests pin the runtime values of the shared
 * enums so a rename in catalog-history-common cannot silently diverge from
 * what is persisted and enforced in the database.
 */
describe('shared enum runtime values match persisted database values', () => {
  it('pins HISTORY_SOURCES to the database source values', () => {
    expect([...HISTORY_SOURCES]).toEqual([
      'provider',
      'processing',
      'reconciler',
    ]);
  });

  it('pins HISTORY_MUTATION_TYPES to the database mutation_type values', () => {
    expect([...HISTORY_MUTATION_TYPES]).toEqual(['full', 'delta']);
  });
});
