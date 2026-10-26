import { Buffer } from 'node:buffer';
import { randomUUID } from 'node:crypto';
import { TestDatabases } from '@backstage/backend-test-utils';
import { InputError } from '@backstage/errors';
import type { HistoryChangeFeedRequest } from '@kunickiaj/backstage-plugin-catalog-history-common';
import type { Knex } from 'knex';
import { ensureSchema } from '../ensureSchema';
import { PostgresHistoryQueryService } from '../PostgresHistoryQueryService';

jest.setTimeout(30000);

describe('PostgresHistoryQueryService change feed', () => {
  const databases = TestDatabases.create({ ids: ['POSTGRES_16'] });
  let db: Knex;
  let service: PostgresHistoryQueryService;
  const at = '2026-07-07T00:00:00Z';

  beforeEach(async () => {
    db = await databases.init('POSTGRES_16');
    await ensureSchema(db);
    service = new PostgresHistoryQueryService(db);
  });

  async function insert(
    entityRef: string,
    options: {
      kind?: string;
      source?: 'provider' | 'processing' | 'reconciler';
      provider?: string;
      op?: 'insert' | 'update' | 'delete';
      changedAt?: string;
    } = {},
  ) {
    const [kind, rest] = entityRef.split(':');
    const [namespace, name] = rest.split('/');
    const cycleId = randomUUID();
    const source = options.source ?? 'provider';
    const provider = options.provider ?? 'one';
    const changedAt = options.changedAt ?? at;
    await db('catalog_history_cycles').insert({
      cycle_id: cycleId,
      source,
      provider,
      mutation_type: 'delta',
      started_at: changedAt,
      finished_at: changedAt,
    });
    const [row] = await db('catalog_history_entities')
      .insert({
        cycle_id: cycleId,
        entity_ref: entityRef,
        kind: options.kind ?? kind,
        namespace,
        name,
        source,
        provider,
        op: options.op ?? 'insert',
        etag: options.op === 'delete' ? null : 'shared-etag',
        metadata: { name, description: 'snapshot-only' },
        spec: { type: 'service' },
        changed_at: changedAt,
      })
      .returning('id');
    return { id: String(row.id), cycleId };
  }

  it('lists retained entities, kinds, provenance, and tombstones without snapshot payloads', async () => {
    // Arrange: repeated etags are distinct events, not versions to deduplicate.
    const first = await insert('component:default/a', { kind: 'Component' });
    const second = await insert('user:other/b', {
      source: 'processing',
      provider: 'two',
      op: 'update',
    });
    const deleted = await insert('component:default/a', {
      source: 'reconciler',
      provider: 'three',
      op: 'delete',
      changedAt: '2026-07-07T01:00:00Z',
    });

    // Act
    const page = await service.getChangeFeed({});

    // Assert
    expect(page.items.map(item => item.id)).toEqual([
      deleted.id,
      second.id,
      first.id,
    ]);
    expect(page.items[0]).toEqual({
      ...deleted,
      entityRef: 'component:default/a',
      kind: 'component',
      namespace: 'default',
      name: 'a',
      source: 'reconciler',
      provider: 'three',
      op: 'delete',
      changedAt: '2026-07-07T01:00:00.000Z',
      etag: undefined,
      summary: {},
    });
    expect(page.items[1]).toMatchObject({
      entityRef: 'user:other/b',
      kind: 'user',
      namespace: 'other',
      name: 'b',
      source: 'processing',
      provider: 'two',
      op: 'update',
      etag: 'shared-etag',
    });
    for (const item of page.items) {
      expect(Object.keys(item).sort()).toEqual(
        [
          'id',
          'cycleId',
          'entityRef',
          'kind',
          'namespace',
          'name',
          'source',
          'provider',
          'op',
          'changedAt',
          'etag',
          'summary',
        ].sort(),
      );
      expect(item).not.toHaveProperty('snapshot');
    }
    expect(JSON.stringify(page)).not.toContain('snapshot-only');
    expect(page.nextCursor).toBeUndefined();
  });

  it('paginates equal timestamps by descending ID with no overlap and repeatable final pages', async () => {
    // Arrange
    const ids: string[] = [];
    for (const name of ['a', 'b', 'c', 'd', 'e']) {
      ids.push((await insert(`component:default/${name}`)).id);
    }

    // Act
    const first = await service.getChangeFeed({ limit: 2 });
    const second = await service.getChangeFeed({
      limit: 2,
      cursor: first.nextCursor,
    });
    const lastRequest = { limit: 2, cursor: second.nextCursor };
    const last = await service.getChangeFeed(lastRequest);
    const repeated = await service.getChangeFeed(lastRequest);

    // Assert
    expect(first.nextCursor).toEqual(expect.any(String));
    expect(second.nextCursor).toEqual(expect.any(String));
    const found = [...first.items, ...second.items, ...last.items].map(
      item => item.id,
    );
    expect(found).toEqual(ids.reverse());
    expect(new Set(found).size).toBe(5);
    expect(last.items).toHaveLength(1);
    expect(last.nextCursor).toBeUndefined();
    expect(repeated).toEqual(last);
  });

  it('rejects a cursor whose anchor row was removed instead of returning an empty page', async () => {
    // Arrange: the anchor is the oldest row on the first page.
    for (const name of ['a', 'b', 'c']) {
      await insert(`component:default/${name}`);
    }
    const first = await service.getChangeFeed({ limit: 2 });
    const anchorId = first.items[1].id;
    await db('catalog_history_entities').where('id', anchorId).delete();
    // Act / Assert
    await expect(
      service.getChangeFeed({ limit: 2, cursor: first.nextCursor }),
    ).rejects.toThrow(/removed history/);
    await expect(
      service.getChangeFeed({ limit: 2, cursor: first.nextCursor }),
    ).rejects.toBeInstanceOf(InputError);
  });

  it('keeps an empty final page when the cursor anchor still exists', async () => {
    // Arrange: a filter that matches nothing after the anchor.
    await insert('component:default/a');
    await insert('component:default/b');
    const first = await service.getChangeFeed({ limit: 1 });
    await db('catalog_history_entities')
      .whereNot('id', first.items[0].id)
      .delete();
    // Act
    const next = await service.getChangeFeed({
      limit: 1,
      cursor: first.nextCursor,
    });
    // Assert
    expect(next).toEqual({ items: [], nextCursor: undefined });
  });

  it('combines exact entity/kind/provenance/operation/time filters without a global fallback', async () => {
    // Arrange
    await insert('component:default/a', { kind: 'Component' });
    const match = await insert('component:default/a', {
      kind: 'COMPONENT',
      source: 'processing',
      provider: 'two',
      op: 'update',
      changedAt: '2026-07-07T01:00:00Z',
    });
    await insert('component:default/ab', {
      source: 'processing',
      provider: 'two',
      op: 'update',
      changedAt: '2026-07-07T01:00:00Z',
    });
    await insert('user:default/a', {
      source: 'processing',
      provider: 'two',
      op: 'update',
    });
    const filters: HistoryChangeFeedRequest = {
      entityRef: 'component:default/a',
      kind: 'cOmPoNeNt',
      source: 'processing',
      provider: 'two',
      op: 'update',
      changedAfter: '2026-07-07T00:30:00Z',
      changedBefore: '2026-07-07T01:30:00Z',
    };

    // Act
    const page = await service.getChangeFeed(filters);
    const conflict = await service.getChangeFeed({ ...filters, kind: 'User' });
    const missing = await service.getChangeFeed({
      entityRef: 'component:default/missing',
    });
    const outside = await service.getChangeFeed({
      ...filters,
      changedAfter: '2026-07-07T01:01:00Z',
    });

    // Assert
    expect(page.items.map(item => item.id)).toEqual([match.id]);
    expect(conflict.items).toEqual([]);
    expect(missing.items).toEqual([]);
    expect(outside.items).toEqual([]);
  });

  it.each(['2026-07-07T00:00:00.000999Z', '2026-07-07T02:00:00.000999+02:00'])(
    'preserves fractional precision in inclusive time bounds %s',
    async bound => {
      // Arrange: raw strings preserve PostgreSQL microseconds instead of Date rounding.
      const rows: Record<string, string> = {};
      for (const fraction of ['000', '000500', '000999', '001']) {
        rows[fraction] = (
          await insert(`component:default/fraction-${fraction}`, {
            changedAt: `2026-07-07T00:00:00.${fraction}Z`,
          })
        ).id;
      }

      // Act
      const after = await service.getChangeFeed({ changedAfter: bound });
      const before = await service.getChangeFeed({ changedBefore: bound });
      const equal = await service.getChangeFeed({
        changedAfter: bound,
        changedBefore: bound,
      });

      // Assert: compare IDs because response Date values have only millisecond precision.
      expect(after.items.map(item => item.id)).toEqual([
        rows['001'],
        rows['000999'],
      ]);
      expect(before.items.map(item => item.id)).toEqual([
        rows['000999'],
        rows['000500'],
        rows['000'],
      ]);
      expect(equal.items.map(item => item.id)).toEqual([rows['000999']]);
    },
  );

  it('uses 25 by default and caps oversized pages at 100', async () => {
    // Arrange
    for (let index = 0; index < 101; index += 1) {
      await insert(`component:default/entity-${index}`);
    }

    // Act
    const defaultPage = await service.getChangeFeed({});
    const capped = await service.getChangeFeed({ limit: 101 });

    // Assert
    expect(defaultPage.items).toHaveLength(25);
    expect(defaultPage.nextCursor).toEqual(expect.any(String));
    expect(capped.items).toHaveLength(100);
    expect(capped.nextCursor).toEqual(expect.any(String));
  });

  it.each(['group:default/team', ''])(
    'rejects unsupported owner %j before schema setup or querying',
    async owner => {
      // Arrange: an explicit empty owner must not bypass the unsupported filter check.
      const database = jest.fn();
      const queryService = new PostgresHistoryQueryService(
        database as unknown as Knex,
      );
      const ensureReady = jest.spyOn(queryService, 'ensureReady');

      // Act
      const result = queryService.getChangeFeed({ owner });

      // Assert
      await expect(result).rejects.toBeInstanceOf(InputError);
      expect(ensureReady).not.toHaveBeenCalled();
      expect(database).not.toHaveBeenCalled();
    },
  );

  it.each([
    { limit: 0 },
    { limit: -1 },
    { limit: 1.5 },
    { limit: NaN },
    { cursor: 'invalid' },
    {
      cursor: Buffer.from(
        JSON.stringify({ changedAt: at, id: '9223372036854775808' }),
      ).toString('base64url'),
    },
    { changedAfter: 'not-a-date' },
    { changedBefore: '2026-07-07' },
  ])('rejects invalid service input %j', async filters => {
    // Arrange
    const input: HistoryChangeFeedRequest = filters;

    // Act
    const result = service.getChangeFeed(input);

    // Assert
    await expect(result).rejects.toBeInstanceOf(InputError);
  });
});
