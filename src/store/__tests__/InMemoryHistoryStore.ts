import { HistoryStore } from '../HistoryStore';
import { CycleInput } from '../types';

export class InMemoryHistoryStore implements HistoryStore {
  readonly cycles: CycleInput[] = [];
  private readonly etagsByProvider = new Map<string, Map<string, string>>();

  async loadCurrentEtags(provider: string): Promise<Map<string, string>> {
    const existing = this.etagsByProvider.get(provider);
    return new Map(existing ?? []);
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
    }
    for (const row of input.updates) {
      etags.set(row.entityRef, row.etag);
    }
    for (const ref of input.deletes) {
      etags.delete(ref);
    }
  }
}
