import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { InputError } from '@backstage/errors';
import {
  isHistoryOperation,
  isHistorySource,
} from '@kunickiaj/backstage-plugin-catalog-history-common';
import type {
  HistoryEntitySearchRequest,
  HistoryKindSearchRequest,
} from '@kunickiaj/backstage-plugin-catalog-history-common';

type Route = 'entity-search' | 'kind-search';
export type EntitySearchAnchor = { foldedName: string; entityRef: string };

function scope(value: object): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function validatePrefix(prefix: unknown): void {
  if (prefix !== undefined && typeof prefix !== 'string') {
    throw new InputError('History discovery prefix must be a string');
  }
}

export function entitySearchScope(request: HistoryEntitySearchRequest): string {
  validatePrefix(request.prefix);
  for (const field of [
    'kind',
    'provider',
    'changedAfter',
    'changedBefore',
  ] as const) {
    if (
      request[field] !== undefined &&
      (typeof request[field] !== 'string' || request[field].length === 0)
    ) {
      throw new InputError(`Invalid history ${field}`);
    }
  }
  if (request.source !== undefined && !isHistorySource(request.source)) {
    throw new InputError('Invalid history source');
  }
  if (request.op !== undefined && !isHistoryOperation(request.op)) {
    throw new InputError('Invalid history operation');
  }
  // Retain raw timestamps and prefix spelling, but allow page-size changes.
  return scope({
    sort: 'folded-name-C/entity-ref-C-v1',
    prefix: request.prefix ?? '',
    kind: request.kind ?? null,
    source: request.source ?? null,
    provider: request.provider ?? null,
    op: request.op ?? null,
    changedAfter: request.changedAfter ?? null,
    changedBefore: request.changedBefore ?? null,
  });
}

export function kindSearchScope(request: HistoryKindSearchRequest): string {
  validatePrefix(request.prefix);
  return scope({ sort: 'folded-kind-C-v1', prefix: request.prefix ?? '' });
}

function encode(route: Route, queryScope: string, anchor: object): string {
  return Buffer.from(
    JSON.stringify({ tag: route, version: 1, scope: queryScope, ...anchor }),
    'utf8',
  ).toString('base64url');
}

function decode(
  cursor: string,
  queryScope: string,
  route: Route,
): Record<string, unknown> {
  try {
    if (typeof cursor !== 'string' || !/^[A-Za-z0-9_-]+$/.test(cursor)) {
      throw new Error();
    }
    const bytes = Buffer.from(cursor, 'base64url');
    if (bytes.toString('base64url') !== cursor) throw new Error();
    const payload = JSON.parse(bytes.toString('utf8'));
    if (
      !payload ||
      typeof payload !== 'object' ||
      Array.isArray(payload) ||
      payload.tag !== route ||
      payload.version !== 1 ||
      payload.scope !== queryScope ||
      typeof payload.foldedName !== 'string' ||
      Object.keys(payload).length !== (route === 'entity-search' ? 5 : 4) ||
      (route === 'entity-search' && typeof payload.entityRef !== 'string')
    ) {
      throw new Error();
    }
    return payload;
  } catch {
    // Parser errors may contain cursor values; do not attach them.
    throw new InputError(`Invalid history ${route} cursor`);
  }
}

export function encodeEntitySearchCursor(
  anchor: EntitySearchAnchor,
  queryScope: string,
): string {
  return encode('entity-search', queryScope, anchor);
}

export function decodeEntitySearchCursor(
  cursor: string | undefined,
  queryScope: string,
): EntitySearchAnchor | undefined {
  if (cursor === undefined) return undefined;
  const payload = decode(cursor, queryScope, 'entity-search');
  return {
    foldedName: payload.foldedName as string,
    entityRef: payload.entityRef as string,
  };
}

export function encodeKindSearchCursor(
  foldedName: string,
  queryScope: string,
): string {
  return encode('kind-search', queryScope, { foldedName });
}

export function decodeKindSearchCursor(
  cursor: string | undefined,
  queryScope: string,
): string | undefined {
  if (cursor === undefined) return undefined;
  return decode(cursor, queryScope, 'kind-search').foldedName as string;
}
