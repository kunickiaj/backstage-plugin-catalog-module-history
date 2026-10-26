import { Buffer } from 'node:buffer';
import { InputError, NotFoundError } from '@backstage/errors';
import { Knex } from 'knex';
import {
  DEFAULT_HISTORY_PAGE_LIMIT,
  HISTORY_SOURCES,
  MAX_HISTORY_PAGE_LIMIT,
} from '@kunickiaj/backstage-plugin-catalog-history-common';
import type {
  HistoryChangeFeedRequest,
  HistoryChangeFeedResponse,
  HistoryCycleChange,
  HistoryCycle,
  HistoryCycleListRequest,
  HistoryCycleListResponse,
  HistoryCycleDetailRequest,
  HistoryCycleDetailResponse,
  HistoryMutationType,
  HistoryEntityAsOfRequest,
  HistoryEntityAsOfResponse,
  HistoryEntitySearchRequest,
  HistoryEntitySearchResponse,
  HistoryEntitySnapshot,
  HistoryEntityTimelineRequest,
  HistoryEntityTimelineResponse,
  HistoryTimelineItem,
  HistoryTimelineSummary,
  HistoryEntityVersion,
  HistoryEntityVersionRequest,
  HistoryEntityVersionResponse,
  HistoryEntityVersionsRequest,
  HistoryEntityVersionsResponse,
  HistoryJsonObject,
  HistoryKindSearchRequest,
  HistoryKindSearchResponse,
  HistoryOperation,
  HistoryProviderSearchRequest,
  HistoryProviderSearchResponse,
  HistorySource,
} from '@kunickiaj/backstage-plugin-catalog-history-common';
import { ensureSchema } from './ensureSchema';
import {
  cycleListScope,
  cycleChangesScope,
  decodeCycleCursor,
  encodeCycleCursor,
  normalizeCycleId,
} from './cycleCursors';
import {
  decodeEntitySearchCursor,
  decodeKindSearchCursor,
  encodeEntitySearchCursor,
  encodeKindSearchCursor,
  entitySearchScope,
  kindSearchScope,
} from './entityDiscoveryCursor';
import { diffSnapshots, summarizeSnapshotFields } from './diffSnapshots';
import {
  decodeProviderSearchCursor,
  encodeProviderSearchCursor,
  providerSearchScope,
} from './providerSearchCursor';
import {
  normalizeQueryTimeoutMs,
  withHistoryQueryTimeout,
} from './historyQueryTimeout';
import {
  createHistoryStorageMetrics,
  type HistoryStorageMetrics,
  type QueryOperation,
} from './historyStorageMetrics';

const ISO_8601_INSTANT =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

type HistoryChangeRow = {
  id: string;
  cycle_id: string;
  entity_ref: string;
  kind: string;
  namespace: string;
  name: string;
  provider: string;
  source: HistorySource;
  op: HistoryOperation;
  etag: string | null;
  changed_at: Date;
};

type HistoryEntityRow = HistoryChangeRow & {
  display_name: string | null;
  email: string | null;
  parent: string | null;
  member_of: unknown;
  owner: string | null;
  metadata: unknown;
  spec: unknown;
  relations: unknown;
  status_items: unknown;
  orphan: boolean | null;
};

type HistoryCycleRow = {
  cycle_id: string;
  provider: string;
  source: HistorySource;
  mutation_type: HistoryMutationType;
  started_at: Date;
  finished_at: Date;
  n_added: number;
  n_modified: number;
  n_removed: number;
  n_unchanged: number;
  cursor_timestamp: string;
};

const CYCLE_COLUMNS = [
  'cycle_id',
  'provider',
  'source',
  'mutation_type',
  'started_at',
  'finished_at',
  'n_added',
  'n_modified',
  'n_removed',
  'n_unchanged',
];

function rowToCycle(row: HistoryCycleRow): HistoryCycle {
  return {
    cycleId: row.cycle_id,
    provider: row.provider,
    source: row.source,
    mutationType: row.mutation_type,
    startedAt: row.started_at.toISOString(),
    finishedAt: row.finished_at.toISOString(),
    counts: {
      inserted: row.n_added,
      updated: row.n_modified,
      deleted: row.n_removed,
      unchanged: row.n_unchanged,
    },
  };
}

function applyCycleFilters(
  db: Knex,
  query: Knex.QueryBuilder<HistoryCycleRow, HistoryCycleRow[]>,
  request: HistoryCycleListRequest,
): void {
  for (const [field, column] of [
    ['source', 'source'],
    ['provider', 'provider'],
    ['mutationType', 'mutation_type'],
  ] as const) {
    if (request[field] !== undefined) query.where(column, request[field]);
  }
  for (const [field, column, comparison] of [
    ['startedAfter', 'started_at', '>='],
    ['startedBefore', 'started_at', '<='],
    ['finishedAfter', 'finished_at', '>='],
    ['finishedBefore', 'finished_at', '<='],
  ] as const) {
    if (request[field] !== undefined)
      query.where(column, comparison, request[field]);
  }
  if (request.op !== undefined) {
    // Ledger counts include pruned rows; only retained operations match this filter.
    query.whereExists(
      db('catalog_history_entities as changes')
        .select(db.raw('1'))
        .whereRaw('changes.cycle_id = catalog_history_cycles.cycle_id')
        .where('changes.op', request.op),
    );
  }
}

type EntityDiscoveryRow = Pick<
  HistoryChangeRow,
  'entity_ref' | 'kind' | 'namespace' | 'name'
> & { folded_name: string };

type KindDiscoveryRow = { kind: string; folded_name: string };

function escapeLikeSql(value: string): string {
  return `replace(replace(replace(${value}, chr(92), chr(92)||chr(92)), '%', chr(92)||'%'), '_', chr(92)||'_')`;
}

function applyDiscoveryPrefix<TRecord extends {}, TResult>(
  query: Knex.QueryBuilder<TRecord, TResult>,
  field: 'name' | 'kind',
  prefix: string | undefined,
): void {
  if (prefix === undefined || prefix === '') return;
  // Fold in the database locale, then escape literals. Truncate the raw folded
  // prefix before escaping so the index predicate never splits an escape pair.
  query.whereRaw(
    `lower(??) COLLATE "C" LIKE ${escapeLikeSql('lower(?::text)')} || '%' ESCAPE chr(92)`,
    [field, prefix],
  );
  if (field === 'name') {
    // This index predicate narrows candidates; the full-name recheck above is
    // required for prefixes longer than 128 characters and shared prefixes.
    query.whereRaw(
      `left(lower(name), 128) COLLATE "C" LIKE ${escapeLikeSql('left(lower(?::text), 128)')} || '%' ESCAPE chr(92)`,
      [prefix],
    );
  }
}

type SummaryRow = Partial<
  Pick<
    HistoryEntityRow,
    'id' | 'op' | 'owner' | 'relations' | 'status_items' | 'orphan'
  >
>;

type HistoryTimelineRow = HistoryEntityRow & {
  previous_id?: string | null;
  previous_op?: HistoryOperation | null;
  previous_owner?: string | null;
  previous_relations?: unknown;
  previous_status_items?: unknown;
  previous_orphan?: boolean | null;
};

type CursorPayload = {
  changedAt: string;
  id: string;
};

const MAX_POSTGRES_BIGINT = 9_223_372_036_854_775_807n;

function normalizeLimit(limit: number | undefined): number {
  if (limit === undefined) {
    return DEFAULT_HISTORY_PAGE_LIMIT;
  }
  if (!Number.isFinite(limit) || !Number.isInteger(limit) || limit <= 0) {
    throw new InputError('History page limit must be a positive integer');
  }
  return Math.min(limit, MAX_HISTORY_PAGE_LIMIT);
}

function encodeCursor(row: HistoryChangeRow): string {
  const payload: CursorPayload = {
    changedAt: row.changed_at.toISOString(),
    id: row.id,
  };
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

function decodeCursor(cursor: string | undefined): CursorPayload | undefined {
  if (!cursor) {
    return undefined;
  }
  try {
    const payload = JSON.parse(
      Buffer.from(cursor, 'base64url').toString('utf8'),
    );
    if (
      !payload ||
      typeof payload !== 'object' ||
      typeof payload.changedAt !== 'string' ||
      typeof payload.id !== 'string' ||
      !isPositivePostgresBigint(payload.id) ||
      Number.isNaN(Date.parse(payload.changedAt))
    ) {
      throw new Error('Invalid cursor payload');
    }
    return payload;
  } catch (error) {
    throw new InputError('Invalid history page cursor', error);
  }
}

function isPositivePostgresBigint(value: string): boolean {
  if (!/^[1-9]\d{0,18}$/.test(value)) {
    return false;
  }
  return BigInt(value) <= MAX_POSTGRES_BIGINT;
}

function asJsonObject(value: unknown): HistoryJsonObject | undefined {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as HistoryJsonObject;
  }
  return undefined;
}

function asJsonObjectArray(value: unknown): HistoryJsonObject[] | undefined {
  if (Array.isArray(value)) {
    return value.filter(
      item => item && typeof item === 'object' && !Array.isArray(item),
    ) as HistoryJsonObject[];
  }
  return undefined;
}

function asStringArray(value: unknown): string[] | undefined {
  if (Array.isArray(value)) {
    return value.filter(item => typeof item === 'string');
  }
  return undefined;
}

function rowToSnapshot(row: HistoryEntityRow): HistoryEntitySnapshot {
  return {
    entityRef: row.entity_ref,
    kind: row.kind,
    namespace: row.namespace,
    name: row.name,
    etag: row.etag ?? undefined,
    displayName: row.display_name ?? undefined,
    email: row.email ?? undefined,
    parent: row.parent ?? undefined,
    memberOf: asStringArray(row.member_of),
    ...rowToSummaryFields(row),
    metadata: asJsonObject(row.metadata),
    spec: asJsonObject(row.spec),
  };
}

function rowToSummaryFields(row: SummaryRow) {
  return {
    owner: row.owner ?? undefined,
    relations: asJsonObjectArray(row.relations),
    statusItems: asJsonObjectArray(row.status_items),
    orphan: row.orphan ?? undefined,
  };
}

function rowToSummary(
  row: SummaryRow,
  previous?: SummaryRow,
): HistoryTimelineSummary {
  if (
    row.op !== 'update' ||
    previous?.id === undefined ||
    (previous.op !== 'insert' && previous.op !== 'update')
  ) {
    return {};
  }
  return summarizeSnapshotFields(
    rowToSummaryFields(previous),
    rowToSummaryFields(row),
  );
}

function rowToSummarizedTimelineItem(
  row: HistoryTimelineRow,
): HistoryTimelineItem {
  return {
    ...rowToTimelineItem(row),
    summary: rowToSummary(row, {
      id: row.previous_id ?? undefined,
      op: row.previous_op ?? undefined,
      owner: row.previous_owner,
      relations: row.previous_relations,
      status_items: row.previous_status_items,
      orphan: row.previous_orphan,
    }),
  };
}

function withTimelinePredecessors(
  db: Knex,
  page: Knex.QueryBuilder<HistoryEntityRow, HistoryEntityRow[]>,
): Knex.QueryBuilder<HistoryTimelineRow, HistoryTimelineRow[]> {
  // Select the physical predecessor before considering its operation or payload.
  const previous = db<HistoryEntityRow>('catalog_history_entities as older')
    .select({
      previous_id: 'older.id',
      previous_op: 'older.op',
      previous_owner: 'older.owner',
      previous_relations: 'older.relations',
      previous_status_items: 'older.status_items',
      previous_orphan: 'older.orphan',
    })
    .where('page.op', 'update')
    .whereRaw('?? = ??', ['older.entity_ref', 'page.entity_ref'])
    .whereRaw('?? = ??', ['older.source', 'page.source'])
    .whereRaw('?? = ??', ['older.provider', 'page.provider'])
    .whereRaw('(older.changed_at, older.id) < (page.changed_at, page.id)')
    .orderBy('older.changed_at', 'desc')
    .orderBy('older.id', 'desc')
    .limit(1)
    .toSQL();

  // Page first so predecessor payloads are fetched only for selected events.
  return db<HistoryTimelineRow>(page.as('page'))
    .joinRaw(`LEFT JOIN LATERAL (${previous.sql}) AS previous ON true`, [
      ...previous.bindings,
    ])
    .orderBy('page.changed_at', 'desc')
    .orderBy('page.id', 'desc')
    .select<HistoryTimelineRow[]>('page.*', 'previous.*');
}

function rowToTimelineItem(row: HistoryChangeRow): HistoryTimelineItem {
  return {
    id: row.id,
    cycleId: row.cycle_id,
    entityRef: row.entity_ref,
    source: row.source,
    provider: row.provider,
    op: row.op,
    changedAt: row.changed_at.toISOString(),
    etag: row.etag ?? undefined,
    summary: {},
  };
}

function rowToChange(row: HistoryChangeRow): HistoryCycleChange {
  return {
    ...rowToTimelineItem(row),
    kind: row.kind,
    namespace: row.namespace,
    name: row.name,
  };
}

function rowToVersion(row: HistoryEntityRow): HistoryEntityVersion {
  return {
    ...rowToTimelineItem(row),
    snapshot: row.op === 'delete' ? undefined : rowToSnapshot(row),
  };
}

/**
 * Postgres-backed history query methods.
 *
 * This class is intentionally kept out of the package barrel until the full
 * `HistoryQueryService` contract is implemented across the follow-up query
 * beads.
 */
export class PostgresHistoryQueryService {
  private schemaReady: Promise<void> | undefined;
  private readonly queryTimeoutMs: number;
  private readonly metrics: HistoryStorageMetrics;

  constructor(
    private readonly db: Knex,
    options: { queryTimeoutMs?: number; metrics?: HistoryStorageMetrics } = {},
  ) {
    this.queryTimeoutMs = normalizeQueryTimeoutMs(options.queryTimeoutMs);
    this.metrics = options.metrics ?? createHistoryStorageMetrics();
  }

  async ensureReady(): Promise<void> {
    this.schemaReady ??= ensureSchema(this.db).catch(error => {
      this.schemaReady = undefined;
      throw error;
    });
    await this.schemaReady;
  }

  async getEntityTimeline(
    request: HistoryEntityTimelineRequest,
  ): Promise<HistoryEntityTimelineResponse> {
    await this.ensureReady();

    const limit = normalizeLimit(request.limit);
    this.validateReadRequest(request);
    const rows = await this.read('timeline', db =>
      withTimelinePredecessors(
        db,
        this.applyEntityFilters<HistoryEntityRow>(
          db<HistoryEntityRow>('catalog_history_entities'),
          request,
        )
          .modify(query => this.applyCursor(query, request.cursor))
          .orderBy('changed_at', 'desc')
          .orderBy('id', 'desc')
          .limit(limit + 1)
          .select<HistoryEntityRow[]>('*'),
      ),
    );

    return {
      items: rows.slice(0, limit).map(rowToSummarizedTimelineItem),
      nextCursor:
        rows.length > limit ? encodeCursor(rows[limit - 1]) : undefined,
    };
  }

  async getChangeFeed(
    request: HistoryChangeFeedRequest,
  ): Promise<HistoryChangeFeedResponse> {
    if (request.owner !== undefined) {
      throw new InputError(
        'Owner filtering is not supported by the history change feed',
      );
    }
    await this.ensureReady();
    const limit = normalizeLimit(request.limit);
    this.validateReadRequest(request);
    const cursor = decodeCursor(request.cursor);
    const { rows, anchorRemoved } = await this.read('feed', async db => {
      const query = this.applyChangeFilters(
        db<HistoryEntityRow>('catalog_history_entities'),
        request,
      );
      if (request.entityRef !== undefined) {
        query.where('entity_ref', request.entityRef);
      }
      if (request.kind !== undefined) {
        query.whereRaw('LOWER(??) = LOWER(?)', ['kind', request.kind]);
      }
      if (cursor) {
        // Use the stored timestamp, not its millisecond-rounded cursor value.
        query.whereRaw(
          '(changed_at, id) < (select changed_at, id from catalog_history_entities where id = ?)',
          [cursor.id],
        );
      }
      const page = await query
        .orderBy('changed_at', 'desc')
        .orderBy('id', 'desc')
        .limit(limit + 1)
        .select(
          'id',
          'cycle_id',
          'entity_ref',
          'kind',
          'namespace',
          'name',
          'source',
          'provider',
          'op',
          'changed_at',
          'etag',
        );
      // A removed anchor makes the comparison NULL, which looks like the last
      // page. Only an empty cursor page needs the extra lookup.
      const removed =
        cursor !== undefined &&
        page.length === 0 &&
        (await db('catalog_history_entities')
          .where('id', cursor.id)
          .first('id')) === undefined;
      return { rows: page, anchorRemoved: removed };
    });
    if (anchorRemoved) {
      throw new InputError(
        'History page cursor points at removed history; start again from the first page',
      );
    }
    return {
      items: rows.slice(0, limit).map(rowToChange),
      nextCursor:
        rows.length > limit ? encodeCursor(rows[limit - 1]) : undefined,
    };
  }

  async getProviders(
    request: HistoryProviderSearchRequest,
  ): Promise<HistoryProviderSearchResponse> {
    await this.ensureReady();
    const limit = normalizeLimit(request.limit);
    const scope = providerSearchScope(request);
    this.validateReadRequest({
      changedAfter: request.changedAfter,
      changedBefore: request.changedBefore,
    });
    const lastName = decodeProviderSearchCursor(request.cursor, scope);
    const rows = await this.read('providers', db => {
      // Project only supported filters; extra runtime properties must not turn
      // discovery into an exact-provider or owner-filtered history query.
      const query = this.applyChangeFilters(
        db<HistoryEntityRow>('catalog_history_entities'),
        {
          source: request.source,
          op: request.op,
          changedAfter: request.changedAfter,
          changedBefore: request.changedBefore,
        },
      );
      if (request.entityRef !== undefined) {
        query.where('entity_ref', request.entityRef);
      }
      if (request.kind !== undefined) {
        query.whereRaw('LOWER(??) = LOWER(?)', ['kind', request.kind]);
      }
      // PostgreSQL LOWER uses the server locale, not accent-insensitive or
      // universal Unicode full folding. Measure the folded prefix in SQL.
      query.whereRaw(
        'LEFT(LOWER(provider), char_length(LOWER(?::text))) = LOWER(?::text)',
        [request.prefix ?? '', request.prefix ?? ''],
      );
      if (lastName !== undefined) {
        query.whereRaw('provider COLLATE "C" > ?', [lastName]);
      }
      return query
        .distinct<{ provider: string }[]>(
          db.raw('provider COLLATE "C" AS provider'),
        )
        .orderByRaw('provider COLLATE "C" ASC')
        .limit(limit + 1);
    });
    return {
      items: rows.slice(0, limit).map(row => row.provider),
      nextCursor:
        rows.length > limit
          ? encodeProviderSearchCursor(rows[limit - 1].provider, scope)
          : undefined,
    };
  }

  async listCycles(
    request: HistoryCycleListRequest,
  ): Promise<HistoryCycleListResponse> {
    const limit = normalizeLimit(request.limit);
    const scope = cycleListScope(request);
    const anchor = decodeCycleCursor(request.cursor, 'cycles', scope);
    await this.ensureReady();
    const rows = await this.read('cycles', db => {
      const query = db<HistoryCycleRow>('catalog_history_cycles');
      applyCycleFilters(db, query, request);
      if (anchor)
        query.whereRaw('(started_at, cycle_id) < (?::timestamptz, ?::uuid)', [
          anchor.timestamp,
          anchor.id,
        ]);
      return query
        .select<HistoryCycleRow[]>(
          ...CYCLE_COLUMNS,
          db.raw('started_at::text AS cursor_timestamp'),
        )
        .orderBy('started_at', 'desc')
        .orderBy('cycle_id', 'desc')
        .limit(limit + 1);
    });
    const last = rows[limit - 1];
    return {
      items: rows.slice(0, limit).map(rowToCycle),
      nextCursor:
        rows.length > limit
          ? encodeCycleCursor('cycles', scope, {
              timestamp: last.cursor_timestamp,
              id: last.cycle_id,
            })
          : undefined,
    };
  }

  async getCycle(
    request: HistoryCycleDetailRequest,
  ): Promise<HistoryCycleDetailResponse> {
    const cycleId = normalizeCycleId(request.cycleId);
    const limit = normalizeLimit(request.limit);
    const scope = cycleChangesScope(cycleId);
    const anchor = decodeCycleCursor(request.cursor, 'cycle-changes', scope);
    await this.ensureReady();
    const cycle = await this.read('cycle_detail', async db => {
      const row = await db<HistoryCycleRow>('catalog_history_cycles')
        .select(...CYCLE_COLUMNS)
        .where('cycle_id', cycleId)
        .first();
      if (!row) throw new NotFoundError('History cycle not found');
      return rowToCycle(row);
    });
    const rows = await this.read('cycle_detail', db => {
      const query = db<HistoryChangeRow & { cursor_timestamp: string }>(
        'catalog_history_entities',
      ).where('cycle_id', cycleId);
      if (anchor)
        query.whereRaw('(changed_at, id) < (?::timestamptz, ?::bigint)', [
          anchor.timestamp,
          anchor.id,
        ]);
      return query
        .select<(HistoryChangeRow & { cursor_timestamp: string })[]>(
          'id',
          'cycle_id',
          'entity_ref',
          'kind',
          'namespace',
          'name',
          'provider',
          'source',
          'op',
          'etag',
          'changed_at',
          db.raw('changed_at::text AS cursor_timestamp'),
        )
        .orderBy('changed_at', 'desc')
        .orderBy('id', 'desc')
        .limit(limit + 1);
    });
    const last = rows[limit - 1];
    return {
      cycle,
      changes: {
        items: rows.slice(0, limit).map(rowToChange),
        nextCursor:
          rows.length > limit
            ? encodeCycleCursor('cycle-changes', scope, {
                timestamp: last.cursor_timestamp,
                id: last.id,
              })
            : undefined,
      },
    };
  }

  async getEntities(
    request: HistoryEntitySearchRequest,
  ): Promise<HistoryEntitySearchResponse> {
    await this.ensureReady();
    const limit = normalizeLimit(request.limit);
    const scope = entitySearchScope(request);
    this.validateReadRequest({
      changedAfter: request.changedAfter,
      changedBefore: request.changedBefore,
    });
    const anchor = decodeEntitySearchCursor(request.cursor, scope);
    const rows = await this.read('entities', db => {
      // Project only supported scope: a selected entity or extra owner property
      // must never narrow the available names.
      const matching = this.applyChangeFilters(
        db<HistoryEntityRow>('catalog_history_entities'),
        {
          source: request.source,
          provider: request.provider,
          op: request.op,
          changedAfter: request.changedAfter,
          changedBefore: request.changedBefore,
        },
      );
      if (request.kind !== undefined) {
        matching.whereRaw('LOWER(kind) = LOWER(?)', [request.kind]);
      }
      applyDiscoveryPrefix(matching, 'name', request.prefix);
      // Keep all identity fields from one latest matching observation, including
      // delete-only identities. Native timestamp/ID order retains PG precision.
      const choices = matching
        .select(db.raw('DISTINCT ON (entity_ref COLLATE "C") entity_ref'))
        .select('kind', 'namespace', 'name')
        .select(db.raw('lower(name) AS folded_name'))
        .orderByRaw('entity_ref COLLATE "C", changed_at DESC, id DESC');
      const page = db<EntityDiscoveryRow>(choices.as('choices'));
      if (anchor !== undefined) {
        page.whereRaw(
          '(folded_name COLLATE "C", entity_ref COLLATE "C") > (?::text COLLATE "C", ?::text COLLATE "C")',
          [anchor.foldedName, anchor.entityRef],
        );
      }
      return page
        .select('entity_ref', 'kind', 'namespace', 'name', 'folded_name')
        .orderByRaw('folded_name COLLATE "C", entity_ref COLLATE "C"')
        .limit(limit + 1);
    });
    return {
      items: rows.slice(0, limit).map(row => ({
        entityRef: row.entity_ref,
        kind: row.kind,
        namespace: row.namespace,
        name: row.name,
      })),
      nextCursor:
        rows.length > limit
          ? encodeEntitySearchCursor(
              {
                foldedName: rows[limit - 1].folded_name,
                entityRef: rows[limit - 1].entity_ref,
              },
              scope,
            )
          : undefined,
    };
  }

  async getKinds(
    request: HistoryKindSearchRequest,
  ): Promise<HistoryKindSearchResponse> {
    await this.ensureReady();
    const limit = normalizeLimit(request.limit);
    const scope = kindSearchScope(request);
    const anchor = decodeKindSearchCursor(request.cursor, scope);
    const rows = await this.read('kinds', db => {
      // Kinds describe the entire retained entity history, independent of the
      // current entity-search filters. Preserve one original stored spelling.
      const choices = db<HistoryEntityRow>('catalog_history_entities')
        .select(db.raw('MIN(kind COLLATE "C") AS kind'))
        .select(db.raw('lower(kind) COLLATE "C" AS folded_name'))
        .groupByRaw('lower(kind) COLLATE "C"');
      applyDiscoveryPrefix(choices, 'kind', request.prefix);
      const page = db<KindDiscoveryRow>(choices.as('choices'));
      if (anchor !== undefined) {
        page.whereRaw('folded_name COLLATE "C" > ?::text COLLATE "C"', [
          anchor,
        ]);
      }
      return page
        .select('kind', 'folded_name')
        .orderByRaw('folded_name COLLATE "C"')
        .limit(limit + 1);
    });
    return {
      items: rows.slice(0, limit).map(row => row.kind),
      nextCursor:
        rows.length > limit
          ? encodeKindSearchCursor(rows[limit - 1].folded_name, scope)
          : undefined,
    };
  }

  async getEntityAsOf(
    request: HistoryEntityAsOfRequest,
  ): Promise<HistoryEntityAsOfResponse> {
    await this.ensureReady();
    const asOf = this.validateAsOfRequest(request);
    const rows = await this.read('as_of', db => {
      // Only declared predicates may narrow the latest physical observation.
      const query = db<HistoryEntityRow>('catalog_history_entities')
        .where('entity_ref', request.entityRef)
        .where('changed_at', '<=', asOf);
      if (request.source !== undefined) {
        query.where('source', request.source);
      }
      if (request.provider !== undefined) {
        query.where('provider', request.provider);
      }
      return query
        .orderBy('changed_at', 'desc')
        .orderBy('id', 'desc')
        .limit(1)
        .select<HistoryEntityRow[]>('*');
    });
    if (!rows.length) return { entityRef: request.entityRef, asOf };
    const version = rowToVersion(rows[0]);
    if (version.op === 'delete') {
      return { entityRef: request.entityRef, asOf, version };
    }
    return {
      entityRef: request.entityRef,
      asOf,
      version,
      snapshot: version.snapshot,
    };
  }

  async getEntityVersions(
    request: HistoryEntityVersionsRequest,
  ): Promise<HistoryEntityVersionsResponse> {
    await this.ensureReady();

    const limit = normalizeLimit(request.limit);
    this.validateReadRequest(request);
    const rows = await this.read('versions', db => {
      const distinctVersions = this.applyEntityFilters(
        db<HistoryEntityRow>('catalog_history_entities'),
        request,
      )
        .whereNot('op', 'delete')
        .whereNotNull('etag')
        .distinctOn('source', 'provider', 'etag')
        .orderBy('source')
        .orderBy('provider')
        .orderBy('etag')
        .orderBy('changed_at', 'desc')
        .orderBy('id', 'desc')
        .select('*')
        .as('versions');

      return db<HistoryEntityRow>(distinctVersions)
        .modify(query => this.applyCursor(query, request.cursor))
        .orderBy('changed_at', 'desc')
        .orderBy('id', 'desc')
        .limit(limit + 1)
        .select('*');
    });

    return {
      items: rows.slice(0, limit).map(rowToVersion),
      nextCursor:
        rows.length > limit ? encodeCursor(rows[limit - 1]) : undefined,
    };
  }

  async getEntityVersion(
    request: HistoryEntityVersionRequest,
  ): Promise<HistoryEntityVersionResponse> {
    if (!isPositivePostgresBigint(request.id)) {
      throw new InputError('Invalid history row id');
    }
    await this.ensureReady();
    const { row, previousRow } = await this.read('detail', async db => {
      const currentRow = await db<HistoryEntityRow>('catalog_history_entities')
        .where({ id: request.id, entity_ref: request.entityRef })
        .first();
      if (!currentRow) {
        throw new NotFoundError('History version not found');
      }
      // Compare in Postgres to retain timestamp precision beyond JS milliseconds.
      const previous = await db<HistoryEntityRow>('catalog_history_entities')
        .where({
          entity_ref: currentRow.entity_ref,
          source: currentRow.source,
          provider: currentRow.provider,
        })
        .whereRaw(
          '(changed_at, id) < (select changed_at, id from catalog_history_entities where id = ?)',
          [currentRow.id],
        )
        .orderBy('changed_at', 'desc')
        .orderBy('id', 'desc')
        .first();
      return { row: currentRow, previousRow: previous };
    });
    const version = rowToVersion(row);
    const previousVersion = previousRow ? rowToVersion(previousRow) : undefined;
    return {
      ...version,
      summary: rowToSummary(row, previousRow),
      previousVersion,
      changes:
        previousVersion?.snapshot &&
        (version.snapshot || version.op === 'delete')
          ? diffSnapshots(previousVersion.snapshot, version.snapshot)
          : undefined,
    };
  }

  private read<T>(
    operation: QueryOperation,
    read: (executor: Knex) => PromiseLike<T>,
  ): Promise<T> {
    return this.metrics.query(operation, () =>
      withHistoryQueryTimeout(this.db, this.queryTimeoutMs, read),
    );
  }

  private validateAsOfRequest(request: HistoryEntityAsOfRequest): string {
    if (
      typeof request.entityRef !== 'string' ||
      request.entityRef.length === 0
    ) {
      throw new InputError('History entityRef must be a nonempty string');
    }
    if (
      request.source !== undefined &&
      !HISTORY_SOURCES.includes(request.source)
    ) {
      throw new InputError('Invalid history source');
    }
    if (
      request.provider !== undefined &&
      typeof request.provider !== 'string'
    ) {
      throw new InputError('History provider must be a string');
    }
    if (typeof request.timestamp !== 'string') {
      throw new InputError('Invalid history timestamp');
    }
    return this.parseTimestamp(request.timestamp, 'timestamp');
  }

  private validateReadRequest(
    request: Pick<
      HistoryEntityTimelineRequest,
      'cursor' | 'changedAfter' | 'changedBefore'
    >,
  ): void {
    decodeCursor(request.cursor);
    if (request.changedAfter !== undefined) {
      this.parseTimestamp(request.changedAfter, 'changedAfter');
    }
    if (request.changedBefore !== undefined) {
      this.parseTimestamp(request.changedBefore, 'changedBefore');
    }
  }

  private applyEntityFilters<TRecord extends {}>(
    query: Knex.QueryBuilder<TRecord, HistoryEntityRow[]>,
    request: Pick<
      HistoryEntityTimelineRequest,
      | 'entityRef'
      | 'owner'
      | 'source'
      | 'provider'
      | 'op'
      | 'changedAfter'
      | 'changedBefore'
    >,
  ): Knex.QueryBuilder<TRecord, HistoryEntityRow[]> {
    query.where('entity_ref', request.entityRef);
    if (request.owner !== undefined) {
      query.where('owner', request.owner);
    }
    return this.applyChangeFilters(query, request);
  }

  private applyChangeFilters<TRecord extends {}>(
    query: Knex.QueryBuilder<TRecord, HistoryEntityRow[]>,
    request: Pick<
      HistoryChangeFeedRequest,
      'source' | 'provider' | 'op' | 'changedAfter' | 'changedBefore'
    >,
  ): Knex.QueryBuilder<TRecord, HistoryEntityRow[]> {
    if (request.source) {
      query.where('source', request.source);
    }
    if (request.provider) {
      query.where('provider', request.provider);
    }
    if (request.op) {
      query.where('op', request.op);
    }
    if (request.changedAfter !== undefined) {
      query.where(
        'changed_at',
        '>=',
        this.parseTimestamp(request.changedAfter, 'changedAfter'),
      );
    }
    if (request.changedBefore !== undefined) {
      query.where(
        'changed_at',
        '<=',
        this.parseTimestamp(request.changedBefore, 'changedBefore'),
      );
    }
    return query;
  }

  private parseTimestamp(
    timestamp: string,
    field: 'changedAfter' | 'changedBefore' | 'timestamp',
  ): string {
    const parsed = new Date(timestamp);
    if (!ISO_8601_INSTANT.test(timestamp) || Number.isNaN(parsed.getTime())) {
      const label = field === 'timestamp' ? 'timestamp' : `${field} timestamp`;
      throw new InputError(`Invalid history ${label}`);
    }
    return timestamp;
  }

  private applyCursor<TRecord extends {}>(
    query: Knex.QueryBuilder<TRecord, HistoryEntityRow[]>,
    cursor: string | undefined,
  ): void {
    const decoded = decodeCursor(cursor);
    if (!decoded) {
      return;
    }
    query.andWhere(builder => {
      builder.where('changed_at', '<', decoded.changedAt).orWhere(inner => {
        inner
          .where('changed_at', decoded.changedAt)
          .andWhere('id', '<', decoded.id);
      });
    });
  }
}
