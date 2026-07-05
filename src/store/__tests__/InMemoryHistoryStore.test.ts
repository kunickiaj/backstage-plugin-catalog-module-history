import { InMemoryHistoryStore } from './InMemoryHistoryStore';
import { CycleInput, EntityRow } from '../types';

function row(
  name: string,
  etag: string,
  overrides: Partial<EntityRow> = {},
): EntityRow {
  return {
    entityRef: `user:default/${name}`,
    kind: 'User',
    namespace: 'default',
    name,
    etag,
    metadata: {},
    spec: {},
    ...overrides,
  };
}

function cycle(overrides: Partial<CycleInput> = {}): CycleInput {
  return {
    cycleId: 'c1',
    provider: 'okta-org',
    source: 'provider',
    mutationType: 'full',
    startedAt: new Date('2026-05-12T10:00:00Z'),
    finishedAt: new Date('2026-05-12T10:00:01Z'),
    inserts: [],
    updates: [],
    deletes: [],
    unchangedCount: 0,
    ...overrides,
  };
}

describe('InMemoryHistoryStore', () => {
  it('returns an empty map for an unknown provider', async () => {
    const store = new InMemoryHistoryStore();
    const etags = await store.loadCurrentEtags('okta-org');
    expect(etags.size).toBe(0);
  });

  it('records inserts and exposes their etags', async () => {
    const store = new InMemoryHistoryStore();
    await store.recordCycle(
      cycle({
        cycleId: 'c1',
        inserts: [row('alice', 'a1'), row('bob', 'b1')],
      }),
    );

    const etags = await store.loadCurrentEtags('okta-org');
    expect(etags.get('user:default/alice')).toBe('a1');
    expect(etags.get('user:default/bob')).toBe('b1');
    expect(store.cycles).toHaveLength(1);
  });

  it('returns the latest etag after updates across cycles', async () => {
    const store = new InMemoryHistoryStore();
    await store.recordCycle(
      cycle({ cycleId: 'c1', inserts: [row('alice', 'a1')] }),
    );
    await store.recordCycle(
      cycle({ cycleId: 'c2', updates: [row('alice', 'a2')] }),
    );

    const etags = await store.loadCurrentEtags('okta-org');
    expect(etags.get('user:default/alice')).toBe('a2');
  });

  it('omits deleted entities from loadCurrentEtags', async () => {
    const store = new InMemoryHistoryStore();
    await store.recordCycle(
      cycle({ cycleId: 'c1', inserts: [row('alice', 'a1'), row('bob', 'b1')] }),
    );
    await store.recordCycle(
      cycle({ cycleId: 'c2', deletes: ['user:default/bob'] }),
    );

    const etags = await store.loadCurrentEtags('okta-org');
    expect(etags.get('user:default/alice')).toBe('a1');
    expect(etags.has('user:default/bob')).toBe(false);
  });

  it('scopes etags by provider', async () => {
    const store = new InMemoryHistoryStore();
    await store.recordCycle(
      cycle({ provider: 'okta-org', inserts: [row('alice', 'a-okta')] }),
    );
    await store.recordCycle(
      cycle({
        provider: 'github-org',
        cycleId: 'c2',
        inserts: [row('alice', 'a-github')],
      }),
    );

    const okta = await store.loadCurrentEtags('okta-org');
    const github = await store.loadCurrentEtags('github-org');
    expect(okta.get('user:default/alice')).toBe('a-okta');
    expect(github.get('user:default/alice')).toBe('a-github');
  });

  it('records heartbeat cycles with no row changes', async () => {
    const store = new InMemoryHistoryStore();
    await store.recordCycle(cycle({ cycleId: 'c1', unchangedCount: 42 }));

    expect(store.cycles).toHaveLength(1);
    expect(store.cycles[0].unchangedCount).toBe(42);
    expect((await store.loadCurrentEtags('okta-org')).size).toBe(0);
  });

  it('filters provider etags by source when requested', async () => {
    const store = new InMemoryHistoryStore();
    await store.recordCycle(
      cycle({
        cycleId: 'c1',
        source: 'provider',
        inserts: [row('alice', 'provider-etag')],
      }),
    );
    await store.recordCycle(
      cycle({
        cycleId: 'c2',
        source: 'processing',
        updates: [row('alice', 'processing-etag')],
      }),
    );

    expect(
      (await store.loadCurrentEtags('okta-org')).get('user:default/alice'),
    ).toBe('processing-etag');
    expect(
      (await store.loadCurrentEtags('okta-org', { source: 'provider' })).get(
        'user:default/alice',
      ),
    ).toBe('provider-etag');
    expect(
      (await store.loadCurrentEtags('okta-org', { source: 'processing' })).get(
        'user:default/alice',
      ),
    ).toBe('processing-etag');
  });

  it('returns an independent copy of the etags map', async () => {
    const store = new InMemoryHistoryStore();
    await store.recordCycle(
      cycle({ cycleId: 'c1', inserts: [row('alice', 'a1')] }),
    );

    const first = await store.loadCurrentEtags('okta-org');
    first.set('user:default/eve', 'tampered');

    const second = await store.loadCurrentEtags('okta-org');
    expect(second.has('user:default/eve')).toBe(false);
    expect(second.size).toBe(1);
  });

  describe('loadAllCurrentEtags cross-provider delete semantics', () => {
    it('drops the global entry when a different provider deletes the ref', async () => {
      const store = new InMemoryHistoryStore();

      // Provider B claims the entity first.
      await store.recordCycle(
        cycle({
          cycleId: 'c1',
          provider: 'github-org',
          inserts: [row('alice', 'a-github')],
        }),
      );

      // Provider A subsequently deletes the same entity_ref.
      await store.recordCycle(
        cycle({
          cycleId: 'c2',
          provider: 'okta-org',
          deletes: ['user:default/alice'],
        }),
      );

      const all = await store.loadAllCurrentEtags();
      // Mirrors Postgres: latest row is the delete, so the entity is gone
      // globally regardless of which provider issued the delete.
      expect(all.has('user:default/alice')).toBe(false);
    });

    it('filters global etags by source when requested', async () => {
      const store = new InMemoryHistoryStore();

      await store.recordCycle(
        cycle({
          cycleId: 'c1',
          provider: 'okta-org',
          source: 'provider',
          inserts: [row('alice', 'provider-etag')],
        }),
      );
      await store.recordCycle(
        cycle({
          cycleId: 'c2',
          provider: 'catalog-processor',
          source: 'processing',
          inserts: [row('bob', 'processing-etag')],
        }),
      );

      const all = await store.loadAllCurrentEtags();
      const processing = await store.loadAllCurrentEtags({
        source: 'processing',
      });

      expect(all.has('user:default/alice')).toBe(true);
      expect(all.has('user:default/bob')).toBe(true);
      expect(processing.has('user:default/alice')).toBe(false);
      expect(processing.get('user:default/bob')).toEqual({
        etag: 'processing-etag',
        provider: 'catalog-processor',
      });
    });
  });
});
