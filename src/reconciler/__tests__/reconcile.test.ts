import { Entity } from '@backstage/catalog-model';
import { mockServices } from '@backstage/backend-test-utils';
import { InMemoryHistoryStore } from '../../store/__tests__/InMemoryHistoryStore';
import { reconcile } from '../reconcile';
import { EntityFetcher } from '../EntityFetcher';

function user(name: string, etag: string): Entity {
  return {
    apiVersion: 'backstage.io/v1alpha1',
    kind: 'User',
    metadata: { name, namespace: 'default', etag },
    spec: { profile: { displayName: name } },
  };
}

function staticFetcher(entities: Entity[]): EntityFetcher {
  return {
    getEntities: async () => entities,
  };
}

describe('reconcile', () => {
  it('records a heartbeat when the catalog matches the history snapshot exactly', async () => {
    const store = new InMemoryHistoryStore();
    const logger = mockServices.logger.mock();

    await store.recordCycle({
      cycleId: 'seed-1',
      provider: 'okta-org',
      mutationType: 'full',
      startedAt: new Date('2026-05-12T10:00:00Z'),
      finishedAt: new Date('2026-05-12T10:00:01Z'),
      inserts: [
        {
          entityRef: 'user:default/alice',
          kind: 'User',
          namespace: 'default',
          name: 'alice',
          etag: 'a1',
          metadata: { name: 'alice', etag: 'a1' },
          spec: { profile: { displayName: 'alice' } },
        },
      ],
      updates: [],
      deletes: [],
      unchangedCount: 0,
    });

    const fetcher = staticFetcher([user('alice', 'a1')]);
    await reconcile({ fetcher, store, logger });

    expect(store.cycles).toHaveLength(2);
    const heartbeat = store.cycles[1];
    expect(heartbeat).toMatchObject({
      provider: 'reconciler',
      mutationType: 'full',
      inserts: [],
      updates: [],
      deletes: [],
      unchangedCount: 1,
    });
  });

  it('records inserts for entities the catalog has but history does not', async () => {
    const store = new InMemoryHistoryStore();
    const logger = mockServices.logger.mock();

    const fetcher = staticFetcher([user('alice', 'a1'), user('bob', 'b1')]);
    await reconcile({ fetcher, store, logger });

    expect(store.cycles).toHaveLength(1);
    const drift = store.cycles[0];
    expect(drift).toMatchObject({
      provider: 'reconciler',
      mutationType: 'full',
      updates: [],
      deletes: [],
      unchangedCount: 0,
    });
    expect(drift.inserts).toHaveLength(2);
    const refs = drift.inserts.map(r => r.entityRef).sort();
    expect(refs).toEqual(['user:default/alice', 'user:default/bob']);
  });

  it('records updates when history etags differ from the catalog state', async () => {
    const store = new InMemoryHistoryStore();
    const logger = mockServices.logger.mock();

    await store.recordCycle({
      cycleId: 'seed-1',
      provider: 'okta-org',
      mutationType: 'full',
      startedAt: new Date('2026-05-12T10:00:00Z'),
      finishedAt: new Date('2026-05-12T10:00:01Z'),
      inserts: [
        {
          entityRef: 'user:default/alice',
          kind: 'User',
          namespace: 'default',
          name: 'alice',
          etag: 'a1',
          metadata: { name: 'alice', etag: 'a1' },
          spec: { profile: { displayName: 'alice' } },
        },
      ],
      updates: [],
      deletes: [],
      unchangedCount: 0,
    });

    const fetcher = staticFetcher([user('alice', 'a2')]);
    await reconcile({ fetcher, store, logger });

    const drift = store.cycles[1];
    expect(drift).toMatchObject({
      provider: 'reconciler',
      inserts: [],
      deletes: [],
      unchangedCount: 0,
    });
    expect(drift.updates).toHaveLength(1);
    expect(drift.updates[0]).toMatchObject({
      entityRef: 'user:default/alice',
      etag: 'a2',
    });
  });

  it('records deletes for entities history knew about but the catalog has dropped', async () => {
    const store = new InMemoryHistoryStore();
    const logger = mockServices.logger.mock();

    await store.recordCycle({
      cycleId: 'seed-1',
      provider: 'okta-org',
      mutationType: 'full',
      startedAt: new Date('2026-05-12T10:00:00Z'),
      finishedAt: new Date('2026-05-12T10:00:01Z'),
      inserts: [
        {
          entityRef: 'user:default/alice',
          kind: 'User',
          namespace: 'default',
          name: 'alice',
          etag: 'a1',
          metadata: {},
          spec: {},
        },
        {
          entityRef: 'user:default/bob',
          kind: 'User',
          namespace: 'default',
          name: 'bob',
          etag: 'b1',
          metadata: {},
          spec: {},
        },
      ],
      updates: [],
      deletes: [],
      unchangedCount: 0,
    });

    const fetcher = staticFetcher([user('alice', 'a1')]);
    await reconcile({ fetcher, store, logger });

    const drift = store.cycles[1];
    expect(drift).toMatchObject({
      provider: 'reconciler',
      inserts: [],
      updates: [],
      unchangedCount: 1,
    });
    expect(drift.deletes).toEqual(['user:default/bob']);
  });

  it('reconciles drift sourced from any provider in one symmetric cycle', async () => {
    const store = new InMemoryHistoryStore();
    const logger = mockServices.logger.mock();

    // Two providers had recorded state previously
    await store.recordCycle({
      cycleId: 'seed-okta',
      provider: 'okta-org',
      mutationType: 'full',
      startedAt: new Date('2026-05-12T10:00:00Z'),
      finishedAt: new Date('2026-05-12T10:00:01Z'),
      inserts: [
        {
          entityRef: 'user:default/alice',
          kind: 'User',
          namespace: 'default',
          name: 'alice',
          etag: 'a1',
          metadata: {},
          spec: {},
        },
      ],
      updates: [],
      deletes: [],
      unchangedCount: 0,
    });
    await store.recordCycle({
      cycleId: 'seed-github',
      provider: 'github-org',
      mutationType: 'full',
      startedAt: new Date('2026-05-12T10:00:00Z'),
      finishedAt: new Date('2026-05-12T10:00:01Z'),
      inserts: [
        {
          entityRef: 'group:default/eng',
          kind: 'Group',
          namespace: 'default',
          name: 'eng',
          etag: 'g1',
          metadata: {},
          spec: {},
        },
      ],
      updates: [],
      deletes: [],
      unchangedCount: 0,
    });

    // Catalog state: alice updated, eng group dropped, new bob added.
    const fetcher = staticFetcher([user('alice', 'a2'), user('bob', 'b1')]);
    await reconcile({ fetcher, store, logger });

    const drift = store.cycles[2];
    expect(drift.provider).toBe('reconciler');
    expect(drift.unchangedCount).toBe(0);
    expect(drift.inserts.map(r => r.entityRef).sort()).toEqual([
      'user:default/bob',
    ]);
    expect(drift.updates.map(r => r.entityRef).sort()).toEqual([
      'user:default/alice',
    ]);
    expect(drift.deletes.sort()).toEqual(['group:default/eng']);
  });
});
