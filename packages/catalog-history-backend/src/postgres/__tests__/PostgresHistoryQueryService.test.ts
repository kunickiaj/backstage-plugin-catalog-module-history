import { Buffer } from 'node:buffer';
import { randomUUID } from 'node:crypto';
import { TestDatabases } from '@backstage/backend-test-utils';
import { Knex } from 'knex';
import { ensureSchema } from '../ensureSchema';
import { PostgresHistoryQueryService } from '../PostgresHistoryQueryService';

jest.setTimeout(30000);

async function insertCycle(
  db: Knex,
  opts: {
    provider: string;
    source: 'provider' | 'processing' | 'reconciler';
    at: string;
  },
): Promise<string> {
  const cycleId = randomUUID();
  await db('catalog_history_cycles').insert({
    cycle_id: cycleId,
    provider: opts.provider,
    source: opts.source,
    mutation_type: 'full',
    started_at: opts.at,
    finished_at: opts.at,
  });
  return cycleId;
}

async function insertEntity(
  db: Knex,
  opts: {
    cycleId: string;
    entityRef?: string;
    provider: string;
    source: 'provider' | 'processing' | 'reconciler';
    op: 'insert' | 'update' | 'delete';
    etag: string | null;
    changedAt: string;
    owner?: string;
  },
): Promise<void> {
  const entityRef = opts.entityRef ?? 'user:default/alice';
  const [kind, rest] = entityRef.split(':', 2);
  const [namespace, name] = rest.split('/', 2);
  await db('catalog_history_entities').insert({
    cycle_id: opts.cycleId,
    entity_ref: entityRef,
    kind,
    namespace,
    name,
    provider: opts.provider,
    source: opts.source,
    op: opts.op,
    etag: opts.etag,
    owner: opts.owner ?? null,
    metadata: { name },
    spec: { profile: { displayName: name } },
    changed_at: opts.changedAt,
  });
}

describe('PostgresHistoryQueryService', () => {
  const databases = TestDatabases.create({ ids: ['POSTGRES_16'] });
  let db: Knex;
  let service: PostgresHistoryQueryService;

  beforeEach(async () => {
    db = await databases.init('POSTGRES_16');
    await ensureSchema(db);
    service = new PostgresHistoryQueryService(db);
  });

  it('returns an entity timeline in newest-first order with cursor pagination', async () => {
    for (const [index, at] of [
      '2026-07-07T00:00:00Z',
      '2026-07-07T01:00:00Z',
      '2026-07-07T02:00:00Z',
    ].entries()) {
      const cycleId = await insertCycle(db, {
        provider: 'okta',
        source: 'provider',
        at,
      });
      await insertEntity(db, {
        cycleId,
        provider: 'okta',
        source: 'provider',
        op: index === 0 ? 'insert' : 'update',
        etag: `etag-${index}`,
        changedAt: at,
      });
    }

    const firstPage = await service.getEntityTimeline({
      entityRef: 'user:default/alice',
      limit: 2,
    });
    expect(firstPage.items.map(item => item.etag)).toEqual([
      'etag-2',
      'etag-1',
    ]);
    expect(firstPage.nextCursor).toBeDefined();

    const secondPage = await service.getEntityTimeline({
      entityRef: 'user:default/alice',
      limit: 2,
      cursor: firstPage.nextCursor,
    });
    expect(secondPage.items.map(item => item.etag)).toEqual(['etag-0']);
    expect(secondPage.nextCursor).toBeUndefined();
  });

  it('uses id as a deterministic timeline tie-breaker when timestamps match', async () => {
    const changedAt = '2026-07-07T00:00:00Z';
    const cycleId = await insertCycle(db, {
      provider: 'okta',
      source: 'provider',
      at: changedAt,
    });
    await insertEntity(db, {
      cycleId,
      entityRef: 'user:default/alice',
      provider: 'okta',
      source: 'provider',
      op: 'insert',
      etag: 'alice-etag',
      changedAt,
    });
    await insertEntity(db, {
      cycleId,
      entityRef: 'user:default/bob',
      provider: 'okta',
      source: 'provider',
      op: 'insert',
      etag: 'bob-etag',
      changedAt,
    });
    await insertEntity(db, {
      cycleId,
      entityRef: 'user:default/alice',
      provider: 'okta',
      source: 'provider',
      op: 'update',
      etag: 'alice-etag-2',
      changedAt,
    });

    const firstPage = await service.getEntityTimeline({
      entityRef: 'user:default/alice',
      limit: 1,
    });
    expect(firstPage.items.map(item => item.etag)).toEqual(['alice-etag-2']);

    const secondPage = await service.getEntityTimeline({
      entityRef: 'user:default/alice',
      limit: 1,
      cursor: firstPage.nextCursor,
    });
    expect(secondPage.items.map(item => item.etag)).toEqual(['alice-etag']);
    expect(secondPage.nextCursor).toBeUndefined();
  });

  it('filters timeline rows by provider, source, op, and time range', async () => {
    const providerCycle = await insertCycle(db, {
      provider: 'okta',
      source: 'provider',
      at: '2026-07-07T00:00:00Z',
    });
    await insertEntity(db, {
      cycleId: providerCycle,
      provider: 'okta',
      source: 'provider',
      op: 'insert',
      etag: 'provider-etag',
      changedAt: '2026-07-07T00:00:00Z',
    });
    const processingCycle = await insertCycle(db, {
      provider: 'processing',
      source: 'processing',
      at: '2026-07-07T01:00:00Z',
    });
    await insertEntity(db, {
      cycleId: processingCycle,
      provider: 'processing',
      source: 'processing',
      op: 'update',
      etag: 'processing-etag',
      changedAt: '2026-07-07T01:00:00Z',
    });

    const page = await service.getEntityTimeline({
      entityRef: 'user:default/alice',
      source: 'processing',
      provider: 'processing',
      op: 'update',
      changedAfter: '2026-07-07T00:30:00Z',
      changedBefore: '2026-07-07T01:30:00Z',
    });

    expect(page.items.map(item => item.etag)).toEqual(['processing-etag']);
  });

  it('returns distinct non-delete versions with snapshots', async () => {
    const c1 = await insertCycle(db, {
      provider: 'okta',
      source: 'provider',
      at: '2026-07-07T00:00:00Z',
    });
    await insertEntity(db, {
      cycleId: c1,
      provider: 'okta',
      source: 'provider',
      op: 'insert',
      etag: 'same-etag',
      owner: 'group:default/platform',
      changedAt: '2026-07-07T00:00:00Z',
    });
    const c2 = await insertCycle(db, {
      provider: 'okta',
      source: 'provider',
      at: '2026-07-07T01:00:00Z',
    });
    await insertEntity(db, {
      cycleId: c2,
      provider: 'okta',
      source: 'provider',
      op: 'update',
      etag: 'same-etag',
      owner: 'group:default/platform-new',
      changedAt: '2026-07-07T01:00:00Z',
    });
    const c3 = await insertCycle(db, {
      provider: 'okta',
      source: 'provider',
      at: '2026-07-07T02:00:00Z',
    });
    await insertEntity(db, {
      cycleId: c3,
      provider: 'okta',
      source: 'provider',
      op: 'delete',
      etag: null,
      changedAt: '2026-07-07T02:00:00Z',
    });

    const versions = await service.getEntityVersions({
      entityRef: 'user:default/alice',
    });

    expect(versions.items).toHaveLength(1);
    expect(versions.items[0]).toMatchObject({
      etag: 'same-etag',
      op: 'update',
      snapshot: { owner: 'group:default/platform-new' },
    });
  });

  it('paginates distinct versions and keeps entity refs isolated', async () => {
    for (const [index, at] of [
      '2026-07-07T00:00:00Z',
      '2026-07-07T01:00:00Z',
      '2026-07-07T02:00:00Z',
    ].entries()) {
      const cycleId = await insertCycle(db, {
        provider: 'okta',
        source: 'provider',
        at,
      });
      await insertEntity(db, {
        cycleId,
        entityRef: 'user:default/alice',
        provider: 'okta',
        source: 'provider',
        op: index === 0 ? 'insert' : 'update',
        etag: `alice-etag-${index}`,
        changedAt: at,
      });
      await insertEntity(db, {
        cycleId,
        entityRef: 'user:default/bob',
        provider: 'okta',
        source: 'provider',
        op: index === 0 ? 'insert' : 'update',
        etag: `bob-etag-${index}`,
        changedAt: at,
      });
    }

    const firstPage = await service.getEntityVersions({
      entityRef: 'user:default/alice',
      limit: 2,
    });
    expect(firstPage.items.map(item => item.etag)).toEqual([
      'alice-etag-2',
      'alice-etag-1',
    ]);
    expect(firstPage.nextCursor).toBeDefined();

    const secondPage = await service.getEntityVersions({
      entityRef: 'user:default/alice',
      limit: 2,
      cursor: firstPage.nextCursor,
    });
    expect(secondPage.items.map(item => item.etag)).toEqual(['alice-etag-0']);
    expect(secondPage.nextCursor).toBeUndefined();
  });

  it('rejects invalid cursors and invalid page limits', async () => {
    await expect(
      service.getEntityTimeline({
        entityRef: 'user:default/alice',
        cursor: 'not-json',
      }),
    ).rejects.toThrow('Invalid history page cursor');

    const invalidIdCursor = Buffer.from(
      JSON.stringify({ changedAt: '2026-07-07T00:00:00Z', id: 'abc' }),
      'utf8',
    ).toString('base64url');
    await expect(
      service.getEntityTimeline({
        entityRef: 'user:default/alice',
        cursor: invalidIdCursor,
      }),
    ).rejects.toThrow('Invalid history page cursor');

    await expect(
      service.getEntityVersions({
        entityRef: 'user:default/alice',
        limit: 0,
      }),
    ).rejects.toThrow('History page limit must be a positive integer');
  });
});
