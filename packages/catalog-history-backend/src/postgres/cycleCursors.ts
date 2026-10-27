import { InputError } from '@backstage/errors';
import {
  compareHistoryInstants,
  isHistoryInstant,
  isHistoryMutationType,
  isHistoryOperation,
  isHistorySource,
} from '@kunickiaj/backstage-plugin-catalog-history-common';
import type { HistoryCycleListRequest } from '@kunickiaj/backstage-plugin-catalog-history-common';
import {
  cursorScope,
  decodeOpaqueCursor,
  encodeOpaqueCursor,
} from './opaqueCursor';

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
  return cursorScope({
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
  return cursorScope({ sort: 'changed-at/bigint-desc-v1', cycleId });
}

export function encodeCycleCursor(
  route: Route,
  queryScope: string,
  anchor: CycleAnchor,
): string {
  return encodeOpaqueCursor(route, queryScope, anchor);
}

export function decodeCycleCursor(
  cursor: string | undefined,
  route: Route,
  queryScope: string,
): CycleAnchor | undefined {
  if (cursor === undefined) return undefined;
  const anchor = decodeOpaqueCursor(cursor, {
    tag: route,
    scope: queryScope,
    fields: ['timestamp', 'id'],
    label: route,
  });
  if (!isCycleAnchor(route, anchor)) {
    throw new InputError(`Invalid history ${route} cursor`);
  }
  return anchor;
}

// Validate the database text shape before passing it back to PostgreSQL.
function isCycleAnchor(route: Route, { timestamp, id }: CycleAnchor): boolean {
  if (
    !POSTGRES_INSTANT.test(timestamp) ||
    !isHistoryInstant(
      timestamp.replace(' ', 'T').replace(/([+-]\d{2})$/, '$1:00'),
    )
  ) {
    return false;
  }
  if (route === 'cycles') {
    return UUID.test(id) && id === id.toLowerCase();
  }
  return /^[1-9]\d{0,18}$/.test(id) && BigInt(id) <= 9_223_372_036_854_775_807n;
}
