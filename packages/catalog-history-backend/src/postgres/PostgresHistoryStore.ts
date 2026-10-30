import type { Knex } from 'knex';
import type { MetricsService } from '@backstage/backend-plugin-api/alpha';
import type {
  CaptureSource,
  CurrentEtag,
  CycleInput,
  EntityRow,
  HistoryRetentionCounts,
  HistoryRetentionRequest,
  HistoryStore,
  ProviderMutationStore,
} from '@kunickiaj/backstage-plugin-catalog-history-node';
import { ensureSchema } from './ensureSchema';
import { runProviderMutation } from './providerMutation';
import { createProviderCoordinationDatabase } from './providerCoordinationDatabase';
import {
  applyRetention,
  assertRetentionBatchSize,
  assertRetentionCutoff,
  planRetention,
} from './retention';
import { PostgresHistoryQueryService } from './PostgresHistoryQueryService';
import { normalizeQueryTimeoutMs } from './historyQueryTimeout';
import {
  createHistoryStorageMetrics,
  type HistoryStorageMetrics,
} from './historyStorageMetrics';

// catalog_history_entities has ~20 inserted columns, so the PostgreSQL
// bind-parameter limit (65,535) caps a single INSERT at ~3,276 rows. Chunking
// at 1,000 gives generous headroom and stays well clear of that limit even if
// columns grow.
const ENTITY_INSERT_CHUNK_SIZE = 1000;

type PostgresHistoryStoreOptions = {
  ownsDatabase?: boolean;
  queryTimeoutMs?: number;
  metrics?: MetricsService;
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

/** Entity rows for one cycle: inserts, then updates, then deletes. */
function buildCycleRows(input: CycleInput): EntityInsertRow[] {
  const { cycleId, provider, source, finishedAt: changedAt } = input;
  return [
    ...input.inserts.map(row =>
      buildEntityRow(row, cycleId, provider, source, 'insert', changedAt),
    ),
    ...input.updates.map(row =>
      buildEntityRow(row, cycleId, provider, source, 'update', changedAt),
    ),
    ...input.deletes.map(ref =>
      buildDeleteRow(ref, cycleId, provider, source, changedAt),
    ),
  ];
}

export class PostgresHistoryStore implements HistoryStore {
  readonly query: PostgresHistoryQueryService;
  private schemaReady: Promise<void> | undefined;
  private shutdownPromise: Promise<void> | undefined;
  private shutdownStarted = false;
  private coordinationDb: Knex | undefined;
  private readonly shutdownHooks: Array<() => Promise<void>> = [];
  private readonly metrics: HistoryStorageMetrics;

  constructor(
    private readonly db: Knex,
    private readonly options: PostgresHistoryStoreOptions = {},
  ) {
    const queryTimeoutMs = normalizeQueryTimeoutMs(options.queryTimeoutMs);
    this.metrics = createHistoryStorageMetrics(options.metrics);
    this.query = new PostgresHistoryQueryService(db, {
      queryTimeoutMs,
      metrics: this.metrics,
      // Reads and writes share one schema bootstrap.
      ensureReady: () => this.ensureReady(),
    });
  }

  async ensureReady(): Promise<void> {
    this.schemaReady ??= ensureSchema(this.db).catch(error => {
      this.schemaReady = undefined;
      throw error;
    });
    await this.schemaReady;
  }

  async withProviderMutation<T>(
    provider: string,
    work: (store: ProviderMutationStore) => Promise<T>,
  ): Promise<T> {
    this.assertOpenForCoordination();
    if (this.db.isTransaction) {
      throw new Error(
        'Provider mutation coordination requires an owned outer transaction',
      );
    }
    await this.ensureReady();
    this.assertOpenForCoordination();
    // Assignment happens only after successful construction. A later call may
    // retry construction or connection acquisition, but never its callback.
    const coordinationDb = (this.coordinationDb ??=
      createProviderCoordinationDatabase(this.db));
    return this.metrics.persist(
      () => 'provider',
      () =>
        runProviderMutation({
          db: coordinationDb,
          provider,
          work,
          assertOpen: () => this.assertOpenForCoordination(),
          createStore: tx => this.createProviderMutationStore(tx),
        }),
    );
  }

  addShutdownHook(hook: () => Promise<void>): void {
    this.shutdownHooks.unshift(hook);
  }

  async shutdown(): Promise<void> {
    this.shutdownStarted = true;
    this.shutdownPromise ??= this.shutdownOnce();
    await this.shutdownPromise;
  }

  async loadCurrentEtags(
    provider: string,
    opts: { source?: CaptureSource } = {},
  ): Promise<Map<string, string>> {
    return this.metrics.storage(
      'load_current_etags',
      () => opts.source ?? 'all',
      async () => {
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
      },
    );
  }

  async loadAllCurrentEtags(
    opts: { source?: CaptureSource } = {},
  ): Promise<Map<string, CurrentEtag>> {
    return this.metrics.storage(
      'load_all_current_etags',
      () => opts.source ?? 'all',
      async () => {
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
      },
    );
  }

  async recordCycle(input: CycleInput): Promise<void> {
    return this.metrics.storage(
      'record_cycle',
      () => input.source,
      async () => {
        await this.ensureReady();
        await this.metrics.persist(
          () => input.source,
          () =>
            this.db.transaction(async tx => {
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

              const entityRows = buildCycleRows(input);

              if (entityRows.length > 0) {
                await tx.batchInsert(
                  'catalog_history_entities',
                  entityRows,
                  ENTITY_INSERT_CHUNK_SIZE,
                );
              }
            }),
          { callerOwnedTransaction: this.db.isTransaction === true },
        );
      },
    );
  }

  async planRetention(
    request: HistoryRetentionRequest,
  ): Promise<HistoryRetentionCounts> {
    return this.metrics.storage(
      'plan_retention',
      () => 'all',
      async () => {
        assertRetentionCutoff(request.cutoff);
        await this.ensureReady();
        return planRetention(this.db, request.cutoff);
      },
    );
  }

  async applyRetention(
    request: HistoryRetentionRequest & {
      batchSize: number;
      signal?: AbortSignal;
    },
  ): Promise<HistoryRetentionCounts> {
    return this.metrics.storage(
      'apply_retention',
      () => 'all',
      async () => {
        assertRetentionCutoff(request.cutoff);
        assertRetentionBatchSize(request.batchSize);
        await this.ensureReady();
        return applyRetention(this.db, {
          cutoff: request.cutoff,
          batchSize: request.batchSize,
          signal: request.signal,
        });
      },
    );
  }

  private async shutdownOnce(): Promise<void> {
    try {
      for (const hook of this.shutdownHooks) {
        await hook();
      }
      if (this.options.ownsDatabase) {
        await this.db.destroy();
      }
    } finally {
      try {
        await this.coordinationDb?.destroy();
      } finally {
        this.metrics.dispose();
      }
    }
  }

  private assertOpenForCoordination(): void {
    if (this.shutdownStarted) {
      throw new Error('Provider mutation coordination is shut down');
    }
  }

  private createProviderMutationStore(
    tx: Knex.Transaction,
  ): ProviderMutationStore {
    const store = new PostgresHistoryStore(tx);
    // Bootstrap completed before taking the lock. Never migrate from the
    // scoped transaction or acquire a second pool connection here.
    store.schemaReady = Promise.resolve();
    return {
      loadCurrentEtags: (provider, opts) =>
        this.metrics.storage(
          'load_current_etags',
          () => 'provider',
          () => store.loadCurrentEtags(provider, opts),
        ),
      recordCycle: input =>
        this.metrics.storage(
          'record_cycle',
          () => 'provider',
          () => store.recordCycle(input),
        ),
    };
  }
}
