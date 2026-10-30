import type {
  CurrentEtag,
  HistoryStore,
  ProviderMutationStore,
} from '../store/HistoryStore';
import type { CaptureSource, CycleInput } from '../store/types';

/**
 * Test double for HistoryStore. Deliberately dumb: `cycles` is the single
 * source of truth, and the load methods fold over it on every call instead
 * of maintaining eager indexes. Replaying in timestamp and append order reproduces
 * PostgresHistoryStore's DISTINCT ON ... ORDER BY changed_at DESC, id DESC
 * semantics (last write wins; a delete removes the entry), including the
 * per-source and per-provider filters.
 */
export class InMemoryHistoryStore implements HistoryStore {
  readonly cycles: CycleInput[] = [];
  private readonly providerMutations = new Map<string, Promise<void>>();
  private readonly providerTimestamps = new Map<string, number>();

  async withProviderMutation<T>(
    provider: string,
    work: (store: ProviderMutationStore) => Promise<T>,
  ): Promise<T> {
    const previous = this.providerMutations.get(provider);
    let release!: () => void;
    const tail = new Promise<void>(resolve => {
      release = resolve;
    });
    this.providerMutations.set(provider, tail);
    await previous;
    try {
      return await this.runProviderMutation(provider, work);
    } finally {
      release();
      if (this.providerMutations.get(provider) === tail) {
        this.providerMutations.delete(provider);
      }
    }
  }

  private async runProviderMutation<T>(
    provider: string,
    work: (store: ProviderMutationStore) => Promise<T>,
  ): Promise<T> {
    const startedAt = this.nextProviderTimestamp(provider);
    let active = true;
    let recorded: CycleInput | undefined;
    const assertScope = (name: string, source = 'provider') => {
      if (!active || name !== provider || source !== 'provider') {
        throw new Error('Provider mutation scope is inactive or mismatched');
      }
    };
    const store: ProviderMutationStore = {
      loadCurrentEtags: async (name, opts) => {
        assertScope(name, opts?.source);
        return this.loadCurrentEtags(name, { source: 'provider' });
      },
      recordCycle: async input => {
        assertScope(input.provider, input.source);
        if (recorded) throw new Error('Provider mutation already recorded');
        const finishedAt = new Date(Math.max(Date.now(), +startedAt + 1));
        recorded = { ...input, startedAt, finishedAt };
        await this.recordCycle(recorded);
      },
    };
    try {
      const result = await work(store);
      if (!recorded) throw new Error('Provider mutation must record one cycle');
      this.providerTimestamps.set(provider, recorded.finishedAt.getTime());
      return result;
    } catch (error) {
      const index = recorded ? this.cycles.indexOf(recorded) : -1;
      if (index >= 0) this.cycles.splice(index, 1);
      throw error;
    } finally {
      active = false;
    }
  }

  private nextProviderTimestamp(provider: string): Date {
    let floor = this.providerTimestamps.get(provider) ?? 0;
    for (const cycle of this.cycles) {
      if (cycle.provider === provider && cycle.source === 'provider') {
        floor = Math.max(floor, +cycle.startedAt, +cycle.finishedAt);
      }
    }
    return new Date(Math.max(Date.now(), floor + 1));
  }

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
    const ordered = [...this.cycles].sort(
      (left, right) => +left.finishedAt - +right.finishedAt,
    );
    for (const cycle of ordered) {
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
