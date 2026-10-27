import { randomUUID } from 'node:crypto';
import { TestDatabases } from '@backstage/backend-test-utils';
import { InputError, NotFoundError } from '@backstage/errors';
import type { Knex } from 'knex';
import type { HistoryEntityDiffRequest } from '@kunickiaj/backstage-plugin-catalog-history-common';
import type {
  CaptureSource,
  EntityRow,
} from '@kunickiaj/backstage-plugin-catalog-history-node';
import { PostgresHistoryStore } from '../PostgresHistoryStore';
import { metricsJournal } from './metricsJournal';

jest.setTimeout(30000);

const entityRef = 'user:default/alice';

function rows(from: string, to: string): HistoryEntityDiffRequest {
  return {
    entityRef,
    from: { kind: 'history-row', id: from },
    to: { kind: 'history-row', id: to },
  };
}

describe('PostgresHistoryQueryService entity diff', () => {
  const databases = TestDatabases.create({ ids: ['POSTGRES_16'] });
  let db: Knex;
  let store: PostgresHistoryStore;
  let journal: ReturnType<typeof metricsJournal>;

  beforeEach(async () => {
    db = await databases.init('POSTGRES_16');
    journal = metricsJournal();
    store = new PostgresHistoryStore(db, { metrics: journal.metrics });
    await store.ensureReady();
  });

  afterEach(async () => {
    await store?.shutdown();
  });

  async function record(
    options: {
      ref?: string;
      op?: 'insert' | 'update' | 'delete';
      source?: CaptureSource;
      provider?: string;
      fields?: Partial<EntityRow>;
    } = {},
  ): Promise<string> {
    const ref = options.ref ?? entityRef;
    const name = ref.split('/')[1];
    const cycleId = randomUUID();
    const op = options.op ?? 'insert';
    const row: EntityRow = {
      entityRef: ref,
      kind: 'User',
      namespace: 'default',
      name,
      etag: randomUUID(),
      metadata: { name },
      spec: {},
      ...options.fields,
    };
    const now = new Date();
    await store.recordCycle({
      cycleId,
      provider: options.provider ?? 'diff-provider',
      source: options.source ?? 'provider',
      mutationType: 'full',
      startedAt: now,
      finishedAt: now,
      inserts: op === 'insert' ? [row] : [],
      updates: op === 'update' ? [row] : [],
      deletes: op === 'delete' ? [row.entityRef] : [],
      unchangedCount: 0,
    });
    const saved = await db('catalog_history_entities')
      .where({ cycle_id: cycleId })
      .first('id');
    return String(saved.id);
  }

  it('describes how from became to in the requested order', async () => {
    // Arrange
    const older = await record({
      fields: { owner: 'group:default/a', spec: { profile: { title: 'x' } } },
    });
    const newer = await record({
      op: 'update',
      fields: {
        owner: 'group:default/b',
        spec: { profile: { title: 'x', email: 'a@example.com' } },
      },
    });
    // Act
    const forward = await store.query.getEntityDiff(rows(older, newer));
    const backward = await store.query.getEntityDiff(rows(newer, older));
    // Assert
    expect(forward.entityRef).toBe(entityRef);
    expect(forward.from?.id).toBe(older);
    expect(forward.to?.id).toBe(newer);
    expect(forward.changes).toEqual([
      {
        path: ['owner'],
        op: 'replace',
        before: 'group:default/a',
        after: 'group:default/b',
      },
      { path: ['spec', 'profile', 'email'], op: 'add', after: 'a@example.com' },
    ]);
    expect(backward.changes).toEqual([
      {
        path: ['owner'],
        op: 'replace',
        before: 'group:default/b',
        after: 'group:default/a',
      },
      {
        path: ['spec', 'profile', 'email'],
        op: 'remove',
        before: 'a@example.com',
      },
    ]);
  });

  it('compares rows from different capture streams and reports both provenances', async () => {
    // Arrange: processing records relations that provider capture does not.
    const provider = await record();
    const processing = await record({
      source: 'processing',
      provider: 'catalog',
      fields: {
        relations: [{ type: 'memberOf', targetRef: 'group:default/a' }],
      },
    });
    // Act
    const result = await store.query.getEntityDiff(rows(provider, processing));
    // Assert
    expect(result.from).toEqual(
      expect.objectContaining({
        source: 'provider',
        provider: 'diff-provider',
      }),
    );
    expect(result.to).toEqual(
      expect.objectContaining({ source: 'processing', provider: 'catalog' }),
    );
    expect(result.changes).toEqual([
      {
        path: ['relations'],
        op: 'add',
        after: [{ type: 'memberOf', targetRef: 'group:default/a' }],
      },
    ]);
  });

  it('treats a delete on either side as an absent snapshot', async () => {
    // Arrange
    const saved = await record({ fields: { owner: 'group:default/a' } });
    const deleted = await record({ op: 'delete' });
    const restored = await record({ fields: { owner: 'group:default/a' } });
    // Act
    const toDelete = await store.query.getEntityDiff(rows(saved, deleted));
    const fromDelete = await store.query.getEntityDiff(rows(deleted, restored));
    // Assert
    expect(toDelete.to?.op).toBe('delete');
    expect(toDelete.to?.snapshot).toBeUndefined();
    expect(toDelete.changes.every(change => change.op === 'remove')).toBe(true);
    expect(toDelete.changes).toContainEqual({
      path: ['owner'],
      op: 'remove',
      before: 'group:default/a',
    });
    expect(fromDelete.changes.every(change => change.op === 'add')).toBe(true);
    expect(fromDelete.changes).toContainEqual({
      path: ['owner'],
      op: 'add',
      after: 'group:default/a',
    });
  });

  it('returns no changes for two deletes', async () => {
    // Arrange
    const first = await record({ op: 'delete' });
    const second = await record({ op: 'delete' });
    // Act
    const result = await store.query.getEntityDiff(rows(first, second));
    // Assert
    expect(result.changes).toEqual([]);
  });

  it.each([
    ['a row of another entity', 'other'],
    ['a missing row', 'missing'],
  ] as const)('returns not found for %s', async (_, scenario) => {
    // Arrange
    const known = await record();
    const unknown =
      scenario === 'other'
        ? await record({ ref: 'user:default/bob' })
        : String(BigInt(known) + 1000n);
    // Act / Assert
    await expect(
      store.query.getEntityDiff(rows(known, unknown)),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it.each<[string, Partial<HistoryEntityDiffRequest>]>([
    ['a cycle target', { to: { kind: 'cycle', cycleId: randomUUID() } }],
    [
      'a timestamp target',
      { from: { kind: 'timestamp', timestamp: '2026-01-01T00:00:00Z' } },
    ],
    ['the same row twice', { to: { kind: 'history-row', id: '1' } }],
    ['an invalid row id', { to: { kind: 'history-row', id: '0' } }],
    ['a source filter', { source: 'provider' }],
    ['a provider filter', { provider: 'diff-provider' }],
    ['an empty entity ref', { entityRef: '' }],
  ])('rejects %s before querying', async (_, override) => {
    // Arrange
    const request = { ...rows('1', '2'), ...override };
    // Act / Assert
    await expect(store.query.getEntityDiff(request)).rejects.toBeInstanceOf(
      InputError,
    );
    expect(
      journal.points.filter(
        p => p.name === 'catalog.history.query.operation.duration',
      ),
    ).toEqual([]);
  });

  it('records the diff query operation in metrics', async () => {
    // Arrange
    const first = await record();
    const second = await record({ op: 'update' });
    // Act
    await store.query.getEntityDiff(rows(first, second));
    // Assert
    expect(
      journal.points.filter(
        p => p.name === 'catalog.history.query.operation.duration',
      ),
    ).toEqual([
      expect.objectContaining({
        attributes: { operation: 'diff', outcome: 'success' },
      }),
    ]);
  });
});
