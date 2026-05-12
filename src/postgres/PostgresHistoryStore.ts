import { Knex } from 'knex';
import { HistoryStore } from '../store/HistoryStore';
import { CycleInput } from '../store/types';

export class PostgresHistoryStore implements HistoryStore {
  constructor(private readonly db: Knex) {}

  async loadCurrentEtags(provider: string): Promise<Map<string, string>> {
    const rows = await this.db
      .with(
        'latest',
        this.db('catalog_history_entities')
          .select('entity_ref', 'op', 'etag')
          .distinctOn('entity_ref')
          .where({ provider })
          .orderBy('entity_ref')
          .orderBy('changed_at', 'desc'),
      )
      .from('latest')
      .where('op', '!=', 'delete')
      .select('entity_ref', 'etag');

    const result = new Map<string, string>();
    for (const row of rows) {
      if (row.etag !== null && row.etag !== undefined) {
        result.set(row.entity_ref, row.etag);
      }
    }
    return result;
  }

  async recordCycle(_input: CycleInput): Promise<void> {
    throw new Error('not implemented');
  }
}
