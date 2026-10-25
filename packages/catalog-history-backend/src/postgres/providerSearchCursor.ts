import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { InputError } from '@backstage/errors';
import {
  isHistoryOperation,
  isHistorySource,
} from '@kunickiaj/backstage-plugin-catalog-history-common';
import type { HistoryProviderSearchRequest } from '@kunickiaj/backstage-plugin-catalog-history-common';

export function providerSearchScope(
  request: HistoryProviderSearchRequest,
): string {
  if (request.prefix !== undefined && typeof request.prefix !== 'string') {
    throw new InputError('History provider prefix must be a string');
  }
  for (const field of [
    'entityRef',
    'kind',
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
  // Keep raw timestamp precision and original prefix spelling. Page size is
  // deliberately excluded so callers can change it between requests.
  return createHash('sha256')
    .update(
      JSON.stringify({
        prefix: request.prefix ?? '',
        source: request.source ?? null,
        entityRef: request.entityRef ?? null,
        kind: request.kind ?? null,
        op: request.op ?? null,
        changedAfter: request.changedAfter ?? null,
        changedBefore: request.changedBefore ?? null,
      }),
    )
    .digest('hex');
}

export function encodeProviderSearchCursor(
  lastName: string,
  scope: string,
): string {
  return Buffer.from(
    JSON.stringify({ tag: 'provider-search', version: 1, lastName, scope }),
    'utf8',
  ).toString('base64url');
}

export function decodeProviderSearchCursor(
  cursor: string | undefined,
  scope: string,
): string | undefined {
  if (cursor === undefined) return undefined;
  try {
    if (typeof cursor !== 'string' || !/^[A-Za-z0-9_-]+$/.test(cursor)) {
      throw new Error();
    }
    const bytes = Buffer.from(cursor, 'base64url');
    if (bytes.toString('base64url') !== cursor) throw new Error();
    const payload: unknown = JSON.parse(bytes.toString('utf8'));
    if (
      !payload ||
      typeof payload !== 'object' ||
      !('tag' in payload) ||
      payload.tag !== 'provider-search' ||
      !('version' in payload) ||
      payload.version !== 1 ||
      !('lastName' in payload) ||
      typeof payload.lastName !== 'string' ||
      !('scope' in payload) ||
      payload.scope !== scope
    ) {
      throw new Error();
    }
    return payload.lastName;
  } catch {
    // Do not attach parser errors: they may contain cursor payload values.
    throw new InputError('Invalid history provider search cursor');
  }
}
