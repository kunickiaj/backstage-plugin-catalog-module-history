/** Two recorded events of one entity, compared as from -> to. */
export type HistoryComparisonTarget = {
  entityRef: string;
  fromId: string;
  toId: string;
};

type RecordedEvent = { id: string; changedAt: string };

const NUMERIC_ID = /^\d+$/;

// The default backend uses bigint row IDs, which can exceed Number precision.
// Custom APIs may use any string, so other IDs compare as text.
function compareIds(a: string, b: string): number {
  if (NUMERIC_ID.test(a) && NUMERIC_ID.test(b)) {
    const difference = BigInt(a) - BigInt(b);
    if (difference === 0n) return 0;
    return difference < 0n ? -1 : 1;
  }
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

/**
 * Orders two picked events older first, whichever was picked first. Recorded
 * times have millisecond precision, so ties fall back to the row ID, which the
 * backend also uses to order events recorded at the same time.
 */
export function orderComparison(
  entityRef: string,
  first: RecordedEvent,
  second: RecordedEvent,
): HistoryComparisonTarget {
  const byTime = Date.parse(first.changedAt) - Date.parse(second.changedAt);
  const firstIsOlder =
    byTime === 0 ? compareIds(first.id, second.id) < 0 : byTime < 0;
  const [from, to] = firstIsOlder ? [first, second] : [second, first];
  return { entityRef, fromId: from.id, toId: to.id };
}

/** URL value for a comparison: `fromId..toId`. */
export function formatComparisonParam(target: HistoryComparisonTarget): string {
  return `${target.fromId}..${target.toId}`;
}

/**
 * Reads `compare` and `compareRef` search parameters. Returns undefined for a
 * missing or malformed value, so a bad link shows the normal timeline. Event
 * IDs are opaque here; the history API validates them.
 */
export function parseComparisonParams(
  params: URLSearchParams,
): HistoryComparisonTarget | undefined {
  const entityRef = params.get('compareRef');
  const [fromId, toId, ...rest] = (params.get('compare') ?? '').split('..');
  if (!entityRef || rest.length > 0 || !fromId || !toId || fromId === toId) {
    return undefined;
  }
  return { entityRef, fromId, toId };
}
