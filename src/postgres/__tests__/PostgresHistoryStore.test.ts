import { randomUUID } from 'node:crypto';
import { TestDatabases } from '@backstage/backend-test-utils';
import { Knex } from 'knex';
import { ensureSchema } from '../ensureSchema';
import { PostgresHistoryStore } from '../PostgresHistoryStore';

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
});
