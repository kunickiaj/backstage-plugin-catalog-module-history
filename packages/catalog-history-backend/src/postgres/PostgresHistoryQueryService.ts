import { Buffer } from 'node:buffer';
import { InputError, NotFoundError } from '@backstage/errors';
import { Knex } from 'knex';
import {
  DEFAULT_HISTORY_PAGE_LIMIT,
  MAX_HISTORY_PAGE_LIMIT,
} from '@kunickiaj/backstage-plugin-catalog-history-common';
import type {
  HistoryChangeFeedRequest,
  HistoryChangeFeedResponse,
  HistoryCycleChange,
  HistoryEntitySnapshot,
  HistoryEntityTimelineRequest,
  HistoryEntityTimelineResponse,
  HistoryTimelineItem,
  HistoryEntityVersion,
  HistoryEntityVersionRequest,
  HistoryEntityVersionResponse,
  HistoryEntityVersionsRequest,
  HistoryEntityVersionsResponse,
  HistoryJsonObject,
  HistoryOperation,
  HistorySource,
} from '@kunickiaj/backstage-plugin-catalog-history-common';
import { ensureSchema } from './ensureSchema';
import { diffSnapshots } from './diffSnapshots';
import {
  normalizeQueryTimeoutMs,
  withHistoryQueryTimeout,
} from './historyQueryTimeout';

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
    owner: row.owner ?? undefined,
    metadata: asJsonObject(row.metadata),
    spec: asJsonObject(row.spec),
    relations: asJsonObjectArray(row.relations),
    statusItems: asJsonObjectArray(row.status_items),
    orphan: row.orphan ?? undefined,
  };
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

  constructor(
    private readonly db: Knex,
    options: { queryTimeoutMs?: number } = {},
  ) {
    this.queryTimeoutMs = normalizeQueryTimeoutMs(options.queryTimeoutMs);
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
    const rows = await this.read(db =>
      this.applyEntityFilters(
        db<HistoryEntityRow>('catalog_history_entities'),
        request,
      )
        .modify(query => this.applyCursor(query, request.cursor))
        .orderBy('changed_at', 'desc')
        .orderBy('id', 'desc')
        .limit(limit + 1)
        .select('*'),
    );

    return {
      items: rows.slice(0, limit).map(rowToTimelineItem),
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
    const rows = await this.read(db => {
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
      const cursor = decodeCursor(request.cursor);
      if (cursor) {
        // Use the stored timestamp, not its millisecond-rounded cursor value.
        query.whereRaw(
          '(changed_at, id) < (select changed_at, id from catalog_history_entities where id = ?)',
          [cursor.id],
        );
      }
      return query
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
    });
    return {
      items: rows.slice(0, limit).map(rowToChange),
      nextCursor:
        rows.length > limit ? encodeCursor(rows[limit - 1]) : undefined,
    };
  }

  async getEntityVersions(
    request: HistoryEntityVersionsRequest,
  ): Promise<HistoryEntityVersionsResponse> {
    await this.ensureReady();

    const limit = normalizeLimit(request.limit);
    this.validateReadRequest(request);
    const rows = await this.read(db => {
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
    const { row, previousRow } = await this.read(async db => {
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
      previousVersion,
      changes:
        previousVersion?.snapshot &&
        (version.snapshot || version.op === 'delete')
          ? diffSnapshots(previousVersion.snapshot, version.snapshot)
          : undefined,
    };
  }

  private read<T>(read: (executor: Knex) => PromiseLike<T>): Promise<T> {
    return withHistoryQueryTimeout(this.db, this.queryTimeoutMs, read);
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
    field: 'changedAfter' | 'changedBefore',
  ): string {
    const parsed = new Date(timestamp);
    if (!ISO_8601_INSTANT.test(timestamp) || Number.isNaN(parsed.getTime())) {
      throw new InputError(`Invalid history ${field} timestamp`);
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
