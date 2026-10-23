import type {
  HistoryDiffEntry,
  HistoryEntitySnapshot,
  HistoryJsonObject,
  HistoryJsonValue,
} from '@kunickiaj/backstage-plugin-catalog-history-common';

const SNAPSHOT_FIELDS = [
  'displayName',
  'email',
  'memberOf',
  'metadata',
  'orphan',
  'owner',
  'parent',
  'relations',
  'spec',
  'statusItems',
] as const satisfies readonly (keyof HistoryEntitySnapshot)[];

function isObject(
  value: HistoryJsonValue | undefined,
): value is HistoryJsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function valueAt(object: HistoryJsonObject, key: string) {
  return Object.prototype.hasOwnProperty.call(object, key)
    ? object[key]
    : undefined;
}

function keys(before: HistoryJsonObject, after: HistoryJsonObject): string[] {
  return [...new Set([...Object.keys(before), ...Object.keys(after)])]
    .filter(
      key =>
        valueAt(before, key) !== undefined || valueAt(after, key) !== undefined,
    )
    .sort();
}

function equals(
  before: HistoryJsonValue | undefined,
  after: HistoryJsonValue | undefined,
): boolean {
  if (before === after) return true;
  if (Array.isArray(before) && Array.isArray(after)) {
    return (
      before.length === after.length &&
      before.every((value, i) => equals(value, after[i]))
    );
  }
  if (isObject(before) && isObject(after)) {
    return keys(before, after).every(key =>
      equals(valueAt(before, key), valueAt(after, key)),
    );
  }
  return false;
}

function diff(
  before: HistoryJsonValue | undefined,
  after: HistoryJsonValue | undefined,
  path: string[],
): HistoryDiffEntry[] {
  if (equals(before, after)) return [];
  if (isObject(before) && isObject(after)) {
    return keys(before, after).flatMap(key =>
      diff(valueAt(before, key), valueAt(after, key), [...path, key]),
    );
  }
  if (before === undefined) return [{ path, op: 'add', after }];
  if (after === undefined) return [{ path, op: 'remove', before }];
  return [{ path, op: 'replace', before, after }];
}

/** Compare saved payload fields only; an absent next snapshot represents deletion. */
export function diffSnapshots(
  before: HistoryEntitySnapshot,
  after: HistoryEntitySnapshot | undefined,
): HistoryDiffEntry[] {
  return SNAPSHOT_FIELDS.flatMap(field =>
    diff(before[field], after?.[field], [field]),
  );
}
