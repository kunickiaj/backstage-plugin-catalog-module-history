/** Opt-in diagnostics for OUR public store, not an automatic CI test. */
// Benchmark files are test-only but the import rule only recognizes *.test.ts.
/* eslint-disable @backstage/no-undeclared-imports */
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile } from 'node:fs/promises';
import { arch, cpus, totalmem } from 'node:os';
import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { promisify } from 'node:util';
import { TestDatabases } from '@backstage/backend-test-utils';
import type { Entity } from '@backstage/catalog-model';
import { entityToRow } from '@kunickiaj/backstage-plugin-catalog-backend-module-history';
import type {
  CycleInput,
  EntityRow,
} from '@kunickiaj/backstage-plugin-catalog-history-node';
import type {
  HistoryTimelineItem,
  HistoryEntityVersionResponse,
} from '@kunickiaj/backstage-plugin-catalog-history-common';
import { PostgresHistoryStore } from '@kunickiaj/backstage-plugin-catalog-history-storage-node';
import { knex, type Knex } from 'knex';
import type { Client } from 'pg';
import stableStringify from 'json-stable-stringify';

// Source-only harness, never a production entry point.
// eslint-disable-next-line no-restricted-syntax
const ROOT = resolve(__dirname, '../../../..');
const executeFile = promisify(execFile);
const PROVIDER = 'query-benchmark';
const SOURCE = 'provider' as const;
const SAMPLES = 50;
const WARMUPS = 5;
const QUERY_TIMEOUT_MS = 10_000;
const STATEMENT_MS = 30_000;
const PADDING = 'example.com/history-benchmark-padding';
const BASE_TIME = Date.parse('2026-01-01T00:00:00.000Z');
type Options = {
  refs: number;
  revisions: number;
  profile: 'standard' | 'heavy';
};
type Emit = (event: Record<string, unknown>) => Promise<void>;
type Page = { items: HistoryTimelineItem[]; nextCursor?: string };
type Shape = {
  name: string;
  call: () => Promise<unknown>;
  validate: (result: any) => void;
};
type Samples = Map<string, { durationsMs: number[]; resultBytes: number[] }>;

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function ownedDockerOnly(env: NodeJS.ProcessEnv) {
  check(
    !Object.hasOwn(env, 'BACKSTAGE_TEST_DATABASE_POSTGRES16_CONNECTION_STRING'),
    'Caller database override refused; owned Docker PostgreSQL 16 only',
  );
}

function optionsFromEnvironment(env: NodeJS.ProcessEnv): Options {
  const integer = (key: string, fallback: string, min: number, max: number) => {
    const raw = env[key] ?? fallback;
    const value = Number(raw);
    check(
      /^[1-9]\d*$/.test(raw) && value >= min && value <= max,
      `${key} out of range`,
    );
    return value;
  };
  const refs = integer('HISTORY_QUERY_REFS', '1000', 1, 20_000);
  const revisions = integer('HISTORY_QUERY_REVISIONS', '10', 2, 100);
  const profile = env.HISTORY_QUERY_PROFILE ?? 'standard';
  check(profile === 'standard' || profile === 'heavy', 'Unknown query profile');
  check(refs * revisions <= 200_000, 'Seed history exceeds 200000 rows');
  check(profile !== 'heavy' || refs <= 1000, 'Heavy profile exceeds 1000 refs');
  return { refs, revisions, profile };
}

/** Literal nearest rank: sorted[ceil(p * n) - 1], with no interpolation. */
function percentile(values: number[], p: number) {
  check(values.length > 0 && p > 0 && p <= 1, 'Invalid percentile input');
  check(
    values.every(v => Number.isFinite(v) && v >= 0),
    'Invalid duration',
  );
  return [...values].sort((a, b) => a - b)[Math.ceil(p * values.length) - 1];
}

function summary(durationsMs: number[]) {
  return {
    sampleCount: durationsMs.length,
    durationsMs,
    p50Ms: percentile(durationsMs, 0.5),
    p95Ms: percentile(durationsMs, 0.95),
    percentileMethod: 'nearest-rank ceil(p*n)-1; no interpolation',
  };
}

function errorType(error: unknown) {
  return error instanceof Error ? error.constructor.name : typeof error;
}

function hash(value: unknown) {
  return createHash('sha256')
    .update(stableStringify(value) ?? 'undefined')
    .digest('hex');
}

function payloadBytes(entity: Entity) {
  return (
    Buffer.byteLength(JSON.stringify(entity.metadata)) +
    Buffer.byteLength(JSON.stringify(entity.spec))
  );
}

/** Change only description and trim padding by the extra revision digits. */
function revisionEntity(
  entity: Entity,
  revision: number,
  bytes: number,
): Entity {
  check(Number.isInteger(revision) && revision >= 0, 'Invalid revision');
  const original = entity.metadata.description;
  const padding = entity.metadata.annotations?.[PADDING];
  check(
    typeof original === 'string' && original.endsWith('revision 0') && padding,
    'Invalid baseline entity',
  );
  const description = original.replace(/revision 0$/, `revision ${revision}`);
  const trim = String(revision).length - 1;
  const revised = {
    ...entity,
    metadata: {
      ...entity.metadata,
      description,
      annotations: {
        ...entity.metadata.annotations,
        [PADDING]: padding.slice(0, padding.length - trim),
      },
    },
  };
  check(payloadBytes(revised) === bytes, 'Fixture payload byte drift');
  return revised;
}

function revisionRows(
  entities: Entity[],
  revision: number,
  bytes: number,
  previous: Map<string, string>,
) {
  const rows = entities.map(entity =>
    entityToRow(revisionEntity(entity, revision, bytes)),
  );
  check(
    new Set(rows.map(row => row.entityRef)).size === rows.length,
    'Duplicate fixture refs',
  );
  for (const row of rows)
    check(
      previous.get(row.entityRef) !== row.etag,
      'Revision etag did not change',
    );
  return rows;
}

function applyRows(expected: Map<string, string>, rows: EntityRow[]) {
  for (const row of rows) expected.set(row.entityRef, row.etag);
}

function cycle(rows: EntityRow[], revision: number): CycleInput {
  const finishedAt = new Date(BASE_TIME + revision * 1000);
  return {
    cycleId: randomUUID(),
    provider: PROVIDER,
    source: SOURCE,
    mutationType: 'full',
    startedAt: finishedAt,
    finishedAt,
    inserts: revision === 0 ? rows : [],
    updates: revision === 0 ? [] : rows,
    deletes: [],
    unchangedCount: 0,
  };
}

async function generate(options: Options, directory: string) {
  const output = resolve(directory, 'initial.jsonl');
  await executeFile(
    process.execPath,
    [
      resolve(ROOT, 'scripts/catalog-history-fixtures.mjs'),
      '--count',
      String(options.refs),
      '--profile',
      options.profile,
      '--stage',
      'initial',
      '--output',
      output,
    ],
    { timeout: 30_000 },
  );
  const entities = (await readFile(output, 'utf8'))
    .trim()
    .split('\n')
    .map(line => JSON.parse(line) as Entity);
  check(entities.length === options.refs, 'Generator ref count mismatch');
  return entities;
}

function fixturePool(allocated: Knex) {
  return knex({
    client: 'pg',
    connection: allocated.client.config.connection,
    pool: {
      min: 0,
      max: 12,
      afterCreate(
        client: Client,
        done: (error: Error | null, client: Client) => void,
      ) {
        client.query(`SET statement_timeout = '${STATEMENT_MS}ms'`, error =>
          done(error, client),
        );
      },
    },
    acquireConnectionTimeout: 35_000,
  });
}

type CleanupAction = { stage: string; action: () => Promise<unknown> };

/** All actions run, even if construction, shutdown, diagnostics or destroy fail. */
async function cleanup(
  actions: CleanupAction[],
  emit: Emit,
  prior?: { error: unknown },
) {
  const failures: { stage: string; error: unknown }[] = [];
  for (const { stage, action } of actions) {
    try {
      await action();
    } catch (error) {
      failures.push({ stage, error });
    }
  }
  try {
    await emit({
      type: 'cleanup',
      status: failures.length ? 'nonpass' : 'pools-destroyed',
      failures: failures.map(f => ({
        stage: f.stage,
        errorType: errorType(f.error),
      })),
      sdkContainerCleanup:
        'TestDatabases registered afterAll still required; not yet claimed complete',
    });
  } catch (error) {
    failures.push({ stage: 'cleanup-artifact', error });
  }
  if (prior) throw prior.error;
  if (failures.length) throw failures[0].error;
}

type Writer = Pick<
  Knex.Transaction,
  'isCompleted' | 'commit' | 'rollback' | 'executionPromise'
>;

/** Resolved recordCycle releases its savepoint, not the outer transaction. */
async function heldWriter(
  writer: Writer,
  write: () => Promise<void>,
  read: () => Promise<void>,
) {
  // Attach immediately: neither commit nor rollback rejection can be unobserved.
  const settled = writer.executionPromise.then(
    () => ({ error: undefined as unknown }),
    error => ({ error }),
  );
  let failure: { error: unknown } | undefined;
  let recordMs = 0;
  let commitMs = 0;
  try {
    const start = performance.now();
    await write();
    recordMs = performance.now() - start;
    check(!writer.isCompleted(), 'Writer committed before reader barrier');
    try {
      await read();
    } finally {
      check(!writer.isCompleted(), 'Writer completed during reader batch');
    }
    const commitStart = performance.now();
    await writer.commit();
    commitMs = performance.now() - commitStart;
  } catch (error) {
    failure = { error };
  } finally {
    try {
      if (!writer.isCompleted()) await writer.rollback();
    } catch (error) {
      failure ??= { error };
    }
    const outcome = await settled;
    if (outcome.error !== undefined) failure ??= { error: outcome.error };
  }
  if (failure) throw failure.error;
  return { recordMs, commitMs, incompleteBeforeAndAfterReaderBatch: true };
}

async function measure(
  call: () => Promise<unknown>,
  label: string,
  emit: Emit,
) {
  const start = performance.now();
  let result: unknown;
  try {
    result = await call();
  } catch (error) {
    const durationMs = performance.now() - start;
    try {
      await emit({
        type: 'sample-failure',
        label,
        durationMs,
        errorType: errorType(error),
        status: 'nonpass',
      });
    } catch {
      /* never replace a public-method failure with an artifact error */
    }
    throw error;
  }
  const durationMs = performance.now() - start;
  return { result, durationMs };
}

function resultBytes(result: unknown) {
  const value = result instanceof Map ? [...result] : result;
  return Buffer.byteLength(JSON.stringify(value));
}

async function sampleBatch(
  shapes: Shape[],
  samples: Samples | undefined,
  phase: string,
  emit: Emit,
) {
  for (const shape of shapes) {
    const { result, durationMs } = await measure(
      shape.call,
      `${phase}/${shape.name}`,
      emit,
    );
    // Validation, serialization, hashing and artifacts are outside the timer.
    try {
      shape.validate(result);
    } catch (error) {
      try {
        await emit({
          type: 'sample-validation-failure',
          phase,
          shape: shape.name,
          durationMs,
          errorType: errorType(error),
          status: 'nonpass',
        });
      } catch {
        /* preserve validation failure */
      }
      throw error;
    }
    if (samples) {
      const sample = samples.get(shape.name) ?? {
        durationsMs: [],
        resultBytes: [],
      };
      sample.durationsMs.push(durationMs);
      sample.resultBytes.push(resultBytes(result));
      samples.set(shape.name, sample);
      await emit({
        type: 'read-sample',
        phase,
        shape: shape.name,
        sample: sample.durationsMs.length,
        durationMs,
        resultBytes: sample.resultBytes.at(-1),
      });
    }
  }
}

async function reportSamples(samples: Samples, phase: string, emit: Emit) {
  for (const [shape, data] of samples) {
    check(
      data.durationsMs.length === SAMPLES,
      'Incomplete measurement sample count',
    );
    await emit({
      type: 'read-samples',
      phase,
      shape,
      warmupsExcluded: WARMUPS,
      ...summary(data.durationsMs),
      resultBytes: data.resultBytes,
    });
  }
}

function assertPage(page: Page) {
  check(
    new Set(page.items.map(item => item.id)).size === page.items.length,
    'Repeated page ID',
  );
  for (let i = 0; i < page.items.length; i++) {
    const item = page.items[i];
    check(
      item.source === SOURCE && item.provider === PROVIDER,
      'Unexpected provenance',
    );
    if (i === 0) continue;
    const previous = page.items[i - 1];
    check(
      previous.changedAt > item.changedAt ||
        (previous.changedAt === item.changedAt &&
          BigInt(previous.id) > BigInt(item.id)),
      'Incorrect page order',
    );
  }
}

function assertMap(actual: Map<string, string>, expected: Map<string, string>) {
  check(actual.size === expected.size, 'Latest etag map size mismatch');
  for (const [ref, etag] of expected)
    check(actual.get(ref) === etag, 'Latest etag map content mismatch');
}

function assertDetail(
  result: HistoryEntityVersionResponse,
  latest: EntityRow,
  previous: EntityRow,
) {
  check(
    result.op === 'update' && result.etag === latest.etag,
    'Wrong detail revision',
  );
  check(
    result.snapshot?.metadata?.description === latest.metadata.description,
    'Wrong detail description',
  );
  check(
    result.previousVersion?.etag === previous.etag,
    'Wrong detail predecessor',
  );
  check(
    result.previousVersion?.snapshot?.metadata?.description ===
      previous.metadata.description,
    'Wrong preceding description',
  );
  check(
    result.previousVersion?.source === SOURCE &&
      result.previousVersion.provider === PROVIDER,
    'Wrong predecessor provenance',
  );
  check(
    result.changes?.some(
      change =>
        change.path.join('.') === 'metadata.description' &&
        change.op === 'replace' &&
        change.before === previous.metadata.description &&
        change.after === latest.metadata.description,
    ),
    'Missing description diff',
  );
}

async function traverse(
  call: (cursor?: string) => Promise<Page>,
  count: number,
) {
  const ids = new Set<string>();
  const etags = new Set<string>();
  let cursor: string | undefined;
  let last: HistoryTimelineItem | undefined;
  // Independent row count limits traversal; a looping cursor fails, never spins.
  for (let pageNumber = 0; pageNumber <= Math.ceil(count / 5); pageNumber++) {
    const page = await call(cursor);
    assertPage(page);
    if (last && page.items.length) assertPage({ items: [last, page.items[0]] });
    for (const item of page.items) {
      check(!ids.has(item.id), 'Traversal repeated ID');
      ids.add(item.id);
      check(
        item.etag && !etags.has(item.etag),
        'Traversal repeated version etag',
      );
      etags.add(item.etag);
    }
    last = page.items.at(-1);
    cursor = page.nextCursor;
    if (!cursor) {
      check(ids.size === count, 'Traversal count mismatch');
      return;
    }
  }
  throw new Error('Traversal exceeded expected page count');
}

async function buildShapes(
  store: PostgresHistoryStore,
  expected: Map<string, string>,
  entities: Entity[],
  options: Options,
) {
  const query = store.query;
  const bytes = options.profile === 'standard' ? 1190 : 8882;
  const latest = entityToRow(
    revisionEntity(entities[0], options.revisions - 1, bytes),
  );
  const previous = entityToRow(
    revisionEntity(entities[0], options.revisions - 2, bytes),
  );
  const entityRef = latest.entityRef;
  const filter = { source: SOURCE, provider: PROVIDER };
  const request = { entityRef, limit: 5, ...filter };
  const firstTimeline = await query.getEntityTimeline(request);
  const firstVersions = await query.getEntityVersions(request);
  const firstFeed = await query.getChangeFeed({ limit: 25 });
  // Tiny legal fixtures still have a real nonempty cursor page: use a one-row
  // seed anchor only when the ordinary first page already exhausts the history.
  const timelineCursor =
    firstTimeline.nextCursor ??
    (await query.getEntityTimeline({ ...request, limit: 1 })).nextCursor;
  const versionsCursor =
    firstVersions.nextCursor ??
    (await query.getEntityVersions({ ...request, limit: 1 })).nextCursor;
  const feedCursor =
    firstFeed.nextCursor ??
    (await query.getChangeFeed({ limit: 1 })).nextCursor;
  check(timelineCursor && versionsCursor && feedCursor, 'Missing seed cursors');
  const knownId = firstTimeline.items[0].id;
  const timelineTail = await query.getEntityTimeline({
    ...request,
    cursor: timelineCursor,
  });
  const versionsTail = await query.getEntityVersions({
    ...request,
    cursor: versionsCursor,
  });
  const feedTail = await query.getChangeFeed({
    limit: 25,
    cursor: feedCursor,
  });
  const noOverlap = (head: Page, tail: Page) => {
    // Fallback anchors have limit 1, so do not compare against the larger head.
    assertPage(tail);
    check(head.items[0].id !== tail.items[0]?.id, 'Cursor repeated newest row');
    if (head.nextCursor)
      check(
        !tail.items.some(item =>
          head.items.some(headItem => headItem.id === item.id),
        ),
        'Cursor pages overlap',
      );
  };
  noOverlap(firstTimeline, timelineTail);
  noOverlap(firstVersions, versionsTail);
  noOverlap(firstFeed, feedTail);
  await traverse(
    cursor => query.getEntityTimeline({ ...request, cursor }),
    options.revisions,
  );
  await traverse(
    cursor => query.getEntityVersions({ ...request, cursor }),
    options.revisions,
  );
  const selective = {
    ...filter,
    entityRef,
    kind: 'Component',
    op: 'update' as const,
    changedAfter: new Date(BASE_TIME + 1000).toISOString(),
    changedBefore: new Date(
      BASE_TIME + (options.revisions - 1) * 1000,
    ).toISOString(),
  };
  const filtered = await query.getChangeFeed({ ...selective, limit: 25 });
  check(
    filtered.items.length === Math.min(25, options.revisions - 1),
    'Inclusive filtered bounds mismatch',
  );
  const nonmatch = await query.getChangeFeed({
    ...selective,
    entityRef: 'component:benchmark/not-present',
    limit: 25,
  });
  check(
    nonmatch.items.length === 0 && !nonmatch.nextCursor,
    'Nonmatching feed returned results',
  );
  await traverse(
    cursor => query.getChangeFeed({ ...selective, limit: 5, cursor }),
    options.revisions - 1,
  );
  const baselineByRef = new Map(
    entities.map(entity => [entityToRow(entity).entityRef, entity]),
  );
  const validatePayload = (page: Page) => {
    assertPage(page);
    for (const item of page.items) {
      const baseline = baselineByRef.get(item.entityRef);
      check(baseline, 'Unknown result entity');
      const revision = (Date.parse(item.changedAt) - BASE_TIME) / 1000;
      check(
        Number.isInteger(revision) &&
          revision >= 0 &&
          revision < options.revisions + SAMPLES,
        'Unexpected result timestamp',
      );
      const row = entityToRow(revisionEntity(baseline, revision, bytes));
      check(
        item.etag === row.etag &&
          item.op === (revision === 0 ? 'insert' : 'update'),
        'Incorrect result revision',
      );
      if ('snapshot' in item) {
        const version = item as HistoryEntityVersionResponse;
        check(
          hash(version.snapshot?.metadata) === hash(row.metadata) &&
            hash(version.snapshot?.spec) === hash(row.spec),
          'Version snapshot differs from fixture',
        );
      }
    }
  };
  const cursorPage = (baseline: Page) => (page: Page) => {
    validatePayload(page);
    check(
      hash(page) === hash(baseline),
      'Seed cursor page changed under new head writes',
    );
  };
  const headPage = (page: Page) => {
    validatePayload(page);
    check(page.items.length > 0, 'Empty first page');
  };
  const entityHead = (page: Page) => {
    headPage(page);
    check(
      page.items[0].etag === expected.get(entityRef),
      'Entity head does not match current etag',
    );
  };
  const shapes: Shape[] = [
    {
      name: 'timeline.first',
      call: () => query.getEntityTimeline(request),
      validate: entityHead,
    },
    {
      name: 'timeline.cursor',
      call: () =>
        query.getEntityTimeline({ ...request, cursor: timelineCursor }),
      validate: cursorPage(timelineTail),
    },
    {
      name: 'versions.first',
      call: () => query.getEntityVersions(request),
      validate: entityHead,
    },
    {
      name: 'versions.cursor',
      call: () =>
        query.getEntityVersions({ ...request, cursor: versionsCursor }),
      validate: cursorPage(versionsTail),
    },
    {
      name: 'detail.known-update',
      call: () => query.getEntityVersion({ entityRef, id: knownId }),
      validate: result => assertDetail(result, latest, previous),
    },
    {
      name: 'feed.unfiltered.first',
      call: () => query.getChangeFeed({ limit: 25 }),
      validate: headPage,
    },
    {
      name: 'feed.unfiltered.cursor',
      call: () => query.getChangeFeed({ limit: 25, cursor: feedCursor }),
      validate: cursorPage(feedTail),
    },
    {
      name: 'feed.filtered-entity',
      call: () => query.getChangeFeed({ ...selective, limit: 25 }),
      validate: cursorPage(filtered),
    },
    {
      name: 'latest.provider/source',
      call: () => store.loadCurrentEtags(PROVIDER, { source: SOURCE }),
      validate: actual => assertMap(actual, expected),
    },
    {
      name: 'latest.all/source',
      call: () => store.loadAllCurrentEtags({ source: SOURCE }),
      validate: actual => {
        for (const value of actual.values())
          check(value.provider === PROVIDER, 'Wrong latest provider');
        assertMap(
          new Map(
            [...actual].map(([ref, value]: [string, { etag: string }]) => [
              ref,
              value.etag,
            ]),
          ),
          expected,
        );
      },
    },
  ];
  return shapes;
}

async function counts(db: Knex, expectedRows: number, expectedCycles: number) {
  const rows = await db('catalog_history_entities').count('* as count').first();
  const cycles = await db('catalog_history_cycles').count('* as count').first();
  check(
    Number(rows?.count) === expectedRows &&
      Number(cycles?.count) === expectedCycles,
    'Stored row/cycle count mismatch',
  );
  return { rows: expectedRows, cycles: expectedCycles };
}

async function diagnostics(db: Knex, emit: Emit) {
  // Only this owned database; omit SQL text, binds, connection data and PIDs.
  const activity = await db.raw(
    `SELECT state, count(*)::int AS count FROM pg_stat_activity WHERE datname=current_database() AND pid <> pg_backend_pid() GROUP BY state`,
  );
  const pool = db.client.pool;
  await emit({
    type: 'post-shutdown-diagnostics',
    activity: activity.rows,
    pool: {
      used: pool.numUsed(),
      free: pool.numFree(),
      pendingAcquires: pool.numPendingAcquires(),
      pendingCreates: pool.numPendingCreates(),
    },
  });
  check(
    pool.numUsed() === 0 &&
      pool.numPendingAcquires() === 0 &&
      pool.numPendingCreates() === 0,
    'Fixture pool still busy',
  );
  check(
    activity.rows.every((row: { state: string }) => row.state === 'idle'),
    'Owned database still active',
  );
}

async function sizes(db: Knex, emit: Emit) {
  const result = await db.raw(
    `SELECT relname AS relation, pg_relation_size(oid)::text AS heap_bytes, pg_indexes_size(oid)::text AS index_bytes, CASE WHEN reltoastrelid=0 THEN '0' ELSE pg_total_relation_size(reltoastrelid)::text END AS toast_total_bytes, pg_total_relation_size(oid)::text AS total_bytes FROM pg_class WHERE oid IN ('catalog_history_entities'::regclass, 'catalog_history_cycles'::regclass) ORDER BY relname`,
  );
  await emit({ type: 'relation-sizes', relations: result.rows });
}

async function seed(
  store: PostgresHistoryStore,
  entities: Entity[],
  options: Options,
  expected: Map<string, string>,
  emit: Emit,
) {
  const durationsMs: number[] = [];
  const bytes = options.profile === 'standard' ? 1190 : 8882;
  for (let revision = 0; revision < options.revisions; revision++) {
    const rows = revisionRows(entities, revision, bytes, expected);
    const input = cycle(rows, revision);
    const timed = await measure(
      () => store.recordCycle(input),
      `seed.recordCycle.${revision}`,
      emit,
    );
    durationsMs.push(timed.durationMs);
    applyRows(expected, rows);
  }
  await emit({
    type: 'normal-committed-seed-recordCycle',
    ...summary(durationsMs),
    rowsPerCycle: options.refs,
    generationAndMappingExcluded: true,
    includesNormalTransactionControlAndCommit: true,
    schemaPreparedBeforeSeed: true,
  });
}

async function overlappingReads(
  db: Knex,
  store: PostgresHistoryStore,
  entities: Entity[],
  options: Options,
  expected: Map<string, string>,
  shapes: Shape[],
  emit: Emit,
) {
  for (let i = 0; i < WARMUPS; i++)
    await sampleBatch(shapes, undefined, 'overlap-warmup-before-writers', emit);
  const samples: Samples = new Map();
  const recordMs: number[] = [];
  const commitMs: number[] = [];
  const width = Math.min(100, options.refs);
  const bytes = options.profile === 'standard' ? 1190 : 8882;
  for (let round = 0; round < SAMPLES; round++) {
    const rows = revisionRows(
      entities.slice(0, width),
      options.revisions + round,
      bytes,
      expected,
    );
    const input = cycle(rows, options.revisions + round);
    const tx = await db.transaction();
    const nested = new PostgresHistoryStore(tx, {
      queryTimeoutMs: QUERY_TIMEOUT_MS,
    });
    const result = await heldWriter(
      tx,
      () => nested.recordCycle(input),
      () => sampleBatch(shapes, samples, 'overlap', emit),
    );
    recordMs.push(result.recordMs);
    commitMs.push(result.commitMs);
    applyRows(expected, rows);
    await emit({
      type: 'writer-barrier',
      round,
      incompleteBeforeAndAfterReaderBatch:
        result.incompleteBeforeAndAfterReaderBatch,
    });
  }
  await reportSamples(
    samples,
    'reads overlapping an uncommitted writer transaction',
    emit,
  );
  await emit({
    type: 'overlap-writes',
    rowsPerCycle: width,
    cycles: SAMPLES,
    recordCycleSavepoint: summary(recordMs),
    outerCommitInvocation: summary(commitMs),
    barrierDwellExcludedFromWriteTimings: true,
    simultaneousInsertSelect: false,
    poolSaturationTest: false,
  });
  assertMap(
    await store.loadCurrentEtags(PROVIDER, { source: SOURCE }),
    expected,
  );
  const all = await store.loadAllCurrentEtags({ source: SOURCE });
  assertMap(
    new Map([...all].map(([ref, value]) => [ref, value.etag])),
    expected,
  );
}

async function runFixture(
  databases: TestDatabases,
  options: Options,
  entities: Entity[],
  emit: Emit,
  createPool = fixturePool,
) {
  ownedDockerOnly(process.env);
  const allocated = await databases.init('POSTGRES_16');
  let db: Knex | undefined;
  let store: PostgresHistoryStore | undefined;
  let prior: { error: unknown } | undefined;
  try {
    // Inside the try: a pool-construction failure must still destroy allocated.
    db = createPool(allocated);
    store = new PostgresHistoryStore(db, { queryTimeoutMs: QUERY_TIMEOUT_MS });
    const openStore = store;
    await store.ensureReady();
    const version = await db.raw('SHOW server_version');
    const cap = await db.raw('SHOW statement_timeout');
    const settings = await db('pg_settings')
      .select('name', 'setting', 'unit')
      .whereIn('name', ['shared_buffers', 'work_mem', 'synchronous_commit']);
    await emit({
      type: 'database-environment',
      postgresVersion: version.rows[0].server_version,
      sessionStatementTimeout: cap.rows[0].statement_timeout,
      settings,
      containerCpuQuota: 'unknown',
      containerMemoryQuotaBytes: 'unknown',
    });
    const expected = new Map<string, string>();
    await seed(store, entities, options, expected, emit);
    const invalidRefCounts = await db.raw(
      `SELECT count(*)::int AS count FROM (SELECT entity_ref FROM catalog_history_entities GROUP BY entity_ref HAVING count(*) <> ? OR count(DISTINCT (source, provider, etag)) <> ?) invalid`,
      [options.revisions, options.revisions],
    );
    check(
      invalidRefCounts.rows[0].count === 0,
      'Seed per-ref revision counts or distinct etags mismatch',
    );
    const cycleTotals = await db('catalog_history_cycles')
      .sum({
        added: 'n_added',
        modified: 'n_modified',
        removed: 'n_removed',
        unchanged: 'n_unchanged',
      })
      .first();
    check(
      Number(cycleTotals?.added) === options.refs &&
        Number(cycleTotals?.modified) ===
          options.refs * (options.revisions - 1) &&
        Number(cycleTotals?.removed) === 0 &&
        Number(cycleTotals?.unchanged) === 0,
      'Seed cycle counter mismatch',
    );
    await emit({
      type: 'seed-validated',
      ...(await counts(
        db,
        options.refs * options.revisions,
        options.revisions,
      )),
      payloadBytesEveryRow: options.profile === 'standard' ? 1190 : 8882,
      distinctVersionsPerRef: options.revisions,
      cycleTotals,
    });
    assertMap(
      await store.loadCurrentEtags(PROVIDER, { source: SOURCE }),
      expected,
    );
    const allSeedEtags = await store.loadAllCurrentEtags({ source: SOURCE });
    check(
      [...allSeedEtags.values()].every(value => value.provider === PROVIDER),
      'Wrong seed latest provider',
    );
    assertMap(
      new Map([...allSeedEtags].map(([ref, value]) => [ref, value.etag])),
      expected,
    );
    const entityRef = entityToRow(entities[0]).entityRef;
    const first = await measure(
      () => openStore.query.getEntityTimeline({ entityRef, limit: 5 }),
      'first-query-schema-promise-unprepared',
      emit,
    );
    assertPage(first.result as Page);
    await emit({
      type: 'first-query-schema-promise-unprepared',
      durationMs: first.durationMs,
      coldOsCacheClaim: false,
    });
    await store.query.ensureReady();
    const shapes = await buildShapes(store, expected, entities, options);
    for (let i = 0; i < WARMUPS; i++)
      await sampleBatch(shapes, undefined, 'quiescent-warmup', emit);
    const samples: Samples = new Map();
    for (let i = 0; i < SAMPLES; i++)
      await sampleBatch(shapes, samples, 'quiescent', emit);
    await reportSamples(samples, 'quiescent-prepared', emit);
    await overlappingReads(
      db,
      store,
      entities,
      options,
      expected,
      shapes,
      emit,
    );
    const final = await counts(
      db,
      options.refs * options.revisions + SAMPLES * Math.min(100, options.refs),
      options.revisions + SAMPLES,
    );
    await emit({
      type: 'final-validated',
      ...final,
      latestMapCount: expected.size,
      latestMapSha256: hash([...expected].sort()),
      feedTraversal:
        'first two pages only; SQL counts independent; entity timeline and versions fully traversed before writes',
    });
    await sizes(db, emit);
  } catch (error) {
    prior = { error };
    try {
      await emit({
        type: 'run-failure',
        status: 'nonpass',
        errorType: errorType(error),
      });
    } catch {
      /* preserve domain failure */
    }
  } finally {
    await cleanup(
      [
        { stage: 'store.shutdown', action: async () => store?.shutdown() },
        {
          stage: 'owned-diagnostics',
          action: async () => {
            if (db) await diagnostics(db, emit);
          },
        },
        { stage: 'fixture.destroy', action: async () => db?.destroy() },
        { stage: 'allocated.destroy', action: () => allocated.destroy() },
      ],
      emit,
      prior,
    );
  }
}

/** A pass requires the fixture operation, including owned-pool cleanup, to return. */
async function reportResult(run: () => Promise<void>, emit: Emit) {
  try {
    await run();
    await emit({
      type: 'result',
      status: 'pass',
      sdkContainerCleanup: 'TestDatabases afterAll still required',
    });
  } catch (error) {
    try {
      await emit({
        type: 'result',
        status: 'nonpass',
        errorType: errorType(error),
      });
    } catch {
      /* preserve the original operation or artifact failure */
    }
    throw error;
  }
}

async function runBenchmark(databases: TestDatabases) {
  const options = optionsFromEnvironment(process.env);
  const directory = resolve(ROOT, '.tmp/history-queries', randomUUID());
  await mkdir(directory, { recursive: true });
  const artifact = await open(resolve(directory, 'report.jsonl'), 'wx');
  const emit: Emit = async event => {
    await artifact.write(`${JSON.stringify(event)}\n`);
  };
  try {
    await reportResult(async () => {
      const sha = (
        await executeFile('git', ['rev-parse', 'HEAD'], { cwd: ROOT })
      ).stdout.trim();
      const dirty = Boolean(
        (
          await executeFile('git', ['status', '--porcelain'], { cwd: ROOT })
        ).stdout.trim(),
      );
      const packages = Object.fromEntries(
        await Promise.all(
          [
            '@backstage/backend-test-utils',
            'knex',
            'pg',
            '@kunickiaj/backstage-plugin-catalog-history-storage-node',
            '@kunickiaj/backstage-plugin-catalog-backend-module-history',
          ].map(async name => [
            name,
            JSON.parse(
              await readFile(
                resolve(ROOT, 'node_modules', name, 'package.json'),
                'utf8',
              ),
            ).version,
          ]),
        ),
      );
      await emit({
        type: 'environment',
        node: process.version,
        packages,
        platform: process.platform,
        arch: arch(),
        cpuModel: cpus()[0]?.model,
        cpuCount: cpus().length,
        memoryBytes: totalmem(),
        sourceSha: sha,
        dirty,
        options,
        plugin: {
          queryTimeoutMs: QUERY_TIMEOUT_MS,
          readDeadlineScope: 'per SQL statement',
          writeAndLatestPluginTimeout: 'none',
          metrics: 'not installed',
        },
        fixture: {
          ownedDocker: true,
          postgresMajor: 16,
          statementTimeoutMs: STATEMENT_MS,
          acquisitionTimeoutMs: 35_000,
          poolMax: 12,
        },
        measurement: {
          samples: SAMPLES,
          warmups: WARMUPS,
          noHttpOrCatalogBackend: true,
          feedShapeScopes: {
            'feed.unfiltered.first': 'global, no filters',
            'feed.unfiltered.cursor': 'global, no filters, fixed seed cursor',
            'feed.filtered-entity':
              'entityRef, kind, provider, source, op, inclusive time range',
          },
        },
      });
      const entities = await generate(options, directory);
      await runFixture(databases, options, entities, emit);
    }, emit);
  } finally {
    await artifact.close();
    console.info(
      `History query artifact: ${resolve(directory, 'report.jsonl')}`,
    );
  }
}

// Refuse even an empty override BEFORE SDK hook registration or allocation.
ownedDockerOnly(process.env);
check(
  ['22', '24'].includes(process.versions.node.split('.')[0]),
  'Node 22 or 24 required',
);
const databases = TestDatabases.create({
  ids: ['POSTGRES_16'],
  disableDocker: false,
});
// Test watchdog only: this does not cancel SQL or extend any SQL deadline.
jest.setTimeout(600_000);

describe('history query benchmark harness invariants', () => {
  it('reports pass only after the fixture and cleanup have returned', async () => {
    // Arrange
    const events: string[] = [];
    const run = jest.fn(async () => {
      events.push('cleanup-returned');
    });
    const emit = jest.fn(async (event: Record<string, unknown>) => {
      events.push(String(event.status));
    });
    // Act
    await reportResult(run, emit);
    // Assert
    expect(events).toEqual(['cleanup-returned', 'pass']);
    expect(emit).toHaveBeenCalledWith({
      type: 'result',
      status: 'pass',
      sdkContainerCleanup: 'TestDatabases afterAll still required',
    });
  });
  it.each([false, true])(
    'preserves the fixture failure when result emission fails=%s',
    async emitFails => {
      // Arrange
      const original = new Error('fixture');
      const run = jest.fn().mockRejectedValue(original);
      const emit = jest.fn(async () => {
        if (emitFails) throw new Error('artifact');
      });
      // Act
      const result = reportResult(run, emit);
      // Assert
      await expect(result).rejects.toBe(original);
      expect(emit).toHaveBeenCalledTimes(1);
      expect(emit).toHaveBeenCalledWith({
        type: 'result',
        status: 'nonpass',
        errorType: 'Error',
      });
    },
  );
  it('rejects rather than passing when the success artifact cannot be written', async () => {
    // Arrange
    const original = new Error('success artifact');
    const emit = jest
      .fn()
      .mockRejectedValueOnce(original)
      .mockRejectedValueOnce(new Error('failure artifact'));
    // Act
    const result = reportResult(jest.fn().mockResolvedValue(undefined), emit);
    // Assert
    await expect(result).rejects.toBe(original);
    expect(emit).toHaveBeenLastCalledWith({
      type: 'result',
      status: 'nonpass',
      errorType: 'Error',
    });
  });
  it('accepts default and maximum finite workload options', () => {
    // Arrange / Act
    const defaults = optionsFromEnvironment({});
    const maximum = optionsFromEnvironment({
      HISTORY_QUERY_REFS: '20000',
      HISTORY_QUERY_REVISIONS: '10',
    });
    // Assert
    expect(defaults).toEqual({
      refs: 1000,
      revisions: 10,
      profile: 'standard',
    });
    expect(maximum.refs * maximum.revisions).toBe(200000);
  });
  it.each([
    { HISTORY_QUERY_REFS: '' },
    { HISTORY_QUERY_REFS: '0' },
    { HISTORY_QUERY_REFS: '1.1' },
    { HISTORY_QUERY_REFS: '20001' },
    { HISTORY_QUERY_REVISIONS: '1' },
    { HISTORY_QUERY_REVISIONS: '101' },
    { HISTORY_QUERY_REFS: '20000', HISTORY_QUERY_REVISIONS: '100' },
    { HISTORY_QUERY_PROFILE: 'unknown' },
    { HISTORY_QUERY_PROFILE: 'heavy', HISTORY_QUERY_REFS: '1001' },
  ])('rejects invalid or oversized workload %j', env => {
    // Arrange / Act / Assert
    expect(() => optionsFromEnvironment(env)).toThrow();
  });
  it('allows only SDK-owned database configuration', () => {
    // Arrange
    const env = {};
    // Act / Assert
    expect(() => ownedDockerOnly(env)).not.toThrow();
  });
  it.each(['', 'postgres://not-used'])(
    'refuses caller override presence %j',
    value => {
      // Arrange
      const env = {
        BACKSTAGE_TEST_DATABASE_POSTGRES16_CONNECTION_STRING: value,
      };
      // Act / Assert
      expect(() => ownedDockerOnly(env)).toThrow('override refused');
    },
  );
  it('uses literal nearest-rank p50 and p95 without interpolation', () => {
    // Arrange
    const values = Array.from({ length: 50 }, (_, i) => 50 - i);
    // Act
    const result = summary(values);
    // Assert
    expect([result.p50Ms, result.p95Ms, result.sampleCount]).toEqual([
      25, 48, 50,
    ]);
    expect(values[0]).toBe(50);
  });
  it.each([
    { values: [] },
    { values: [NaN] },
    { values: [-1] },
    { values: [Infinity] },
  ])('rejects invalid duration series %j', ({ values }) => {
    // Arrange / Act / Assert
    expect(() => summary(values)).toThrow();
  });
  it.each([1190, 8882])(
    'keeps every revision unique at exactly %i bytes',
    bytes => {
      // Arrange: representative raw entity, no generator/network dependency.
      const annotations: Record<string, string> = { [PADDING]: '' };
      const raw: Entity = {
        apiVersion: 'backstage.io/v1alpha1',
        kind: 'Component',
        metadata: {
          name: 'example',
          description: 'Synthetic project 0000001 revision 0',
          annotations,
        },
        spec: { owner: 'group:default/example' },
      };
      annotations[PADDING] = 'a'.repeat(bytes - payloadBytes(raw));
      // Act
      const entities = Array.from({ length: 150 }, (_, revision) =>
        revisionEntity(raw, revision, bytes),
      );
      // Assert
      expect(new Set(entities.map(e => entityToRow(e).etag)).size).toBe(150);
      expect(entities.every(e => payloadBytes(e) === bytes)).toBe(true);
      expect(raw.metadata.description).toMatch(/revision 0$/);
    },
  );
  it('rejects invalid revision fixtures instead of changing byte targets', () => {
    // Arrange
    const entity: Entity = {
      apiVersion: 'v1',
      kind: 'Component',
      metadata: { name: 'invalid' },
    };
    // Act / Assert
    expect(() => revisionEntity(entity, 10, 1190)).toThrow();
  });
  it.each([
    'shutdown',
    'diagnostic',
    'custom-destroy',
    'allocated-destroy',
    'none',
  ])('attempts both destroys after %s failure', async failing => {
    // Arrange
    const actions = [
      'shutdown',
      'diagnostic',
      'custom-destroy',
      'allocated-destroy',
    ].map(stage => ({
      stage,
      action: jest.fn(async () => {
        if (stage === failing) throw new Error(stage);
      }),
    }));
    const emit = jest.fn().mockResolvedValue(undefined);
    // Act
    const outcome = await cleanup(actions, emit).then(
      () => undefined,
      error => error,
    );
    // Assert
    expect(outcome).toEqual(
      failing === 'none' ? undefined : new Error(failing),
    );
    expect(actions.every(action => action.action.mock.calls.length === 1)).toBe(
      true,
    );
    expect(emit.mock.calls[0][0].status).toBe(
      failing === 'none' ? 'pools-destroyed' : 'nonpass',
    );
  });
  it('preserves the original failure when cleanup and artifact writes fail', async () => {
    // Arrange
    const original = new Error('domain');
    const destroy = jest.fn().mockRejectedValue(new Error('destroy'));
    const emit = jest.fn().mockRejectedValue(new Error('artifact'));
    // Act
    const result = cleanup(
      [
        { stage: 'custom', action: destroy },
        { stage: 'allocated', action: destroy },
      ],
      emit,
      { error: original },
    );
    // Assert
    await expect(result).rejects.toBe(original);
    expect(destroy).toHaveBeenCalledTimes(2);
  });
  it('destroys allocated resources when custom pool construction fails', async () => {
    // Arrange
    const allocated = { destroy: jest.fn().mockResolvedValue(undefined) };
    const fakeDatabases = {
      init: jest.fn().mockResolvedValue(allocated),
    } as unknown as TestDatabases;
    const original = new Error('construct');
    // Act
    const result = runFixture(
      fakeDatabases,
      optionsFromEnvironment({}),
      [],
      jest.fn().mockResolvedValue(undefined),
      () => {
        throw original;
      },
    );
    // Assert
    await expect(result).rejects.toBe(original);
    expect(allocated.destroy).toHaveBeenCalledTimes(1);
  });
  it.each(['success', 'write', 'read', 'commit'])(
    'settles the held writer on %s',
    async scenario => {
      // Arrange: fake transaction callbacks, no PostgreSQL or clocks.
      let complete = false;
      let settle!: () => void;
      const executionPromise = new Promise<void>(resolvePromise => {
        settle = resolvePromise;
      });
      const writer = {
        isCompleted: () => complete,
        executionPromise,
        commit: jest.fn(async () => {
          if (scenario === 'commit') throw new Error('commit');
          complete = true;
          settle();
        }),
        rollback: jest.fn(async () => {
          complete = true;
          settle();
        }),
      } as unknown as Writer;
      const write = jest.fn(async () => {
        if (scenario === 'write') throw new Error('write');
      });
      const read = jest.fn(async () => {
        expect(complete).toBe(false);
        if (scenario === 'read') throw new Error('read');
      });
      // Act
      const outcome = await heldWriter(writer, write, read).then(
        result => ({
          barrier: result.incompleteBeforeAndAfterReaderBatch,
          error: undefined,
        }),
        error => ({ barrier: undefined, error }),
      );
      // Assert
      expect(outcome).toEqual(
        scenario === 'success'
          ? { barrier: true, error: undefined }
          : { barrier: undefined, error: new Error(scenario) },
      );
      expect(complete).toBe(true);
      expect(writer.rollback).toHaveBeenCalledTimes(
        scenario === 'success' ? 0 : 1,
      );
    },
  );
});

it('measures public history queries on the finite owned PostgreSQL fixture', async () => {
  // Arrange: finite options and fixtures; Act: seed and measure; Assert: each
  // public response, final counts/maps and cleanup are checked by the harness.
  await expect(runBenchmark(databases)).resolves.toBeUndefined();
});
