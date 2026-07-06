/**
 * Capture sources and operations recorded by the catalog history plugin
 * family.
 *
 * These values mirror the `source` and `op` columns of the history store and
 * are safe to use from both frontend and backend code.
 */

/**
 * All capture layers that can record catalog history.
 *
 * - `provider`: origin truth captured from `EntityProviderConnection.applyMutation`.
 * - `processing`: processor-layer truth captured after catalog processing.
 * - `reconciler`: served truth captured from the public Catalog API.
 *
 * @public
 */
export const HISTORY_SOURCES = [
  'provider',
  'processing',
  'reconciler',
] as const;

/**
 * A capture layer that recorded a history row.
 *
 * @public
 */
export type HistorySource = (typeof HISTORY_SOURCES)[number];

/**
 * All change operations recorded for an entity.
 *
 * @public
 */
export const HISTORY_OPERATIONS = ['insert', 'update', 'delete'] as const;

/**
 * The change operation recorded for an entity in one cycle.
 *
 * @public
 */
export type HistoryOperation = (typeof HISTORY_OPERATIONS)[number];

/**
 * Mutation shapes recorded for a history cycle.
 *
 * @public
 */
export const HISTORY_MUTATION_TYPES = ['full', 'delta'] as const;

/**
 * The mutation shape of one recorded cycle.
 *
 * @public
 */
export type HistoryMutationType = (typeof HISTORY_MUTATION_TYPES)[number];

/**
 * Returns whether an unknown value is a valid {@link HistorySource}.
 *
 * @public
 */
export function isHistorySource(value: unknown): value is HistorySource {
  return (
    typeof value === 'string' &&
    (HISTORY_SOURCES as readonly string[]).includes(value)
  );
}

/**
 * Returns whether an unknown value is a valid {@link HistoryOperation}.
 *
 * @public
 */
export function isHistoryOperation(value: unknown): value is HistoryOperation {
  return (
    typeof value === 'string' &&
    (HISTORY_OPERATIONS as readonly string[]).includes(value)
  );
}

/**
 * Returns whether an unknown value is a valid {@link HistoryMutationType}.
 *
 * @public
 */
export function isHistoryMutationType(
  value: unknown,
): value is HistoryMutationType {
  return (
    typeof value === 'string' &&
    (HISTORY_MUTATION_TYPES as readonly string[]).includes(value)
  );
}
