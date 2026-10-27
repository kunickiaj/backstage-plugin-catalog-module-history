import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { InputError } from '@backstage/errors';

/**
 * Hashes the request filters a cursor belongs to. A cursor only decodes for
 * the same filters, so changing a filter restarts paging. Callers must keep
 * each route's input stable: changing it invalidates cursors already issued.
 */
export function cursorScope(filters: object): string {
  return createHash('sha256').update(JSON.stringify(filters)).digest('hex');
}

/** Encodes a versioned, scope-bound cursor as canonical base64url JSON. */
export function encodeOpaqueCursor(
  tag: string,
  scope: string,
  anchor: Record<string, string>,
): string {
  return Buffer.from(
    JSON.stringify({ tag, version: 1, scope, ...anchor }),
    'utf8',
  ).toString('base64url');
}

/**
 * Decodes a cursor made by {@link encodeOpaqueCursor} for the same tag and
 * scope. Returns exactly the named anchor fields, each a string. Any other
 * shape is an InputError that never includes the cursor's contents.
 */
export function decodeOpaqueCursor<TField extends string>(
  cursor: string,
  options: {
    tag: string;
    scope: string;
    fields: readonly TField[];
    /** Names the cursor in the error message. */
    label: string;
  },
): Record<TField, string> {
  try {
    if (typeof cursor !== 'string' || !/^[A-Za-z0-9_-]+$/.test(cursor)) {
      throw new Error();
    }
    const bytes = Buffer.from(cursor, 'base64url');
    if (bytes.toString('base64url') !== cursor) throw new Error();
    const payload: unknown = JSON.parse(bytes.toString('utf8'));
    if (!isRecord(payload)) throw new Error();
    const { tag, version, scope, ...anchor } = payload;
    if (
      tag !== options.tag ||
      version !== 1 ||
      scope !== options.scope ||
      Object.keys(anchor).length !== options.fields.length ||
      !options.fields.every(field => typeof anchor[field] === 'string')
    ) {
      throw new Error();
    }
    return anchor as Record<TField, string>;
  } catch {
    // Parser errors can contain cursor contents; do not attach them.
    throw new InputError(`Invalid history ${options.label} cursor`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
