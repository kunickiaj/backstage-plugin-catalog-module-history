import { Knex } from 'knex';
import {
  CaptureSource,
  CurrentEtag,
  CycleInput,
  EntityRow,
  HistoryStore,
} from '@kunickiaj/catalog-history-node';
import { ensureSchema } from './ensureSchema';

// catalog_history_entities has ~20 inserted columns, so the PostgreSQL
// bind-parameter limit (65,535) caps a single INSERT at ~3,276 rows. Chunking
// at 1,000 gives generous headroom and stays well clear of that limit even if
// columns grow.
const ENTITY_INSERT_CHUNK_SIZE = 1000;

type PostgresHistoryStoreOptions = {
  ownsDatabase?: boolean;
};

function parseEntityRef(entityRef: string): {
  kind: string;
  namespace: string;
  name: string;
} {
  const [kind, rest] = entityRef.split(':', 2);
  const [namespace, name] = (rest ?? '').split('/', 2);
  return { kind, namespace, name };
}

type EntityInsertRow = {
  cycle_id: string;
  entity_ref: string;
  kind: string;
  namespace: string;
  name: string;
  provider: string;
  source: CaptureSource;
  op: 'insert' | 'update' | 'delete';
  etag: string | null;
  display_name: string | null;
  email: string | null;
  parent: string | null;
  member_of: string | null;
  owner: string | null;
  metadata: string | null;
  spec: string | null;
  relations: string | null;
  status_items: string | null;
  orphan: boolean | null;
  changed_at: Date;
};

function buildEntityRow(
  row: EntityRow,
  cycleId: string,
  provider: string,
  source: CaptureSource,
  op: 'insert' | 'update',
  changedAt: Date,
): EntityInsertRow {
  return {
    cycle_id: cycleId,
    entity_ref: row.entityRef,
    kind: row.kind,
    namespace: row.namespace,
    name: row.name,
    provider,
    source,
    op,
    etag: row.etag,
    display_name: row.displayName ?? null,
    email: row.email ?? null,
    parent: row.parent ?? null,
    member_of: row.memberOf ? JSON.stringify(row.memberOf) : null,
    owner: row.owner ?? null,
    metadata: JSON.stringify(row.metadata),
    spec: JSON.stringify(row.spec),
    relations: row.relations ? JSON.stringify(row.relations) : null,
    status_items: row.statusItems ? JSON.stringify(row.statusItems) : null,
    orphan: row.orphan ?? null,
    changed_at: changedAt,
  };
}

function buildDeleteRow(
  entityRef: string,
  cycleId: string,
  provider: string,
  source: CaptureSource,
  changedAt: Date,
): EntityInsertRow {
  const { kind, namespace, name } = parseEntityRef(entityRef);
  return {
    cycle_id: cycleId,
    entity_ref: entityRef,
    kind,
    namespace,
    name,
    provider,
    source,
    op: 'delete',
    etag: null,
    display_name: null,
    email: null,
    parent: null,
    member_of: null,
    owner: null,
    metadata: null,
    spec: null,
    relations: null,
    status_items: null,
    orphan: null,
    changed_at: changedAt,
  };
}

export class PostgresHistoryStore implements HistoryStore {
  private schemaReady: Promise<void> | undefined;
  private shutdownPromise: Promise<void> | undefined;
  private readonly shutdownHooks: Array<() => Promise<void>> = [];

  constructor(
    private readonly db: Knex,
    private readonly options: PostgresHistoryStoreOptions = {},
  ) {}

  async ensureReady(): Promise<void> {
    this.schemaReady ??= ensureSchema(this.db).catch(error => {
      this.schemaReady = undefined;
      throw error;
    });
    await this.schemaReady;
  }

  addShutdownHook(hook: () => Promise<void>): void {
    this.shutdownHooks.unshift(hook);
  }

  async shutdown(): Promise<void> {
    this.shutdownPromise ??= this.shutdownOnce();
    await this.shutdownPromise;
  }

  async loadCurrentEtags(
    provider: string,
    opts: { source?: CaptureSource } = {},
  ): Promise<Map<string, string>> {
    await this.ensureReady();

    // changed_at is set to the cycle's finishedAt for every row in a cycle,
    // so two rows for the same entity_ref can be tied on changed_at alone
    // (same cycle, or two cycles finishing in the same clock tick). id is
    // BIGSERIAL and strictly monotonic, so id DESC is a deterministic
    // tie-breaker for "latest".
    const latest = this.db('catalog_history_entities')
      .select('entity_ref', 'op', 'etag')
      .distinctOn('entity_ref')
      .where({ provider })
      .orderBy('entity_ref')
      .orderBy('changed_at', 'desc')
      .orderBy('id', 'desc');
    if (opts.source) {
      latest.where('source', opts.source);
    }

    const rows = await this.db
      .with('latest', latest)
      .from('latest')
      .where('op', '!=', 'delete')
      .select('entity_ref', 'etag');

    const result = new Map<string, string>();
    for (const row of rows) {
      if (row.etag !== null && row.etag !== undefined) {
        result.set(row.entity_ref, row.etag);
      }
    }
    return result;
  }

  async loadAllCurrentEtags(
    opts: { source?: CaptureSource } = {},
  ): Promise<Map<string, CurrentEtag>> {
    await this.ensureReady();

    // id DESC is a deterministic tie-breaker on changed_at; see the comment
    // in loadCurrentEtags for the full rationale.
    const latest = this.db('catalog_history_entities')
      .select('entity_ref', 'op', 'etag', 'provider')
      .distinctOn('entity_ref')
      .orderBy('entity_ref')
      .orderBy('changed_at', 'desc')
      .orderBy('id', 'desc');
    if (opts.source) {
      latest.where('source', opts.source);
    }

    const rows = await this.db
      .with('latest', latest)
      .from('latest')
      .where('op', '!=', 'delete')
      .select('entity_ref', 'etag', 'provider');

    const result = new Map<string, CurrentEtag>();
    for (const row of rows) {
      if (row.etag !== null && row.etag !== undefined) {
        result.set(row.entity_ref, {
          etag: row.etag,
          provider: row.provider,
        });
      }
    }
    return result;
  }

  async recordCycle(input: CycleInput): Promise<void> {
    await this.ensureReady();

    const changedAt = input.finishedAt;

    await this.db.transaction(async tx => {
      await tx('catalog_history_cycles').insert({
        cycle_id: input.cycleId,
        provider: input.provider,
        source: input.source,
        mutation_type: input.mutationType,
        started_at: input.startedAt,
        finished_at: input.finishedAt,
        n_added: input.inserts.length,
        n_modified: input.updates.length,
        n_removed: input.deletes.length,
        n_unchanged: input.unchangedCount,
      });

      const entityRows: EntityInsertRow[] = [];
      for (const row of input.inserts) {
        entityRows.push(
          buildEntityRow(
            row,
            input.cycleId,
            input.provider,
            input.source,
            'insert',
            changedAt,
          ),
        );
      }
      for (const row of input.updates) {
        entityRows.push(
          buildEntityRow(
            row,
            input.cycleId,
            input.provider,
            input.source,
            'update',
            changedAt,
          ),
        );
      }
      for (const ref of input.deletes) {
        entityRows.push(
          buildDeleteRow(
            ref,
            input.cycleId,
            input.provider,
            input.source,
            changedAt,
          ),
        );
      }

      if (entityRows.length > 0) {
        await tx.batchInsert(
          'catalog_history_entities',
          entityRows,
          ENTITY_INSERT_CHUNK_SIZE,
        );
      }
    });
  }

  private async shutdownOnce(): Promise<void> {
    for (const hook of this.shutdownHooks) {
      await hook();
    }
    if (this.options.ownsDatabase) {
      await this.db.destroy();
    }
  }
}
