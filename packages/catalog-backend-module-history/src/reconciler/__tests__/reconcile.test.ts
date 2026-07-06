import { Entity } from '@backstage/catalog-model';
import { mockServices } from '@backstage/backend-test-utils';
import { CaptureSource, EntityRow } from '@kunickiaj/catalog-history-node';
import { InMemoryHistoryStore } from '@kunickiaj/catalog-history-node/testUtils';
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

function row(name: string, etag: string): EntityRow {
  return {
    entityRef: `user:default/${name}`,
    kind: 'User',
    namespace: 'default',
    name,
    etag,
    metadata: { name, etag },
    spec: { profile: { displayName: name } },
  };
}

async function seedCycle(
  store: InMemoryHistoryStore,
  opts: { provider: string; source: CaptureSource; inserts: EntityRow[] },
): Promise<void> {
  await store.recordCycle({
    cycleId: `seed-${opts.provider}-${opts.source}`,
    provider: opts.provider,
    source: opts.source,
    mutationType: 'full',
    startedAt: new Date('2026-05-12T10:00:00Z'),
    finishedAt: new Date('2026-05-12T10:00:01Z'),
    inserts: opts.inserts,
    updates: [],
    deletes: [],
    unchangedCount: 0,
  });
}

function staticFetcher(entities: Entity[]): EntityFetcher {
  return {
    getEntities: async () => entities,
  };
}

describe('reconcile', () => {
  it('records a heartbeat when the catalog matches the reconciler baseline exactly', async () => {
    const store = new InMemoryHistoryStore();
    const logger = mockServices.logger.mock();

    await seedCycle(store, {
      provider: 'reconciler',
      source: 'reconciler',
      inserts: [row('alice', 'a1')],
    });

    const fetcher = staticFetcher([user('alice', 'a1')]);
    await reconcile({ fetcher, store, logger });

    expect(store.cycles).toHaveLength(2);
    const heartbeat = store.cycles[1];
    expect(heartbeat).toMatchObject({
      provider: 'reconciler',
      source: 'reconciler',
      mutationType: 'full',
      inserts: [],
      updates: [],
      deletes: [],
      unchangedCount: 1,
    });
  });

  it('ignores rows from other capture sources when computing its baseline', async () => {
    const store = new InMemoryHistoryStore();
    const logger = mockServices.logger.mock();

    // Provider and processing layers have both recorded alice with etags
    // computed over different content than the served entity. Only the
    // reconciler's own baseline may be compared against served truth —
    // otherwise every real change would surface as a phantom update.
    await seedCycle(store, {
      provider: 'okta-org',
      source: 'provider',
      inserts: [row('alice', 'provider-etag')],
    });
    await seedCycle(store, {
      provider: 'processing',
      source: 'processing',
      inserts: [row('alice', 'processing-etag')],
    });
    await seedCycle(store, {
      provider: 'reconciler',
      source: 'reconciler',
      inserts: [row('alice', 'served-etag')],
    });

    const fetcher = staticFetcher([user('alice', 'served-etag')]);
    await reconcile({ fetcher, store, logger });

    const heartbeat = store.cycles[3];
    expect(heartbeat).toMatchObject({
      provider: 'reconciler',
      inserts: [],
      updates: [],
      deletes: [],
      unchangedCount: 1,
    });
  });

  it('records the whole catalog as inserts on the first run (empty baseline)', async () => {
    const store = new InMemoryHistoryStore();
    const logger = mockServices.logger.mock();

    // Even with provider-layer history present, the first reconcile run
    // captures everything once under source='reconciler'.
    await seedCycle(store, {
      provider: 'okta-org',
      source: 'provider',
      inserts: [row('alice', 'a1')],
    });

    const fetcher = staticFetcher([user('alice', 'a1'), user('bob', 'b1')]);
    await reconcile({ fetcher, store, logger });

    const drift = store.cycles[1];
    expect(drift).toMatchObject({
      provider: 'reconciler',
      source: 'reconciler',
      mutationType: 'full',
      updates: [],
      deletes: [],
      unchangedCount: 0,
    });
    expect(drift.inserts).toHaveLength(2);
    const refs = drift.inserts.map(r => r.entityRef).sort();
    expect(refs).toEqual(['user:default/alice', 'user:default/bob']);
  });

  it('records updates when the served etag differs from the baseline', async () => {
    const store = new InMemoryHistoryStore();
    const logger = mockServices.logger.mock();

    await seedCycle(store, {
      provider: 'reconciler',
      source: 'reconciler',
      inserts: [row('alice', 'a1')],
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

  it('records deletes for entities the baseline knew about but the catalog has dropped', async () => {
    const store = new InMemoryHistoryStore();
    const logger = mockServices.logger.mock();

    await seedCycle(store, {
      provider: 'reconciler',
      source: 'reconciler',
      inserts: [row('alice', 'a1'), row('bob', 'b1')],
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

  it('records mixed inserts, updates, and deletes in one symmetric cycle', async () => {
    const store = new InMemoryHistoryStore();
    const logger = mockServices.logger.mock();

    await seedCycle(store, {
      provider: 'reconciler',
      source: 'reconciler',
      inserts: [row('alice', 'a1'), row('carol', 'c1')],
    });

    // Served state: alice updated, carol dropped, new bob added.
    const fetcher = staticFetcher([user('alice', 'a2'), user('bob', 'b1')]);
    await reconcile({ fetcher, store, logger });

    const drift = store.cycles[1];
    expect(drift.provider).toBe('reconciler');
    expect(drift.unchangedCount).toBe(0);
    expect(drift.inserts.map(r => r.entityRef)).toEqual(['user:default/bob']);
    expect(drift.updates.map(r => r.entityRef)).toEqual(['user:default/alice']);
    expect(drift.deletes).toEqual(['user:default/carol']);
  });
});
