import { CurrentEtag, HistoryStore } from '../store/HistoryStore';
import { CaptureSource, CycleInput } from '../store/types';

/**
 * Test double for HistoryStore. Deliberately dumb: `cycles` is the single
 * source of truth, and the load methods fold over it on every call instead
 * of maintaining eager indexes. Replaying in recorded order reproduces
 * PostgresHistoryStore's DISTINCT ON ... ORDER BY changed_at DESC, id DESC
 * semantics (last write wins; a delete removes the entry), including the
 * per-source and per-provider filters.
 */
export class InMemoryHistoryStore implements HistoryStore {
  readonly cycles: CycleInput[] = [];

  async loadCurrentEtags(
    provider: string,
    opts: { source?: CaptureSource } = {},
  ): Promise<Map<string, string>> {
    const latest = this.replay(
      cycle =>
        cycle.provider === provider &&
        (opts.source === undefined || cycle.source === opts.source),
    );
    return new Map(
      [...latest.entries()].map(([ref, current]) => [ref, current.etag]),
    );
  }

  async loadAllCurrentEtags(
    opts: { source?: CaptureSource } = {},
  ): Promise<Map<string, CurrentEtag>> {
    return this.replay(
      cycle => opts.source === undefined || cycle.source === opts.source,
    );
  }

  async recordCycle(input: CycleInput): Promise<void> {
    this.cycles.push(input);
  }

  private replay(
    includeCycle: (cycle: CycleInput) => boolean,
  ): Map<string, CurrentEtag> {
    const latest = new Map<string, CurrentEtag>();
    for (const cycle of this.cycles) {
      if (!includeCycle(cycle)) {
        continue;
      }
      for (const row of [...cycle.inserts, ...cycle.updates]) {
        latest.set(row.entityRef, {
          etag: row.etag,
          provider: cycle.provider,
        });
      }
      for (const ref of cycle.deletes) {
        // The delete is the newest observation for this ref within the
        // replayed scope, so the entry drops — mirroring Postgres where the
        // latest row wins and delete rows are filtered out of the result.
        latest.delete(ref);
      }
    }
    return latest;
  }
}
