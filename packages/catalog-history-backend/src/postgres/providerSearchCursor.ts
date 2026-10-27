import { InputError } from '@backstage/errors';
import {
  isHistoryOperation,
  isHistorySource,
} from '@kunickiaj/backstage-plugin-catalog-history-common';
import type { HistoryProviderSearchRequest } from '@kunickiaj/backstage-plugin-catalog-history-common';
import {
  cursorScope,
  decodeOpaqueCursor,
  encodeOpaqueCursor,
} from './opaqueCursor';

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
  return cursorScope({
    prefix: request.prefix ?? '',
    source: request.source ?? null,
    entityRef: request.entityRef ?? null,
    kind: request.kind ?? null,
    op: request.op ?? null,
    changedAfter: request.changedAfter ?? null,
    changedBefore: request.changedBefore ?? null,
  });
}

export function encodeProviderSearchCursor(
  lastName: string,
  scope: string,
): string {
  return encodeOpaqueCursor('provider-search', scope, { lastName });
}

export function decodeProviderSearchCursor(
  cursor: string | undefined,
  scope: string,
): string | undefined {
  if (cursor === undefined) return undefined;
  return decodeOpaqueCursor(cursor, {
    tag: 'provider-search',
    scope,
    fields: ['lastName'],
    label: 'provider search',
  }).lastName;
}
