import { InputError } from '@backstage/errors';
import {
  isHistoryOperation,
  isHistorySource,
} from '@kunickiaj/backstage-plugin-catalog-history-common';
import type {
  HistoryEntitySearchRequest,
  HistoryKindSearchRequest,
} from '@kunickiaj/backstage-plugin-catalog-history-common';
import {
  cursorScope,
  decodeOpaqueCursor,
  encodeOpaqueCursor,
} from './opaqueCursor';

export type EntitySearchAnchor = { foldedName: string; entityRef: string };

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
  return cursorScope({
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
  return cursorScope({
    sort: 'folded-kind-C-v1',
    prefix: request.prefix ?? '',
  });
}

export function encodeEntitySearchCursor(
  anchor: EntitySearchAnchor,
  queryScope: string,
): string {
  return encodeOpaqueCursor('entity-search', queryScope, anchor);
}

export function decodeEntitySearchCursor(
  cursor: string | undefined,
  queryScope: string,
): EntitySearchAnchor | undefined {
  if (cursor === undefined) return undefined;
  return decodeOpaqueCursor(cursor, {
    tag: 'entity-search',
    scope: queryScope,
    fields: ['foldedName', 'entityRef'],
    label: 'entity-search',
  });
}

export function encodeKindSearchCursor(
  foldedName: string,
  queryScope: string,
): string {
  return encodeOpaqueCursor('kind-search', queryScope, { foldedName });
}

export function decodeKindSearchCursor(
  cursor: string | undefined,
  queryScope: string,
): string | undefined {
  if (cursor === undefined) return undefined;
  return decodeOpaqueCursor(cursor, {
    tag: 'kind-search',
    scope: queryScope,
    fields: ['foldedName'],
    label: 'kind-search',
  }).foldedName;
}
