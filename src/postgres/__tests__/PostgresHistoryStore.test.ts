import { randomUUID } from 'node:crypto';
import { TestDatabases } from '@backstage/backend-test-utils';
import { Knex } from 'knex';
import { ensureSchema } from '../ensureSchema';
import { PostgresHistoryStore } from '../PostgresHistoryStore';
import { EntityRow } from '../../store/types';

async function insertCycle(
  db: Knex,
  opts: { provider: string; startedAt: string },
): Promise<string> {
  const cycleId = randomUUID();
  await db('catalog_history_cycles').insert({
    cycle_id: cycleId,
    provider: opts.provider,
    mutation_type: 'full',
    started_at: opts.startedAt,
    finished_at: opts.startedAt,
  });
  return cycleId;
}

async function insertEntity(
  db: Knex,
  opts: {
    cycleId: string;
    provider: string;
    entityRef: string;
    etag: string | null;
    op: 'insert' | 'update' | 'delete';
    changedAt: string;
  },
): Promise<void> {
  const [kind, rest] = opts.entityRef.split(':');
  const [namespace, name] = rest.split('/');
  await db('catalog_history_entities').insert({
    cycle_id: opts.cycleId,
    entity_ref: opts.entityRef,
    kind,
    namespace,
    name,
    provider: opts.provider,
    op: opts.op,
    etag: opts.etag,
    changed_at: opts.changedAt,
  });
}

describe('PostgresHistoryStore', () => {
  const databases = TestDatabases.create({ ids: ['POSTGRES_16'] });
  let db: Knex;
  let store: PostgresHistoryStore;

  beforeEach(async () => {
    db = await databases.init('POSTGRES_16');
    await ensureSchema(db);
    store = new PostgresHistoryStore(db);
  });

  describe('loadCurrentEtags', () => {
    it('returns the etag from the most recent non-delete row per entity_ref', async () => {
      const c1 = await insertCycle(db, {
        provider: 'okta-org',
        startedAt: '2026-05-12T10:00:00Z',
      });
      const c2 = await insertCycle(db, {
        provider: 'okta-org',
        startedAt: '2026-05-12T11:00:00Z',
      });

      await insertEntity(db, {
        cycleId: c1,
        provider: 'okta-org',
        entityRef: 'user:default/alice',
        etag: 'alice-v1',
        op: 'insert',
        changedAt: '2026-05-12T10:00:00Z',
      });
      await insertEntity(db, {
        cycleId: c2,
        provider: 'okta-org',
        entityRef: 'user:default/alice',
        etag: 'alice-v2',
        op: 'update',
        changedAt: '2026-05-12T11:00:00Z',
      });

      const etags = await store.loadCurrentEtags('okta-org');
      expect(etags.get('user:default/alice')).toBe('alice-v2');
    });

    it('omits entities whose latest row is a delete', async () => {
      const c1 = await insertCycle(db, {
        provider: 'okta-org',
        startedAt: '2026-05-12T10:00:00Z',
      });
      const c2 = await insertCycle(db, {
        provider: 'okta-org',
        startedAt: '2026-05-12T11:00:00Z',
      });

      await insertEntity(db, {
        cycleId: c1,
        provider: 'okta-org',
        entityRef: 'user:default/bob',
        etag: 'bob-v1',
        op: 'insert',
        changedAt: '2026-05-12T10:00:00Z',
      });
      await insertEntity(db, {
        cycleId: c2,
        provider: 'okta-org',
        entityRef: 'user:default/bob',
        etag: null,
        op: 'delete',
        changedAt: '2026-05-12T11:00:00Z',
      });

      const etags = await store.loadCurrentEtags('okta-org');
      expect(etags.has('user:default/bob')).toBe(false);
    });

    it('returns entities deleted and then re-inserted (latest is insert)', async () => {
      const c1 = await insertCycle(db, {
        provider: 'okta-org',
        startedAt: '2026-05-12T10:00:00Z',
      });
      const c2 = await insertCycle(db, {
        provider: 'okta-org',
        startedAt: '2026-05-12T11:00:00Z',
      });
      const c3 = await insertCycle(db, {
        provider: 'okta-org',
        startedAt: '2026-05-12T12:00:00Z',
      });

      await insertEntity(db, {
        cycleId: c1,
        provider: 'okta-org',
        entityRef: 'user:default/carol',
        etag: 'carol-v1',
        op: 'insert',
        changedAt: '2026-05-12T10:00:00Z',
      });
      await insertEntity(db, {
        cycleId: c2,
        provider: 'okta-org',
        entityRef: 'user:default/carol',
        etag: null,
        op: 'delete',
        changedAt: '2026-05-12T11:00:00Z',
      });
      await insertEntity(db, {
        cycleId: c3,
        provider: 'okta-org',
        entityRef: 'user:default/carol',
        etag: 'carol-v3',
        op: 'insert',
        changedAt: '2026-05-12T12:00:00Z',
      });

      const etags = await store.loadCurrentEtags('okta-org');
      expect(etags.get('user:default/carol')).toBe('carol-v3');
    });

    it('is scoped to the requested provider', async () => {
      const c1 = await insertCycle(db, {
        provider: 'okta-org',
        startedAt: '2026-05-12T10:00:00Z',
      });
      const c2 = await insertCycle(db, {
        provider: 'github-org',
        startedAt: '2026-05-12T10:30:00Z',
      });

      await insertEntity(db, {
        cycleId: c1,
        provider: 'okta-org',
        entityRef: 'user:default/dave',
        etag: 'okta-etag',
        op: 'insert',
        changedAt: '2026-05-12T10:00:00Z',
      });
      await insertEntity(db, {
        cycleId: c2,
        provider: 'github-org',
        entityRef: 'user:default/dave',
        etag: 'github-etag',
        op: 'insert',
        changedAt: '2026-05-12T10:30:00Z',
      });

      const okta = await store.loadCurrentEtags('okta-org');
      const github = await store.loadCurrentEtags('github-org');
      expect(okta.get('user:default/dave')).toBe('okta-etag');
      expect(github.get('user:default/dave')).toBe('github-etag');
    });

    it('returns an empty map for a provider with no history', async () => {
      const etags = await store.loadCurrentEtags('never-ran');
      expect(etags.size).toBe(0);
    });
  });

  describe('recordCycle', () => {
    function row(
      name: string,
      etag: string,
      overrides: Partial<EntityRow> = {},
    ) {
      return {
        entityRef: `user:default/${name}`,
        kind: 'User',
        namespace: 'default',
        name,
        etag,
        metadata: { name },
        spec: { type: 'service' },
        ...overrides,
      } satisfies EntityRow;
    }

    it('records a cycle row and one entity row per insert/update/delete', async () => {
      const cycleId = randomUUID();
      await store.recordCycle({
        cycleId,
        provider: 'okta-org',
        mutationType: 'full',
        startedAt: new Date('2026-05-12T10:00:00Z'),
        finishedAt: new Date('2026-05-12T10:00:05Z'),
        inserts: [row('alice', 'a1'), row('bob', 'b1')],
        updates: [row('carol', 'c2')],
        deletes: ['user:default/dave'],
        unchangedCount: 7,
      });

      const cycle = await db('catalog_history_cycles')
        .where({ cycle_id: cycleId })
        .first();
      expect(cycle).toMatchObject({
        provider: 'okta-org',
        mutation_type: 'full',
        n_added: 2,
        n_modified: 1,
        n_removed: 1,
        n_unchanged: 7,
      });

      const entities = await db('catalog_history_entities')
        .where({ cycle_id: cycleId })
        .orderBy('entity_ref');
      expect(entities).toHaveLength(4);

      const byRef = Object.fromEntries(entities.map(e => [e.entity_ref, e]));
      expect(byRef['user:default/alice']).toMatchObject({
        op: 'insert',
        etag: 'a1',
        kind: 'User',
        namespace: 'default',
        name: 'alice',
        provider: 'okta-org',
      });
      expect(byRef['user:default/bob'].op).toBe('insert');
      expect(byRef['user:default/carol']).toMatchObject({
        op: 'update',
        etag: 'c2',
      });
      expect(byRef['user:default/dave']).toMatchObject({
        op: 'delete',
        etag: null,
        kind: 'User',
        namespace: 'default',
        name: 'dave',
      });
    });

    it('records a heartbeat cycle with no entity rows', async () => {
      const cycleId = randomUUID();
      await store.recordCycle({
        cycleId,
        provider: 'okta-org',
        mutationType: 'full',
        startedAt: new Date('2026-05-12T10:00:00Z'),
        finishedAt: new Date('2026-05-12T10:00:01Z'),
        inserts: [],
        updates: [],
        deletes: [],
        unchangedCount: 100,
      });

      const cycle = await db('catalog_history_cycles')
        .where({ cycle_id: cycleId })
        .first();
      expect(cycle).toMatchObject({
        n_added: 0,
        n_modified: 0,
        n_removed: 0,
        n_unchanged: 100,
      });

      const entityCount = await db('catalog_history_entities')
        .where({ cycle_id: cycleId })
        .count('*', { as: 'count' })
        .first();
      expect(Number(entityCount?.count)).toBe(0);
    });

    it('rolls back the cycle row on any failure (atomicity)', async () => {
      const cycleId = randomUUID();
      const bad = {
        cycleId,
        provider: 'okta-org',
        mutationType: 'NOT_A_REAL_TYPE' as 'full',
        startedAt: new Date('2026-05-12T10:00:00Z'),
        finishedAt: new Date('2026-05-12T10:00:01Z'),
        inserts: [row('alice', 'a1')],
        updates: [],
        deletes: [],
        unchangedCount: 0,
      };

      await expect(store.recordCycle(bad)).rejects.toThrow();

      const cycle = await db('catalog_history_cycles')
        .where({ cycle_id: cycleId })
        .first();
      expect(cycle).toBeUndefined();

      const entityCount = await db('catalog_history_entities').count('*', {
        as: 'count',
      });
      expect(Number(entityCount[0].count)).toBe(0);
    });

    it('persists structured columns + JSONB payloads', async () => {
      const cycleId = randomUUID();
      await store.recordCycle({
        cycleId,
        provider: 'okta-org',
        mutationType: 'full',
        startedAt: new Date('2026-05-12T10:00:00Z'),
        finishedAt: new Date('2026-05-12T10:00:01Z'),
        inserts: [
          row('alice', 'a1', {
            displayName: 'Alice A.',
            email: 'alice@example.com',
            owner: 'group:default/platform',
            parent: 'group:default/eng',
            memberOf: ['group:default/eng', 'group:default/platform'],
            metadata: { annotations: { 'oidc.id': '42' } },
            spec: { profile: { displayName: 'Alice A.' } },
          }),
        ],
        updates: [],
        deletes: [],
        unchangedCount: 0,
      });

      const ent = await db('catalog_history_entities')
        .where({ cycle_id: cycleId })
        .first();
      expect(ent).toMatchObject({
        display_name: 'Alice A.',
        email: 'alice@example.com',
        owner: 'group:default/platform',
        parent: 'group:default/eng',
      });
      expect(ent.member_of).toEqual([
        'group:default/eng',
        'group:default/platform',
      ]);
      expect(ent.metadata).toEqual({ annotations: { 'oidc.id': '42' } });
      expect(ent.spec).toEqual({ profile: { displayName: 'Alice A.' } });
    });

    it('refreshes loadCurrentEtags after recordCycle', async () => {
      const c1 = randomUUID();
      const c2 = randomUUID();

      await store.recordCycle({
        cycleId: c1,
        provider: 'okta-org',
        mutationType: 'full',
        startedAt: new Date('2026-05-12T10:00:00Z'),
        finishedAt: new Date('2026-05-12T10:00:01Z'),
        inserts: [row('alice', 'a1'), row('bob', 'b1')],
        updates: [],
        deletes: [],
        unchangedCount: 0,
      });

      let etags = await store.loadCurrentEtags('okta-org');
      expect(etags.get('user:default/alice')).toBe('a1');
      expect(etags.get('user:default/bob')).toBe('b1');

      await store.recordCycle({
        cycleId: c2,
        provider: 'okta-org',
        mutationType: 'full',
        startedAt: new Date('2026-05-12T11:00:00Z'),
        finishedAt: new Date('2026-05-12T11:00:01Z'),
        inserts: [],
        updates: [row('alice', 'a2')],
        deletes: ['user:default/bob'],
        unchangedCount: 0,
      });

      etags = await store.loadCurrentEtags('okta-org');
      expect(etags.get('user:default/alice')).toBe('a2');
      expect(etags.has('user:default/bob')).toBe(false);
    });
  });
});
