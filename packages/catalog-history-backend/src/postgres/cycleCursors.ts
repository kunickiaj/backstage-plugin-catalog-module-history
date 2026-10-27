import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { InputError } from '@backstage/errors';
import {
  compareHistoryInstants,
  isHistoryInstant,
  isHistoryMutationType,
  isHistoryOperation,
  isHistorySource,
} from '@kunickiaj/backstage-plugin-catalog-history-common';
import type { HistoryCycleListRequest } from '@kunickiaj/backstage-plugin-catalog-history-common';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const POSTGRES_INSTANT =
  /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d{1,6})?[+-]\d{2}(?::\d{2})?$/;
type Route = 'cycles' | 'cycle-changes';
export type CycleAnchor = { timestamp: string; id: string };

export function normalizeCycleId(value: unknown): string {
  if (typeof value !== 'string' || !UUID.test(value)) {
    throw new InputError('Invalid history cycle id');
  }
  return value.toLowerCase();
}

function validateTimestamp(value: unknown, field: string): string {
  if (!isHistoryInstant(value)) {
    throw new InputError(`Invalid history ${field} timestamp`);
  }
  return value;
}

function after(left: string, right: string): boolean {
  return compareHistoryInstants(left, right) > 0;
}

function scope(value: object): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

export function cycleListScope(request: HistoryCycleListRequest): string {
  if (request.source !== undefined && !isHistorySource(request.source))
    throw new InputError('Invalid history source');
  if (request.op !== undefined && !isHistoryOperation(request.op))
    throw new InputError('Invalid history operation');
  if (
    request.mutationType !== undefined &&
    !isHistoryMutationType(request.mutationType)
  )
    throw new InputError('Invalid history mutation type');
  if (request.provider !== undefined && typeof request.provider !== 'string')
    throw new InputError('Invalid history provider');
  for (const prefix of ['started', 'finished'] as const) {
    const lower = request[`${prefix}After`];
    const upper = request[`${prefix}Before`];
    if (lower !== undefined) validateTimestamp(lower, `${prefix}After`);
    if (upper !== undefined) validateTimestamp(upper, `${prefix}Before`);
    if (lower !== undefined && upper !== undefined && after(lower, upper))
      throw new InputError(
        `History ${prefix}After must not exceed ${prefix}Before`,
      );
  }
  return scope({
    sort: 'started-at/uuid-desc-v1',
    source: request.source ?? null,
    provider: request.provider ?? null,
    op: request.op ?? null,
    mutationType: request.mutationType ?? null,
    startedAfter: request.startedAfter ?? null,
    startedBefore: request.startedBefore ?? null,
    finishedAfter: request.finishedAfter ?? null,
    finishedBefore: request.finishedBefore ?? null,
  });
}

export function cycleChangesScope(cycleId: string): string {
  return scope({ sort: 'changed-at/bigint-desc-v1', cycleId });
}

export function encodeCycleCursor(
  route: Route,
  queryScope: string,
  anchor: CycleAnchor,
): string {
  return Buffer.from(
    JSON.stringify({ tag: route, version: 1, scope: queryScope, ...anchor }),
    'utf8',
  ).toString('base64url');
}

export function decodeCycleCursor(
  cursor: string | undefined,
  route: Route,
  queryScope: string,
): CycleAnchor | undefined {
  if (cursor === undefined) return undefined;
  try {
    if (typeof cursor !== 'string' || !/^[A-Za-z0-9_-]+$/.test(cursor))
      throw new Error();
    const bytes = Buffer.from(cursor, 'base64url');
    if (bytes.toString('base64url') !== cursor) throw new Error();
    const payload = JSON.parse(bytes.toString('utf8'));
    if (
      !payload ||
      typeof payload !== 'object' ||
      Array.isArray(payload) ||
      Object.keys(payload).length !== 5 ||
      payload.tag !== route ||
      payload.version !== 1 ||
      payload.scope !== queryScope ||
      typeof payload.timestamp !== 'string' ||
      !POSTGRES_INSTANT.test(payload.timestamp) ||
      typeof payload.id !== 'string'
    )
      throw new Error();
    // Validate the database text shape before passing it back to PostgreSQL.
    validateTimestamp(
      payload.timestamp.replace(' ', 'T').replace(/([+-]\d{2})$/, '$1:00'),
      'cursor',
    );
    if (route === 'cycles') {
      if (!UUID.test(payload.id) || payload.id !== payload.id.toLowerCase())
        throw new Error();
    } else if (
      !/^[1-9]\d{0,18}$/.test(payload.id) ||
      BigInt(payload.id) > 9_223_372_036_854_775_807n
    )
      throw new Error();
    return { timestamp: payload.timestamp, id: payload.id };
  } catch {
    // Parser causes can contain cursor contents; never expose them.
    throw new InputError(`Invalid history ${route} cursor`);
  }
}
