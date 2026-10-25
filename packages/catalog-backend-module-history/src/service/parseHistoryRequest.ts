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
  isHistoryOperation,
  isHistorySource,
  type HistoryChangeFeedRequest,
  type HistoryEntitySearchRequest,
  type HistoryEntityTimelineRequest,
  type HistoryEntityVersionRequest,
  type HistoryKindSearchRequest,
  type HistoryProviderSearchRequest,
} from '@kunickiaj/backstage-plugin-catalog-history-common';

const validators = makeValidator();
const COMMON_QUERY_KEYS = [
  'source',
  'provider',
  'changedAfter',
  'changedBefore',
  'limit',
  'cursor',
];
const PROVIDER_QUERY_KEYS = [
  'prefix',
  'source',
  'entityRef',
  'kind',
  'op',
  'changedAfter',
  'changedBefore',
  'limit',
  'cursor',
];
const ENTITY_QUERY_KEYS = [
  'prefix',
  'kind',
  'source',
  'provider',
  'op',
  'changedAfter',
  'changedBefore',
  'limit',
  'cursor',
];
const KIND_QUERY_KEYS = ['prefix', 'limit', 'cursor'];

function timestamp(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  const match =
    /^(\d{4}-\d{2}-\d{2})T([01]\d|2[0-3]):([0-5]\d):([0-5]\d)(?:\.\d+)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.exec(
      value,
    );
  const date = match && new Date(`${match[1]}T00:00:00Z`);
  if (
    !date ||
    !Number.isFinite(date.getTime()) ||
    date.toISOString().slice(0, 10) !== match?.[1] ||
    !Number.isFinite(Date.parse(value))
  ) {
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

function queryValues(
  req: Request,
  endpoint:
    | 'history'
    | 'versions'
    | 'version'
    | 'changes'
    | 'providers'
    | 'entities'
    | 'kinds',
) {
  const allowed = new Set(endpoint === 'version' ? [] : COMMON_QUERY_KEYS);
  if (endpoint === 'providers') {
    allowed.clear();
    PROVIDER_QUERY_KEYS.forEach(key => allowed.add(key));
  }
  if (endpoint === 'entities' || endpoint === 'kinds') {
    allowed.clear();
    const keys = endpoint === 'entities' ? ENTITY_QUERY_KEYS : KIND_QUERY_KEYS;
    keys.forEach(key => allowed.add(key));
  }
  if (endpoint === 'history' || endpoint === 'changes') {
    allowed.add('op');
  }
  if (endpoint === 'changes') {
    allowed.add('entityRef');
    allowed.add('kind');
  }
  const values: Record<string, string> = {};
  // Parse the raw query so repeated keys are rejected independently of the
  // host application's Express query parser configuration.
  const queryStart = req.originalUrl.indexOf('?');
  const query = new URLSearchParams(
    queryStart === -1 ? '' : req.originalUrl.slice(queryStart + 1),
  );
  for (const [key, value] of query) {
    const emptyPrefix =
      (endpoint === 'providers' ||
        endpoint === 'entities' ||
        endpoint === 'kinds') &&
      key === 'prefix';
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

export function parseHistoryVersionRequest(
  req: Request,
): HistoryEntityVersionRequest {
  queryValues(req, 'version');
  const { id } = req.params;
  if (!/^[1-9]\d{0,18}$/.test(id) || BigInt(id) > 9_223_372_036_854_775_807n) {
    throw new InputError('Invalid history row id');
  }
  return { entityRef: entityRef(req), id };
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
  if (values.kind !== undefined && !validators.isValidKind(values.kind)) {
    throw new InputError('Invalid history entity kind');
  }
  let ref: string | undefined;
  if (values.entityRef !== undefined) {
    try {
      ref = validatedEntityRef(
        parseEntityRef(values.entityRef, {
          defaultKind: 'Component',
          defaultNamespace: 'default',
        }),
      );
    } catch {
      throw new InputError('Invalid history entity reference');
    }
  }
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
  if (values.kind !== undefined && !validators.isValidKind(values.kind)) {
    throw new InputError('Invalid history entity kind');
  }
  let ref: string | undefined;
  if (values.entityRef !== undefined) {
    try {
      ref = validatedEntityRef(
        parseEntityRef(values.entityRef, {
          defaultKind: 'Component',
          defaultNamespace: 'default',
        }),
      );
    } catch {
      throw new InputError('Invalid history entity reference');
    }
  }
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
  if (values.kind !== undefined && !validators.isValidKind(values.kind)) {
    throw new InputError('Invalid history entity kind');
  }
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
    Date.parse(changedAfter) > Date.parse(changedBefore)
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
