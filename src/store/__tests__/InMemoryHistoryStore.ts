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
      // Only clear the global entry if it was last touched by this provider;
      // otherwise the most-recent owner of the ref still wins.
      const cur = this.globalLatest.get(ref);
      if (cur?.provider === input.provider) {
        this.globalLatest.delete(ref);
      }
    }
  }
}
