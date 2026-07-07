import { Buffer } from 'node:buffer';
import { InputError } from '@backstage/errors';
import { Knex } from 'knex';
import {
  DEFAULT_HISTORY_PAGE_LIMIT,
  MAX_HISTORY_PAGE_LIMIT,
} from '@kunickiaj/catalog-history-common';
import type {
  HistoryEntitySnapshot,
  HistoryEntityTimelineRequest,
  HistoryEntityTimelineResponse,
  HistoryTimelineItem,
  HistoryEntityVersion,
  HistoryEntityVersionsRequest,
  HistoryEntityVersionsResponse,
  HistoryJsonObject,
  HistoryOperation,
  HistorySource,
} from '@kunickiaj/catalog-history-common';
import { ensureSchema } from './ensureSchema';

type HistoryEntityRow = {
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
  changed_at: Date;
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

function encodeCursor(row: HistoryEntityRow): string {
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
  if (!/^[1-9]\d*$/.test(value)) {
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

function rowToTimelineItem(row: HistoryEntityRow): HistoryTimelineItem {
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

function rowToVersion(row: HistoryEntityRow): HistoryEntityVersion {
  return {
    ...rowToTimelineItem(row),
    snapshot: rowToSnapshot(row),
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

  constructor(private readonly db: Knex) {}

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
    const rows = await this.applyEntityFilters(
      this.db<HistoryEntityRow>('catalog_history_entities'),
      request,
    )
      .modify(query => this.applyCursor(query, request.cursor))
      .orderBy('changed_at', 'desc')
      .orderBy('id', 'desc')
      .limit(limit + 1)
      .select('*');

    return {
      items: rows.slice(0, limit).map(rowToTimelineItem),
      nextCursor:
        rows.length > limit ? encodeCursor(rows[limit - 1]) : undefined,
    };
  }

  async getEntityVersions(
    request: HistoryEntityVersionsRequest,
  ): Promise<HistoryEntityVersionsResponse> {
    await this.ensureReady();

    const limit = normalizeLimit(request.limit);
    const distinctVersions = this.applyEntityFilters(
      this.db<HistoryEntityRow>('catalog_history_entities'),
      request,
    )
      .whereNot('op', 'delete')
      .whereNotNull('etag')
      .distinctOn('etag')
      .orderBy('etag')
      .orderBy('changed_at', 'desc')
      .orderBy('id', 'desc')
      .select('*')
      .as('versions');

    const rows = await this.db<HistoryEntityRow>(distinctVersions)
      .modify(query => this.applyCursor(query, request.cursor))
      .orderBy('changed_at', 'desc')
      .orderBy('id', 'desc')
      .limit(limit + 1)
      .select('*');

    return {
      items: rows.slice(0, limit).map(rowToVersion),
      nextCursor:
        rows.length > limit ? encodeCursor(rows[limit - 1]) : undefined,
    };
  }

  private applyEntityFilters<TRecord extends {}>(
    query: Knex.QueryBuilder<TRecord, HistoryEntityRow[]>,
    request: Pick<
      HistoryEntityTimelineRequest,
      | 'entityRef'
      | 'source'
      | 'provider'
      | 'op'
      | 'changedAfter'
      | 'changedBefore'
    >,
  ): Knex.QueryBuilder<TRecord, HistoryEntityRow[]> {
    query.where('entity_ref', request.entityRef);
    if (request.source) {
      query.where('source', request.source);
    }
    if (request.provider) {
      query.where('provider', request.provider);
    }
    if (request.op) {
      query.where('op', request.op);
    }
    if (request.changedAfter) {
      query.where('changed_at', '>=', request.changedAfter);
    }
    if (request.changedBefore) {
      query.where('changed_at', '<=', request.changedBefore);
    }
    return query;
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
