import { Entity } from '@backstage/catalog-model';
import {
  EntityProvider,
  EntityProviderConnection,
} from '@backstage/plugin-catalog-node';
import { mockServices } from '@backstage/backend-test-utils';
import { InMemoryHistoryStore } from '@kunickiaj/catalog-history-node/testUtils';
import { HistoryRecordingEntityProvider } from '../HistoryRecordingEntityProvider';

class FakeProvider implements EntityProvider {
  applyMutationSpy = jest.fn();

  constructor(
    private readonly name: string,
    private readonly entities: Entity[],
  ) {}

  getProviderName(): string {
    return this.name;
  }

  async connect(connection: EntityProviderConnection): Promise<void> {
    await connection.applyMutation({
      type: 'full',
      entities: this.entities.map(entity => ({ entity })),
    });
  }
}

function fakeConnection(): EntityProviderConnection {
  return {
    applyMutation: jest.fn(),
    refresh: jest.fn(),
  };
}

function user(name: string, etag: string): Entity {
  return {
    apiVersion: 'backstage.io/v1alpha1',
    kind: 'User',
    metadata: { name, namespace: 'default', etag },
    spec: { profile: { displayName: name } },
  };
}

function group(name: string, etag: string): Entity {
  return {
    apiVersion: 'backstage.io/v1alpha1',
    kind: 'Group',
    metadata: { name, namespace: 'default', etag },
    spec: { type: 'team', profile: { displayName: name } },
  };
}

describe('HistoryRecordingEntityProvider', () => {
  it('records a single cycle of inserts when wrapping a fresh full mutation', async () => {
    const store = new InMemoryHistoryStore();
    const inner = new FakeProvider('okta-org', [
      user('alice', 'a1'),
      user('bob', 'b1'),
      group('platform', 'g1'),
    ]);
    const logger = mockServices.logger.mock();
    const wrapper = new HistoryRecordingEntityProvider({
      inner,
      store,
      logger,
    });

    const connection = fakeConnection();
    await wrapper.connect(connection);

    expect(wrapper.getProviderName()).toBe('okta-org');

    expect(connection.applyMutation).toHaveBeenCalledTimes(1);
    const mutation = (connection.applyMutation as jest.Mock).mock.calls[0][0];
    expect(mutation.type).toBe('full');
    expect(mutation.entities).toHaveLength(3);

    expect(store.cycles).toHaveLength(1);
    expect(store.cycles[0]).toMatchObject({
      provider: 'okta-org',
      mutationType: 'full',
      inserts: expect.any(Array),
      updates: [],
      deletes: [],
      unchangedCount: 0,
    });
    expect(store.cycles[0].inserts).toHaveLength(3);
    const refs = store.cycles[0].inserts.map(r => r.entityRef).sort();
    expect(refs).toEqual([
      'group:default/platform',
      'user:default/alice',
      'user:default/bob',
    ]);
  });

  it('forwards mutations without recording when enabled=false', async () => {
    const store = new InMemoryHistoryStore();
    const inner = new FakeProvider('okta-org', [user('alice', 'a1')]);
    const logger = mockServices.logger.mock();
    const wrapper = new HistoryRecordingEntityProvider({
      inner,
      store,
      logger,
      enabled: false,
    });

    const connection = fakeConnection();
    await wrapper.connect(connection);

    expect(wrapper.getProviderName()).toBe('okta-org');
    expect(connection.applyMutation).toHaveBeenCalledTimes(1);
    const mutation = (connection.applyMutation as jest.Mock).mock.calls[0][0];
    expect(mutation.type).toBe('full');
    expect(mutation.entities).toHaveLength(1);
    expect(store.cycles).toHaveLength(0);
  });

  async function setup(initial: Entity[]) {
    const store = new InMemoryHistoryStore();
    const logger = mockServices.logger.mock();
    let wrapped: EntityProviderConnection | undefined;

    const inner: EntityProvider = {
      getProviderName: () => 'okta-org',
      connect: async (conn: EntityProviderConnection) => {
        wrapped = conn;
        await conn.applyMutation({
          type: 'full',
          entities: initial.map(entity => ({ entity })),
        });
      },
    };

    const wrapper = new HistoryRecordingEntityProvider({
      inner,
      store,
      logger,
    });
    await wrapper.connect(fakeConnection());

    if (!wrapped)
      throw new Error('connect did not install a wrapped connection');
    return { store, logger, wrapped };
  }

  async function applyFull(
    conn: EntityProviderConnection,
    entities: Entity[],
  ): Promise<void> {
    await conn.applyMutation({
      type: 'full',
      entities: entities.map(entity => ({ entity })),
    });
  }

  describe('etag-skip diffing across cycles', () => {
    it('records a heartbeat cycle when the next mutation is identical', async () => {
      const entities = [
        user('alice', 'a1'),
        user('bob', 'b1'),
        group('platform', 'g1'),
      ];
      const { store, wrapped } = await setup(entities);

      await applyFull(wrapped, entities);

      expect(store.cycles).toHaveLength(2);
      expect(store.cycles[1]).toMatchObject({
        provider: 'okta-org',
        mutationType: 'full',
        inserts: [],
        updates: [],
        deletes: [],
        unchangedCount: 3,
      });
    });

    it('records one update when a single entity changes etag', async () => {
      const initial = [
        user('alice', 'a1'),
        user('bob', 'b1'),
        group('platform', 'g1'),
      ];
      const { store, wrapped } = await setup(initial);

      const aliceV2 = user('alice', 'a2');
      await applyFull(wrapped, [
        aliceV2,
        user('bob', 'b1'),
        group('platform', 'g1'),
      ]);

      expect(store.cycles).toHaveLength(2);
      expect(store.cycles[1]).toMatchObject({
        inserts: [],
        deletes: [],
        unchangedCount: 2,
      });
      expect(store.cycles[1].updates).toHaveLength(1);
      expect(store.cycles[1].updates[0]).toMatchObject({
        entityRef: 'user:default/alice',
        etag: 'a2',
      });
    });

    it('records an insert and a delete when an entity is swapped out', async () => {
      const initial = [
        user('alice', 'a1'),
        user('bob', 'b1'),
        group('platform', 'g1'),
      ];
      const { store, wrapped } = await setup(initial);

      await applyFull(wrapped, [
        user('alice', 'a1'),
        user('carol', 'c1'),
        group('platform', 'g1'),
      ]);

      expect(store.cycles).toHaveLength(2);
      expect(store.cycles[1]).toMatchObject({
        updates: [],
        unchangedCount: 2,
      });
      expect(store.cycles[1].inserts).toHaveLength(1);
      expect(store.cycles[1].inserts[0].entityRef).toBe('user:default/carol');
      expect(store.cycles[1].deletes).toEqual(['user:default/bob']);
    });
  });

  describe('delta mutation recording', () => {
    it('records a delta with only added entities as inserts/updates/unchanged', async () => {
      const { store, wrapped } = await setup([
        user('alice', 'a1'),
        user('bob', 'b1'),
      ]);

      await wrapped.applyMutation({
        type: 'delta',
        added: [
          { entity: user('alice', 'a2') }, // existing ref, different etag → update
          { entity: user('bob', 'b1') }, // existing ref, same etag → unchanged
          { entity: user('carol', 'c1') }, // new ref → insert
        ],
        removed: [],
      });

      expect(store.cycles).toHaveLength(2); // initial full + this delta
      const delta = store.cycles[1];
      expect(delta).toMatchObject({
        provider: 'okta-org',
        mutationType: 'delta',
        deletes: [],
        unchangedCount: 1,
      });
      expect(delta.inserts).toHaveLength(1);
      expect(delta.inserts[0].entityRef).toBe('user:default/carol');
      expect(delta.updates).toHaveLength(1);
      expect(delta.updates[0]).toMatchObject({
        entityRef: 'user:default/alice',
        etag: 'a2',
      });
    });

    it('records a delta with only removed entities as deletes', async () => {
      const { store, wrapped } = await setup([
        user('alice', 'a1'),
        user('bob', 'b1'),
      ]);

      await wrapped.applyMutation({
        type: 'delta',
        added: [],
        removed: [{ entityRef: 'user:default/bob' }],
      });

      const delta = store.cycles[1];
      expect(delta).toMatchObject({
        mutationType: 'delta',
        inserts: [],
        updates: [],
        deletes: ['user:default/bob'],
        unchangedCount: 0,
      });
    });

    it('handles removed entries shaped as { entity } as well as { entityRef }', async () => {
      const { store, wrapped } = await setup([
        user('alice', 'a1'),
        user('bob', 'b1'),
      ]);

      await wrapped.applyMutation({
        type: 'delta',
        added: [],
        removed: [
          { entityRef: 'user:default/bob' },
          { entity: user('alice', 'a1') },
        ],
      });

      const delta = store.cycles[1];
      expect(delta.deletes.sort()).toEqual([
        'user:default/alice',
        'user:default/bob',
      ]);
    });

    it('lowercases a mixed-case removed.entityRef to match the canonical history key', async () => {
      // Regression guard: the rest of the module canonicalizes refs to
      // lowercase via entityToRow, so a provider that emits a delta
      // removal as `User:Default/Bob` must still hit the
      // `user:default/bob` row in the history etag map.
      const { store, wrapped } = await setup([
        user('alice', 'a1'),
        user('bob', 'b1'),
      ]);

      await wrapped.applyMutation({
        type: 'delta',
        added: [],
        removed: [{ entityRef: 'User:Default/Bob' }],
      });

      const delta = store.cycles[1];
      expect(delta.deletes).toEqual(['user:default/bob']);
    });

    it('records a mixed delta with adds and removes in a single cycle', async () => {
      const { store, wrapped } = await setup([
        user('alice', 'a1'),
        user('bob', 'b1'),
      ]);

      await wrapped.applyMutation({
        type: 'delta',
        added: [
          { entity: user('carol', 'c1') }, // new → insert
          { entity: user('alice', 'a2') }, // existing ref, different etag → update
        ],
        removed: [{ entityRef: 'user:default/bob' }],
      });

      const delta = store.cycles[1];
      expect(delta).toMatchObject({
        provider: 'okta-org',
        mutationType: 'delta',
      });
      expect(delta.inserts.map(r => r.entityRef)).toEqual([
        'user:default/carol',
      ]);
      expect(delta.updates.map(r => r.entityRef)).toEqual([
        'user:default/alice',
      ]);
      expect(delta.deletes).toEqual(['user:default/bob']);
      expect(delta.unchangedCount).toBe(0);
    });

    it('records a heartbeat delta cycle when added/removed are both empty', async () => {
      const { store, wrapped } = await setup([user('alice', 'a1')]);

      await wrapped.applyMutation({ type: 'delta', added: [], removed: [] });

      const delta = store.cycles[1];
      expect(delta).toMatchObject({
        mutationType: 'delta',
        inserts: [],
        updates: [],
        deletes: [],
        unchangedCount: 0,
      });
    });
  });

  describe('convertFullToDelta option', () => {
    async function setupWith(
      initial: Entity[],
      opts: {
        convertFullToDelta?: boolean;
        forceFullEvery?: {
          days?: number;
          hours?: number;
          minutes?: number;
          seconds?: number;
        };
      },
    ) {
      const store = new InMemoryHistoryStore();
      const logger = mockServices.logger.mock();
      let wrapped: EntityProviderConnection | undefined;

      const inner: EntityProvider = {
        getProviderName: () => 'okta-org',
        connect: async (conn: EntityProviderConnection) => {
          wrapped = conn;
          await conn.applyMutation({
            type: 'full',
            entities: initial.map(entity => ({ entity })),
          });
        },
      };

      const wrapper = new HistoryRecordingEntityProvider({
        inner,
        store,
        logger,
        ...opts,
      });
      const outer = fakeConnection();
      await wrapper.connect(outer);

      if (!wrapped) throw new Error('connect did not install a wrapper');
      return { store, logger, wrapped, outer };
    }

    it('forwards fulls unchanged when convertFullToDelta is not set', async () => {
      const { outer, wrapped } = await setupWith([user('alice', 'a1')], {});
      await applyFull(wrapped, [user('alice', 'a2'), user('bob', 'b1')]);

      // Two applyMutation calls expected, both type='full'
      expect(outer.applyMutation).toHaveBeenCalledTimes(2);
      expect((outer.applyMutation as jest.Mock).mock.calls[1][0].type).toBe(
        'full',
      );
    });

    it('forwards the first full unchanged even when conversion is on (no baseline yet)', async () => {
      const store = new InMemoryHistoryStore();
      const logger = mockServices.logger.mock();
      let wrapped: EntityProviderConnection | undefined;

      const inner: EntityProvider = {
        getProviderName: () => 'okta-org',
        connect: async (conn: EntityProviderConnection) => {
          wrapped = conn;
          await conn.applyMutation({
            type: 'full',
            entities: [{ entity: user('alice', 'a1') }],
          });
        },
      };

      const wrapper = new HistoryRecordingEntityProvider({
        inner,
        store,
        logger,
        convertFullToDelta: true,
      });
      const outer = fakeConnection();
      await wrapper.connect(outer);
      void wrapped; // suppress unused

      expect(outer.applyMutation).toHaveBeenCalledTimes(1);
      expect((outer.applyMutation as jest.Mock).mock.calls[0][0].type).toBe(
        'full',
      );
    });

    it('converts subsequent fulls to deltas using the history etag baseline', async () => {
      const { outer, wrapped } = await setupWith(
        [user('alice', 'a1'), user('bob', 'b1')],
        { convertFullToDelta: true },
      );

      // Second full: alice changed, carol added, bob dropped
      await applyFull(wrapped, [user('alice', 'a2'), user('carol', 'c1')]);

      expect(outer.applyMutation).toHaveBeenCalledTimes(2);
      const secondCall = (outer.applyMutation as jest.Mock).mock.calls[1][0];
      expect(secondCall.type).toBe('delta');
      expect(secondCall.added).toHaveLength(2);
      expect(
        secondCall.added.map((a: { entity: Entity }) => a.entity.metadata.name),
      ).toEqual(expect.arrayContaining(['alice', 'carol']));
      expect(secondCall.removed).toEqual([{ entityRef: 'user:default/bob' }]);
    });

    it('still records the cycle with mutationType=full when converting (audit-honest)', async () => {
      const { store, wrapped } = await setupWith(
        [user('alice', 'a1'), user('bob', 'b1')],
        { convertFullToDelta: true },
      );

      await applyFull(wrapped, [user('alice', 'a2'), user('bob', 'b1')]);

      expect(store.cycles).toHaveLength(2);
      expect(store.cycles[1]).toMatchObject({
        mutationType: 'full',
        unchangedCount: 1,
      });
      expect(store.cycles[1].updates).toHaveLength(1);
      expect(store.cycles[1].updates[0]).toMatchObject({
        entityRef: 'user:default/alice',
        etag: 'a2',
      });
    });

    it('forces a real full mutation once forceFullEvery has elapsed', async () => {
      jest.useFakeTimers();
      try {
        const { outer, wrapped } = await setupWith(
          [user('alice', 'a1'), user('bob', 'b1')],
          { convertFullToDelta: true, forceFullEvery: { seconds: 30 } },
        );

        // 10s later: still inside the window → should convert to delta
        jest.advanceTimersByTime(10_000);
        await applyFull(wrapped, [user('alice', 'a2'), user('bob', 'b1')]);
        expect((outer.applyMutation as jest.Mock).mock.calls[1][0].type).toBe(
          'delta',
        );

        // 31s past the last forwarded full → should force a real full
        jest.advanceTimersByTime(31_000);
        await applyFull(wrapped, [user('alice', 'a2'), user('bob', 'b1')]);
        expect((outer.applyMutation as jest.Mock).mock.calls[2][0].type).toBe(
          'full',
        );

        // Right after: window resets, next call converts again
        jest.advanceTimersByTime(1_000);
        await applyFull(wrapped, [user('alice', 'a3'), user('bob', 'b1')]);
        expect((outer.applyMutation as jest.Mock).mock.calls[3][0].type).toBe(
          'delta',
        );
      } finally {
        jest.useRealTimers();
      }
    });

    it('emits an empty delta when nothing changed but never crashes', async () => {
      const { outer, wrapped } = await setupWith(
        [user('alice', 'a1'), user('bob', 'b1')],
        { convertFullToDelta: true },
      );

      await applyFull(wrapped, [user('alice', 'a1'), user('bob', 'b1')]);

      const secondCall = (outer.applyMutation as jest.Mock).mock.calls[1][0];
      expect(secondCall).toMatchObject({
        type: 'delta',
        added: [],
        removed: [],
      });
    });
  });

  describe('failure isolation', () => {
    it('still forwards applyMutation and never throws when the store fails', async () => {
      const failingStore: InMemoryHistoryStore = new InMemoryHistoryStore();
      jest
        .spyOn(failingStore, 'recordCycle')
        .mockRejectedValue(new Error('history db is on fire'));

      const logger = mockServices.logger.mock();
      const inner = new FakeProvider('okta-org', [user('alice', 'a1')]);
      const wrapper = new HistoryRecordingEntityProvider({
        inner,
        store: failingStore,
        logger,
      });

      const connection = fakeConnection();

      await expect(wrapper.connect(connection)).resolves.toBeUndefined();

      expect(connection.applyMutation).toHaveBeenCalledTimes(1);
      expect(logger.error).toHaveBeenCalledWith(
        expect.stringMatching(/Failed to record history cycle/),
        expect.any(Error),
      );
    });

    it('still forwards applyMutation when loadCurrentEtags fails', async () => {
      const store = new InMemoryHistoryStore();
      jest
        .spyOn(store, 'loadCurrentEtags')
        .mockRejectedValue(new Error('db down'));

      const logger = mockServices.logger.mock();
      const inner = new FakeProvider('okta-org', [user('alice', 'a1')]);
      const wrapper = new HistoryRecordingEntityProvider({
        inner,
        store,
        logger,
      });

      const connection = fakeConnection();
      await expect(wrapper.connect(connection)).resolves.toBeUndefined();

      expect(connection.applyMutation).toHaveBeenCalledTimes(1);
      expect(logger.error).toHaveBeenCalled();
    });

    it('forwards to the catalog before reading history etags on the default (no-conversion) path', async () => {
      // Regression guard for the forward-first failure-isolation contract:
      // the default passthrough path must not block catalog writes on a
      // slow or unavailable history store.
      const store = new InMemoryHistoryStore();
      const events: string[] = [];
      jest
        .spyOn(store, 'loadCurrentEtags')
        .mockImplementation(async (provider: string) => {
          events.push(`loadCurrentEtags(${provider})`);
          return new Map();
        });

      const logger = mockServices.logger.mock();
      const inner = new FakeProvider('okta-org', [user('alice', 'a1')]);
      const wrapper = new HistoryRecordingEntityProvider({
        inner,
        store,
        logger,
      });

      const connection: EntityProviderConnection = {
        applyMutation: jest.fn(async () => {
          events.push('catalog.applyMutation');
        }),
        refresh: jest.fn(),
      };
      await wrapper.connect(connection);

      expect(events[0]).toBe('catalog.applyMutation');
      expect(events).toContain('loadCurrentEtags(okta-org)');
    });
  });
});
