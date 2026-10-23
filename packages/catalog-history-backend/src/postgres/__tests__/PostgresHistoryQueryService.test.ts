import { Buffer } from 'node:buffer';
import { randomUUID } from 'node:crypto';
import { TestDatabases } from '@backstage/backend-test-utils';
import { InputError, NotFoundError } from '@backstage/errors';
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
): Promise<string> {
  const entityRef = opts.entityRef ?? 'user:default/alice';
  const [kind, rest] = entityRef.split(':', 2);
  const [namespace, name] = rest.split('/', 2);
  const [row] = await db('catalog_history_entities')
    .insert({
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
    })
    .returning('id');
  return String(row.id);
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

  it('filters timeline rows and versions by owner', async () => {
    for (const [index, owner] of [
      'group:default/platform',
      'group:default/other',
    ].entries()) {
      const at = `2026-07-07T0${index}:00:00Z`;
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
        owner,
        changedAt: at,
      });
    }

    const timeline = await service.getEntityTimeline({
      entityRef: 'user:default/alice',
      owner: 'group:default/platform',
    });
    const versions = await service.getEntityVersions({
      entityRef: 'user:default/alice',
      owner: 'group:default/platform',
    });

    expect(timeline.items.map(item => item.etag)).toEqual(['etag-0']);
    expect(versions.items.map(item => item.etag)).toEqual(['etag-0']);
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

  it('reads the original A event after A to B to A without substituting the newest representative', async () => {
    // Arrange: repeated etags deliberately carry distinct recorded payloads.
    const ids: string[] = [];
    for (const [index, etag] of ['a', 'b', 'a'].entries()) {
      const at = `2026-07-07T0${index}:00:00Z`;
      const cycleId = await insertCycle(db, {
        provider: 'okta',
        source: 'provider',
        at,
      });
      ids.push(
        await insertEntity(db, {
          cycleId,
          provider: 'okta',
          source: 'provider',
          op: index === 0 ? 'insert' : 'update',
          etag,
          changedAt: at,
          owner: `group:default/owner-${index}`,
        }),
      );
    }

    // Act
    const original = await service.getEntityVersion({
      entityRef: 'user:default/alice',
      id: ids[0],
    });
    const versions = await service.getEntityVersions({
      entityRef: 'user:default/alice',
    });

    // Assert
    expect(original).toMatchObject({
      id: ids[0],
      op: 'insert',
      etag: 'a',
      changedAt: '2026-07-07T00:00:00.000Z',
      snapshot: { owner: 'group:default/owner-0' },
    });
    expect(versions.items.map(item => item.id)).toEqual([ids[2], ids[1]]);
  });

  it('deduplicates etags within source and provider, preserving the newest representative and pagination', async () => {
    // Arrange: vary source independently of provider and provider independently of source.
    const provenance = [
      { source: 'provider' as const, provider: 'shared' },
      { source: 'processing' as const, provider: 'shared' },
      { source: 'provider' as const, provider: 'other' },
      { source: 'provider' as const, provider: 'shared' },
    ];
    const ids: string[] = [];
    for (const [index, scope] of provenance.entries()) {
      const at = `2026-07-07T0${index}:00:00Z`;
      const cycleId = await insertCycle(db, { ...scope, at });
      ids.push(
        await insertEntity(db, {
          cycleId,
          ...scope,
          op: 'update',
          etag: 'shared-etag',
          changedAt: at,
          owner: `group:default/owner-${index}`,
        }),
      );
    }

    // Act
    const first = await service.getEntityVersions({
      entityRef: 'user:default/alice',
      limit: 2,
    });
    const second = await service.getEntityVersions({
      entityRef: 'user:default/alice',
      limit: 2,
      cursor: first.nextCursor,
    });

    // Assert
    expect(first.items.map(item => item.id)).toEqual([ids[3], ids[2]]);
    expect(first.nextCursor).toEqual(expect.any(String));
    expect(second.items.map(item => item.id)).toEqual([ids[1]]);
    expect(second.nextCursor).toBeUndefined();
    expect(first.items[0].snapshot?.owner).toBe('group:default/owner-3');
  });

  it('returns tombstone event metadata without a snapshot for an exact delete row', async () => {
    // Arrange
    const at = '2026-07-07T00:00:00Z';
    const cycleId = await insertCycle(db, {
      provider: 'okta',
      source: 'provider',
      at,
    });
    const id = await insertEntity(db, {
      cycleId,
      provider: 'okta',
      source: 'provider',
      op: 'delete',
      etag: null,
      changedAt: at,
    });

    // Act
    const version = await service.getEntityVersion({
      entityRef: 'user:default/alice',
      id,
    });

    // Assert
    expect(version).toMatchObject({
      id,
      cycleId,
      entityRef: 'user:default/alice',
      source: 'provider',
      provider: 'okta',
      op: 'delete',
      changedAt: '2026-07-07T00:00:00.000Z',
    });
    expect(version.snapshot).toBeUndefined();
    expect(version.etag).toBeUndefined();
  });

  it.each(['0', '-1', '1.5', 'abc', '9223372036854775808'])(
    'rejects invalid exact row ID %s',
    async id => {
      // Arrange
      const request = { entityRef: 'user:default/alice', id };

      // Act
      const result = service.getEntityVersion(request);

      // Assert
      await expect(result).rejects.toBeInstanceOf(InputError);
    },
  );

  it.each(['1', '9223372036854775807'])(
    'returns not found for an absent valid bigint row ID %s',
    async id => {
      // Arrange
      const request = { entityRef: 'user:default/alice', id };

      // Act
      const result = service.getEntityVersion(request);

      // Assert
      await expect(result).rejects.toBeInstanceOf(NotFoundError);
    },
  );

  it('does not return another entity payload even when the row ID exists', async () => {
    // Arrange
    const at = '2026-07-07T00:00:00Z';
    const cycleId = await insertCycle(db, {
      provider: 'okta',
      source: 'provider',
      at,
    });
    const id = await insertEntity(db, {
      cycleId,
      entityRef: 'user:default/bob',
      provider: 'okta',
      source: 'provider',
      op: 'insert',
      etag: 'bob-etag',
      changedAt: at,
    });

    // Act
    const result = service.getEntityVersion({
      entityRef: 'user:default/alice',
      id,
    });

    // Assert
    await expect(result).rejects.toBeInstanceOf(NotFoundError);
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

  it.each([
    ['getEntityTimeline', 'changedAfter', 'not-a-timestamp'],
    ['getEntityTimeline', 'changedBefore', ''],
    ['getEntityVersions', 'changedAfter', 'Sat Jul 07 2026 00:00:00 GMT+0000'],
    ['getEntityVersions', 'changedBefore', '2026-07-07'],
  ] as const)(
    'rejects an invalid timestamp passed to %s as %s',
    async (method, field, timestamp) => {
      await expect(
        service[method]({
          entityRef: 'user:default/alice',
          [field]: timestamp,
        }),
      ).rejects.toThrow(`Invalid history ${field} timestamp`);
    },
  );
});
