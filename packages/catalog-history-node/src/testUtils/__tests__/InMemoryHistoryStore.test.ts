import { InMemoryHistoryStore } from '../InMemoryHistoryStore';
import type { CycleInput, EntityRow } from '../../store/types';
import type { ProviderMutationStore } from '../../store/HistoryStore';

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
  describe('provider mutation coordination', () => {
    it('serializes one provider while other providers and processing writes progress', async () => {
      // Arrange
      const store = new InMemoryHistoryStore();
      let release!: () => void;
      let entered!: () => void;
      const gate = new Promise<void>(resolve => {
        release = resolve;
      });
      const started = new Promise<void>(resolve => {
        entered = resolve;
      });
      const holding = store.withProviderMutation('okta-org', async scoped => {
        entered();
        await gate;
        await scoped.recordCycle(cycle({ inserts: [row('alice', 'first')] }));
      });
      await started;
      const later = jest.fn(async (scoped: ProviderMutationStore) => {
        const baseline = await scoped.loadCurrentEtags('okta-org');
        await scoped.recordCycle(
          cycle({ cycleId: 'later', updates: [row('alice', 'last')] }),
        );
        return baseline.get('user:default/alice');
      });
      // Act
      const waiting = store.withProviderMutation('okta-org', later);
      try {
        await store.withProviderMutation('other', scoped =>
          scoped.recordCycle(cycle({ provider: 'other', cycleId: 'other' })),
        );
        await store.recordCycle(
          cycle({ source: 'processing', cycleId: 'processing' }),
        );
        // Assert
        expect(later).not.toHaveBeenCalled();
        expect(store.cycles.map(item => item.cycleId)).toEqual([
          'other',
          'processing',
        ]);
      } finally {
        release();
        await holding;
      }
      expect(await waiting).toBe('first');
      expect(
        (await store.loadCurrentEtags('okta-org', { source: 'provider' })).get(
          'user:default/alice',
        ),
      ).toBe('last');
    });

    it('releases the queue and removes a recorded cycle when its callback fails', async () => {
      // Arrange
      const store = new InMemoryHistoryStore();
      // Act
      await expect(
        store.withProviderMutation('okta-org', async scoped => {
          await scoped.recordCycle(
            cycle({ inserts: [row('alice', 'aborted')] }),
          );
          throw new Error('callback failed');
        }),
      ).rejects.toThrow('callback failed');
      const baseline = await store.withProviderMutation(
        'okta-org',
        async scoped => {
          const previous = await scoped.loadCurrentEtags('okta-org');
          await scoped.recordCycle(
            cycle({
              cycleId: 'recovered',
              inserts: [row('alice', 'accepted')],
            }),
          );
          return previous;
        },
      );
      // Assert
      expect(baseline).toEqual(new Map());
      expect(store.cycles.map(item => item.cycleId)).toEqual(['recovered']);
      expect(
        (await store.loadCurrentEtags('okta-org')).get('user:default/alice'),
      ).toBe('accepted');
    });

    it('rejects a different provider, a different source, and use after callback completion', async () => {
      // Arrange
      const store = new InMemoryHistoryStore();
      let escaped!: ProviderMutationStore;
      // Act
      await store.withProviderMutation('okta-org', async scoped => {
        escaped = scoped;
        await expect(scoped.loadCurrentEtags('other')).rejects.toThrow();
        await expect(
          scoped.loadCurrentEtags('okta-org', { source: 'processing' }),
        ).rejects.toThrow();
        await expect(
          scoped.recordCycle(cycle({ provider: 'other' })),
        ).rejects.toThrow();
        await expect(
          scoped.recordCycle(cycle({ source: 'processing' })),
        ).rejects.toThrow();
        await scoped.recordCycle(cycle({ inserts: [row('alice', 'valid')] }));
      });
      // Assert
      await expect(escaped.loadCurrentEtags('okta-org')).rejects.toThrow();
      await expect(escaped.recordCycle(cycle())).rejects.toThrow();
      expect(store.cycles).toHaveLength(1);
      expect(
        (await store.loadCurrentEtags('okta-org')).get('user:default/alice'),
      ).toBe('valid');
    });

    it('stamps coordinated cycles above future legacy history despite regressing clocks', async () => {
      // Arrange
      const store = new InMemoryHistoryStore();
      await store.recordCycle(
        cycle({
          inserts: [row('alice', 'legacy')],
          finishedAt: new Date('2200-01-01'),
        }),
      );
      const clock = jest
        .spyOn(Date, 'now')
        .mockReturnValue(new Date('2026-01-01').getTime());
      // Act
      try {
        await store.withProviderMutation('okta-org', scoped =>
          scoped.recordCycle(
            cycle({ cycleId: 'first', updates: [row('alice', 'first')] }),
          ),
        );
        clock.mockReturnValue(new Date('2000-01-01').getTime());
        await store.withProviderMutation('okta-org', scoped =>
          scoped.recordCycle(
            cycle({ cycleId: 'last', updates: [row('alice', 'last')] }),
          ),
        );
        // Assert
        expect(+store.cycles[1].finishedAt).toBeGreaterThan(
          +store.cycles[0].finishedAt,
        );
        expect(+store.cycles[2].finishedAt).toBeGreaterThan(
          +store.cycles[1].finishedAt,
        );
        expect(
          (await store.loadCurrentEtags('okta-org')).get('user:default/alice'),
        ).toBe('last');
      } finally {
        clock.mockRestore();
      }
    });

    it('replays legacy cycles by timestamp with append order only breaking ties', async () => {
      // Arrange
      const store = new InMemoryHistoryStore();
      await store.recordCycle(
        cycle({
          cycleId: 'new',
          finishedAt: new Date('2030-01-01'),
          inserts: [row('alice', 'new')],
        }),
      );
      await store.recordCycle(
        cycle({
          cycleId: 'old',
          finishedAt: new Date('2000-01-01'),
          deletes: ['user:default/alice'],
        }),
      );
      // Act
      const beforeTie = await store.loadCurrentEtags('okta-org');
      await store.recordCycle(
        cycle({
          cycleId: 'tie',
          finishedAt: new Date('2030-01-01'),
          deletes: ['user:default/alice'],
        }),
      );
      const afterTie = await store.loadCurrentEtags('okta-org');
      // Assert
      expect(beforeTie.get('user:default/alice')).toBe('new');
      expect(afterTie.has('user:default/alice')).toBe(false);
    });
  });

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
