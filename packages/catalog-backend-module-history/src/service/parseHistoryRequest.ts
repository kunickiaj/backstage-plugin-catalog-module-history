import {
  makeValidator,
  parseEntityRef,
  stringifyEntityRef,
} from '@backstage/catalog-model';
import { InputError } from '@backstage/errors';
import type { Request } from 'express';
import {
  DEFAULT_HISTORY_PAGE_LIMIT,
  MAX_HISTORY_PAGE_LIMIT,
  compareHistoryInstants,
  isHistoryInstant,
  isHistoryMutationType,
  isHistoryOperation,
  isHistorySource,
  type HistoryChangeFeedRequest,
  type HistoryCycleDetailRequest,
  type HistoryCycleListRequest,
  type HistoryDiffTarget,
  type HistoryEntityAsOfRequest,
  type HistoryEntityDiffRequest,
  type HistoryEntitySearchRequest,
  type HistoryEntityTimelineRequest,
  type HistoryEntityVersionRequest,
  type HistoryKindSearchRequest,
  type HistoryProviderSearchRequest,
} from '@kunickiaj/backstage-plugin-catalog-history-common';

const validators = makeValidator();
const PAGE_KEYS = ['limit', 'cursor'];
const CHANGE_KEYS = ['source', 'provider', 'changedAfter', 'changedBefore'];

/** Query parameters each endpoint accepts. Anything else is rejected. */
const ENDPOINT_KEYS = {
  history: [...CHANGE_KEYS, 'op', ...PAGE_KEYS],
  versions: [...CHANGE_KEYS, ...PAGE_KEYS],
  'as-of': ['timestamp', 'source', 'provider'],
  version: [],
  changes: [...CHANGE_KEYS, 'op', 'entityRef', 'kind', ...PAGE_KEYS],
  providers: [
    'prefix',
    'source',
    'entityRef',
    'kind',
    'op',
    'changedAfter',
    'changedBefore',
    ...PAGE_KEYS,
  ],
  entities: ['prefix', 'kind', ...CHANGE_KEYS, 'op', ...PAGE_KEYS],
  kinds: ['prefix', ...PAGE_KEYS],
  cycles: [
    'source',
    'provider',
    'op',
    'mutationType',
    'startedAfter',
    'startedBefore',
    'finishedAfter',
    'finishedBefore',
    ...PAGE_KEYS,
  ],
  cycle: PAGE_KEYS,
  diff: ['from', 'to'],
} satisfies Record<string, readonly string[]>;

type Endpoint = keyof typeof ENDPOINT_KEYS;

/** Discovery endpoints accept an empty prefix, meaning "everything". */
const EMPTY_PREFIX_ENDPOINTS = new Set<Endpoint>([
  'providers',
  'entities',
  'kinds',
]);

function timestamp(value: string | undefined): string | undefined {
  if (value !== undefined && !isHistoryInstant(value)) {
    throw new InputError('Invalid history timestamp');
  }
  return value;
}

function pageLimit(value: string | undefined): number {
  if (value === undefined) {
    return DEFAULT_HISTORY_PAGE_LIMIT;
  }
  if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value))) {
    throw new InputError('History limit must be a positive integer');
  }
  return Math.min(Number(value), MAX_HISTORY_PAGE_LIMIT);
}

function queryValues(req: Request, endpoint: Endpoint) {
  const allowed = new Set<string>(ENDPOINT_KEYS[endpoint]);
  const values: Record<string, string> = {};
  // Parse the raw query so repeated keys are rejected independently of the
  // host application's Express query parser configuration.
  const queryStart = req.originalUrl.indexOf('?');
  const query = new URLSearchParams(
    queryStart === -1 ? '' : req.originalUrl.slice(queryStart + 1),
  );
  for (const [key, value] of query) {
    const emptyPrefix =
      key === 'prefix' && EMPTY_PREFIX_ENDPOINTS.has(endpoint);
    if (
      !allowed.has(key) ||
      Object.hasOwn(values, key) ||
      (!value && !emptyPrefix)
    ) {
      throw new InputError(
        'Unknown, repeated, or empty history query parameter',
      );
    }
    values[key] = value;
  }
  return values;
}

function entityRef(req: Request): string {
  const { kind, namespace, name } = req.params;
  return validatedEntityRef({ kind, namespace, name });
}

function validatedEntityRef(ref: {
  kind: string;
  namespace: string;
  name: string;
}): string {
  const { kind, namespace, name } = ref;
  if (
    !validators.isValidKind(kind) ||
    !validators.isValidNamespace(namespace.toLowerCase()) ||
    !validators.isValidEntityName(name)
  ) {
    throw new InputError('Invalid history entity reference');
  }
  return stringifyEntityRef({ kind, namespace, name });
}

/** Parses an optional entity reference filter, defaulting kind and namespace. */
function optionalEntityRef(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  try {
    return validatedEntityRef(
      parseEntityRef(value, {
        defaultKind: 'Component',
        defaultNamespace: 'default',
      }),
    );
  } catch {
    throw new InputError('Invalid history entity reference');
  }
}

function optionalKind(value: string | undefined): void {
  if (value !== undefined && !validators.isValidKind(value)) {
    throw new InputError('Invalid history entity kind');
  }
}

export function parseHistoryEntityAsOfRequest(
  req: Request,
): HistoryEntityAsOfRequest {
  const ref = entityRef(req);
  const values = queryValues(req, 'as-of');
  const cutoff = timestamp(values.timestamp);
  if (cutoff === undefined) {
    throw new InputError('History timestamp is required');
  }
  const { source } = values;
  if (source !== undefined && !isHistorySource(source)) {
    throw new InputError('Invalid history source');
  }
  return {
    entityRef: ref,
    timestamp: cutoff,
    source,
    provider: values.provider,
  };
}

function rowId(id: string): string {
  if (!/^[1-9]\d{0,18}$/.test(id) || BigInt(id) > 9_223_372_036_854_775_807n) {
    throw new InputError('Invalid history row id');
  }
  return id;
}

export function parseHistoryVersionRequest(
  req: Request,
): HistoryEntityVersionRequest {
  queryValues(req, 'version');
  const id = rowId(req.params.id);
  return { entityRef: entityRef(req), id };
}

// Targets are `row:<id>`, which leaves room for other target kinds later.
function diffTarget(value: string | undefined): HistoryDiffTarget {
  if (value === undefined) {
    throw new InputError('History diff requires from and to targets');
  }
  if (!value.startsWith('row:')) {
    throw new InputError('Invalid history diff target; use row:<id>');
  }
  return { kind: 'history-row', id: rowId(value.slice('row:'.length)) };
}

export function parseHistoryDiffRequest(
  req: Request,
): HistoryEntityDiffRequest {
  const ref = entityRef(req);
  const values = queryValues(req, 'diff');
  const from = diffTarget(values.from);
  const to = diffTarget(values.to);
  if (from.id === to.id) {
    throw new InputError('History diff targets must be different rows');
  }
  return { entityRef: ref, from, to };
}

export function parseHistoryRequest(
  req: Request,
  endpoint: 'history' | 'versions',
): HistoryEntityTimelineRequest {
  const ref = entityRef(req);
  const values = queryValues(req, endpoint);
  return { entityRef: ref, ...changeFilters(values) };
}

export function parseHistoryChangeFeedRequest(
  req: Request,
): HistoryChangeFeedRequest {
  const values = queryValues(req, 'changes');
  optionalKind(values.kind);
  const ref = optionalEntityRef(values.entityRef);
  return {
    ...changeFilters(values),
    entityRef: ref,
    kind: values.kind,
  };
}

export function parseHistoryProviderSearchRequest(
  req: Request,
): HistoryProviderSearchRequest {
  const values = queryValues(req, 'providers');
  optionalKind(values.kind);
  const ref = optionalEntityRef(values.entityRef);
  const { source, op, changedAfter, changedBefore, limit, cursor } =
    changeFilters(values);
  return {
    prefix: values.prefix,
    source,
    entityRef: ref,
    kind: values.kind,
    op,
    changedAfter,
    changedBefore,
    limit,
    cursor,
  };
}

export function parseHistoryEntitySearchRequest(
  req: Request,
): HistoryEntitySearchRequest {
  const values = queryValues(req, 'entities');
  optionalKind(values.kind);
  return {
    ...changeFilters(values),
    prefix: values.prefix,
    kind: values.kind,
  };
}

export function parseHistoryKindSearchRequest(
  req: Request,
): HistoryKindSearchRequest {
  const values = queryValues(req, 'kinds');
  return {
    prefix: values.prefix,
    limit: pageLimit(values.limit),
    cursor: values.cursor,
  };
}

export function parseHistoryCycleListRequest(
  req: Request,
): HistoryCycleListRequest {
  const values = queryValues(req, 'cycles');
  const { source, op, mutationType } = values;
  if (source !== undefined && !isHistorySource(source)) {
    throw new InputError('Invalid history source');
  }
  if (op !== undefined && !isHistoryOperation(op)) {
    throw new InputError('Invalid history operation');
  }
  if (mutationType !== undefined && !isHistoryMutationType(mutationType)) {
    throw new InputError('Invalid history mutation type');
  }
  const [startedAfter, startedBefore] = timestampRange(values, 'started');
  const [finishedAfter, finishedBefore] = timestampRange(values, 'finished');
  return {
    source,
    provider: values.provider,
    op,
    mutationType,
    startedAfter,
    startedBefore,
    finishedAfter,
    finishedBefore,
    limit: pageLimit(values.limit),
    cursor: values.cursor,
  };
}

export function parseHistoryCycleDetailRequest(
  req: Request,
): HistoryCycleDetailRequest {
  const values = queryValues(req, 'cycle');
  const { cycleId } = req.params;
  if (
    typeof cycleId !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      cycleId,
    )
  ) {
    throw new InputError('Invalid history cycle id');
  }
  return {
    cycleId: cycleId.toLowerCase(),
    limit: pageLimit(values.limit),
    cursor: values.cursor,
  };
}

function timestampRange(
  values: Record<string, string>,
  prefix: 'started' | 'finished',
): [string | undefined, string | undefined] {
  const after = timestamp(values[`${prefix}After`]);
  const before = timestamp(values[`${prefix}Before`]);
  if (after && before && compareHistoryInstants(after, before) > 0) {
    throw new InputError(
      `${prefix}After must not be later than ${prefix}Before`,
    );
  }
  return [after, before];
}

function changeFilters(values: Record<string, string>) {
  const { source, op } = values;
  if (source !== undefined && !isHistorySource(source)) {
    throw new InputError('Invalid history source');
  }
  if (op !== undefined && !isHistoryOperation(op)) {
    throw new InputError('Invalid history operation');
  }
  const changedAfter = timestamp(values.changedAfter);
  const changedBefore = timestamp(values.changedBefore);
  if (
    changedAfter &&
    changedBefore &&
    compareHistoryInstants(changedAfter, changedBefore) > 0
  ) {
    throw new InputError('changedAfter must not be later than changedBefore');
  }
  return {
    source,
    provider: values.provider,
    op,
    changedAfter,
    changedBefore,
    limit: pageLimit(values.limit),
    cursor: values.cursor,
  };
}
