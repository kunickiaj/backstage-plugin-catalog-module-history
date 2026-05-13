import { CurrentEtag, HistoryStore } from '../HistoryStore';
import { CycleInput } from '../types';

export class InMemoryHistoryStore implements HistoryStore {
  readonly cycles: CycleInput[] = [];
  private readonly etagsByProvider = new Map<string, Map<string, string>>();
  private readonly globalLatest = new Map<string, CurrentEtag>();

  async loadCurrentEtags(provider: string): Promise<Map<string, string>> {
    const existing = this.etagsByProvider.get(provider);
    return new Map(existing ?? []);
  }

  async loadAllCurrentEtags(): Promise<Map<string, CurrentEtag>> {
    return new Map(this.globalLatest);
  }

  async recordCycle(input: CycleInput): Promise<void> {
    this.cycles.push(input);

    let etags = this.etagsByProvider.get(input.provider);
    if (!etags) {
      etags = new Map();
      this.etagsByProvider.set(input.provider, etags);
    }

    for (const row of input.inserts) {
      etags.set(row.entityRef, row.etag);
      this.globalLatest.set(row.entityRef, {
        etag: row.etag,
        provider: input.provider,
      });
    }
    for (const row of input.updates) {
      etags.set(row.entityRef, row.etag);
      this.globalLatest.set(row.entityRef, {
        etag: row.etag,
        provider: input.provider,
      });
    }
    for (const ref of input.deletes) {
      etags.delete(ref);
      // A delete is the newest observation for this entity_ref across all
      // providers, so the global entry drops regardless of which provider
      // had previously claimed it. Mirrors PostgresHistoryStore semantics
      // where DISTINCT ON ... ORDER BY changed_at DESC picks the latest
      // row globally and filters when its op is 'delete'.
      this.globalLatest.delete(ref);
    }
  }
}
