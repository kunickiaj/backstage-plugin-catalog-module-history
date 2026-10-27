import type { Knex } from 'knex';
import { InputError } from '@backstage/errors';
import {
  HistoryRetentionAbortedError,
  type HistoryRetentionCounts,
} from '@kunickiaj/backstage-plugin-catalog-history-node';

// Matches the per-transaction row limit described by HistoryStore.applyRetention.
const MAX_RETENTION_BATCH_SIZE = 10000;

// SQL predicates shared by planning and applying. A stream is one
// (entity_ref, source, provider) triple. The capture baseline queries pick the
// newest row per entity_ref ordered by (changed_at DESC, id DESC) inside a
// provider and/or source filter, so the newest row of every stream must stay.
// Only table aliases are interpolated here; values always go through bindings.

// True when the stream of `row` has another row that sorts after (`>`) or
// before (`<`) it by (changed_at, id), the baseline ordering.
const streamHasRow = (row: string, alias: string, direction: '>' | '<') =>
  `EXISTS (
  SELECT 1 FROM catalog_history_entities ${alias}
  WHERE ${alias}.entity_ref = ${row}.entity_ref
    AND ${alias}.source = ${row}.source
    AND ${alias}.provider = ${row}.provider
    AND (${alias}.changed_at, ${alias}.id) ${direction} (${row}.changed_at, ${row}.id))`;

/**
 * R2: the entity of `row` has no row at or after the cutoff, and every stream
 * of it ends in a delete. Its rows carry no baseline, so all of them can go.
 */
const isPurgeableEntity = (row: string) => `NOT EXISTS (
  SELECT 1 FROM catalog_history_entities keep
  WHERE keep.entity_ref = ${row}.entity_ref
    AND (keep.changed_at >= :cutoff
      OR (keep.op <> 'delete' AND NOT ${streamHasRow('keep', 'keep_newer', '>')})))`;

/**
 * Cheap, index-friendly filters that every R2 row satisfies. They let the
 * planner skip most of the table before evaluating isPurgeableEntity.
 */
const isPurgeableCandidate = (row: string) => `(${row}.changed_at < :cutoff
  AND EXISTS (
    SELECT 1 FROM catalog_history_entities tombstone
    WHERE tombstone.entity_ref = ${row}.entity_ref
      AND tombstone.op = 'delete'
      AND tombstone.changed_at < :cutoff))`;

/** An old row that has a newer row in its stream. */
const isOldAndSuperseded = (row: string) => `(${row}.changed_at < :cutoff
  AND ${streamHasRow(row, `${row}_newer`, '>')})`;

/** R1 for planning: superseded rows outside R2 entities, so counts don't overlap. */
const isSuperseded = (row: string) => `(${isOldAndSuperseded(row)}
  AND NOT ${isPurgeableEntity(row)})`;

/** R3 for applying: an old cycle that currently has no rows. */
const isEmptyCycle = (cycle: string) => `(${cycle}.finished_at < :cutoff
  AND ${cycle}.started_at < :cutoff
  AND NOT EXISTS (
    SELECT 1 FROM catalog_history_entities cycle_row
    WHERE cycle_row.cycle_id = ${cycle}.cycle_id))`;

/** R3 for planning: an old cycle with no row that survives R1 and R2. */
const becomesEmptyCycle = (cycle: string) => `(${cycle}.finished_at < :cutoff
  AND ${cycle}.started_at < :cutoff
  AND NOT EXISTS (
    SELECT 1 FROM catalog_history_entities survivor
    WHERE survivor.cycle_id = ${cycle}.cycle_id
      AND NOT ${isPurgeableEntity('survivor')}
      AND NOT ${isSuperseded('survivor')}))`;

const PLAN_SQL = `SELECT
  (SELECT count(*) FROM catalog_history_entities e
    WHERE ${isPurgeableCandidate('e')}
      AND ${isPurgeableEntity('e')}) AS deleted_entity_rows,
  (SELECT count(*) FROM catalog_history_entities e
    WHERE ${isSuperseded('e')}) AS superseded_rows,
  (SELECT count(*) FROM catalog_history_cycles c
    WHERE ${becomesEmptyCycle('c')}) AS empty_cycles`;

// Deleting a stream's newest tombstone while older rows of that stream remain
// would expose an older live row as the stream's newest and resurrect a
// baseline between batches. Each batch therefore removes only rows that are
// superseded in their stream or are the last row left in it, which keeps the
// entity purgeable until its final row is gone.
//
// Entity-row deletes walk the table by id (keyset pagination) so a pass never
// re-reads rows it already skipped, such as the kept newest rows of live
// entities. RETURNING id gives the position for the next batch.
const DELETE_PURGEABLE_SQL = `DELETE FROM catalog_history_entities
WHERE id IN (
  SELECT e.id FROM catalog_history_entities e
  WHERE e.id > :after
    AND ${isPurgeableCandidate('e')}
    AND ${isPurgeableEntity('e')}
    AND (${streamHasRow('e', 'e_newer', '>')}
      OR NOT ${streamHasRow('e', 'e_older', '<')})
  ORDER BY e.id
  LIMIT :limit)
RETURNING id`;

// R1 runs after R2 has removed every purgeable entity, and new writes carry
// recent timestamps that make an entity unpurgeable, so the R2 exclusion is
// unnecessary here. Dropping it avoids a full-table scan in every batch.
const DELETE_SUPERSEDED_SQL = `DELETE FROM catalog_history_entities
WHERE id IN (
  SELECT e.id FROM catalog_history_entities e
  WHERE e.id > :after
    AND ${isOldAndSuperseded('e')}
  ORDER BY e.id
  LIMIT :limit)
RETURNING id`;

const DELETE_EMPTY_CYCLES_SQL = `DELETE FROM catalog_history_cycles
WHERE cycle_id IN (
  SELECT c.cycle_id FROM catalog_history_cycles c
  WHERE ${isEmptyCycle('c')}
  LIMIT :limit)`;

export function assertRetentionCutoff(cutoff: unknown): asserts cutoff is Date {
  if (!(cutoff instanceof Date) || Number.isNaN(cutoff.getTime())) {
    throw new InputError('Retention cutoff must be a valid Date');
  }
}

export function assertRetentionBatchSize(batchSize: unknown): void {
  if (
    typeof batchSize !== 'number' ||
    !Number.isInteger(batchSize) ||
    batchSize < 1 ||
    batchSize > MAX_RETENTION_BATCH_SIZE
  ) {
    throw new InputError(
      `Retention batchSize must be an integer from 1 to ${MAX_RETENTION_BATCH_SIZE}`,
    );
  }
}

export async function planRetention(
  db: Knex,
  cutoff: Date,
): Promise<HistoryRetentionCounts> {
  // One statement, so all three counts read the same snapshot.
  const result = await db.raw(PLAN_SQL, { cutoff });
  const row = result.rows[0];
  return {
    deletedEntityRows: Number(row.deleted_entity_rows),
    supersededRows: Number(row.superseded_rows),
    emptyCycles: Number(row.empty_cycles),
  };
}

type BatchOptions = {
  cutoff: Date;
  batchSize: number;
  signal?: AbortSignal;
};

// Each DELETE runs as its own autocommit statement, so committed batches stay
// committed when a later batch aborts or fails. Rows recorded after the
// statement snapshot are invisible to its subquery, and new rows carry recent
// changed_at values, so concurrent captures are never removed.
// onBatch reports each committed batch so an abort can still report progress.
type OnBatch = (deleted: number) => void;

async function deleteInBatches(
  db: Knex,
  sql: string,
  { cutoff, batchSize, signal }: BatchOptions,
  onBatch: OnBatch,
): Promise<number> {
  let total = 0;
  for (;;) {
    signal?.throwIfAborted();
    const result = await db.raw(sql, { cutoff, limit: batchSize });
    const deleted = result.rowCount ?? 0;
    if (deleted === 0) return total;
    total += deleted;
    onBatch(deleted);
  }
}

/** One keyset pass over entity rows in id order. */
async function deleteEntityRowsPass(
  db: Knex,
  sql: string,
  { cutoff, batchSize, signal }: BatchOptions,
  onBatch: OnBatch,
): Promise<number> {
  let total = 0;
  let after = '0';
  for (;;) {
    signal?.throwIfAborted();
    const result = await db.raw(sql, { cutoff, limit: batchSize, after });
    const ids: Array<string | number> = result.rows.map(
      (row: { id: string | number }) => row.id,
    );
    if (ids.length === 0) return total;
    total += ids.length;
    onBatch(ids.length);
    // ids are bigint strings from pg; compare numerically without precision loss.
    after = ids
      .map(id => BigInt(id))
      .reduce((max, id) => (id > max ? id : max))
      .toString();
  }
}

// A stream's tombstone can have a lower id than older rows of its stream, and
// the R2 safeguard keeps it until those rows are gone. Repeat passes until one
// removes nothing so apply removes everything plan counted.
async function deletePurgeableEntityRows(
  db: Knex,
  options: BatchOptions,
  onBatch: OnBatch,
): Promise<number> {
  let total = 0;
  for (;;) {
    const deleted = await deleteEntityRowsPass(
      db,
      DELETE_PURGEABLE_SQL,
      options,
      onBatch,
    );
    if (deleted === 0) return total;
    total += deleted;
  }
}

export async function applyRetention(
  db: Knex,
  options: BatchOptions,
): Promise<HistoryRetentionCounts> {
  const counts: HistoryRetentionCounts = {
    deletedEntityRows: 0,
    supersededRows: 0,
    emptyCycles: 0,
  };
  try {
    // Order matters: emptied cycles can only be found after their rows go.
    await deletePurgeableEntityRows(db, options, deleted => {
      counts.deletedEntityRows += deleted;
    });
    // One pass suffices: R1 only removes rows that already have a newer row in
    // their stream, so it never makes another row eligible.
    await deleteEntityRowsPass(db, DELETE_SUPERSEDED_SQL, options, deleted => {
      counts.supersededRows += deleted;
    });
    await deleteInBatches(db, DELETE_EMPTY_CYCLES_SQL, options, deleted => {
      counts.emptyCycles += deleted;
    });
  } catch (error) {
    if (options.signal?.aborted) {
      throw new HistoryRetentionAbortedError({ ...counts }, { cause: error });
    }
    throw error;
  }
  return counts;
}
