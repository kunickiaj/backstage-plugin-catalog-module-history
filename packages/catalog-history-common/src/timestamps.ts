const INSTANT =
  /^(\d{4})-(\d{2})-(\d{2})T([01]\d|2[0-3]):([0-5]\d):([0-5]\d)(?:\.(\d+))?(Z|[+-](?:0\d|1[0-5]):[0-5]\d)$/;

/**
 * Whether a value is an RFC 3339 instant with a real calendar date, such as
 * `2026-10-24T12:00:00.123456Z`. Offsets are limited to the ±15:59 range that
 * PostgreSQL accepts.
 *
 * @public
 */
export function isHistoryInstant(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const match = INSTANT.exec(value);
  if (!match) return false;
  const [, year, month, day] = match;
  const date = new Date(`${year}-${month}-${day}T00:00:00Z`);
  return (
    Number.isFinite(date.getTime()) &&
    date.toISOString().slice(0, 10) === `${year}-${month}-${day}`
  );
}

/**
 * Compares two instants accepted by {@link isHistoryInstant}, including
 * fractions below one millisecond. Returns a negative number, zero, or a
 * positive number.
 *
 * @public
 */
export function compareHistoryInstants(left: string, right: string): number {
  const difference = Date.parse(left) - Date.parse(right);
  if (difference !== 0) return difference;
  // Date.parse keeps only milliseconds; compare the remaining digits.
  const a = (INSTANT.exec(left)?.[7] ?? '').slice(3);
  const b = (INSTANT.exec(right)?.[7] ?? '').slice(3);
  const width = Math.max(a.length, b.length);
  const [x, y] = [a.padEnd(width, '0'), b.padEnd(width, '0')];
  if (x === y) return 0;
  return x < y ? -1 : 1;
}
