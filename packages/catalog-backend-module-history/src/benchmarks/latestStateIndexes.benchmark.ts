/** Opt-in, owned-Docker diagnostics; not an application latency SLO. */
// Benchmark files are test-only; the dependency rule recognizes only *.test.ts.
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
import { PostgresHistoryStore } from '@kunickiaj/backstage-plugin-catalog-history-storage-node';
import { knex, type Knex } from 'knex';
import type { Client } from 'pg';
import stableStringify from 'json-stable-stringify';

// Source-only harness, never a production entry point.
// eslint-disable-next-line no-restricted-syntax
const ROOT = resolve(__dirname, '../../../..');
const executeFile = promisify(execFile);
const TABLE = 'catalog_history_entities';
const SAMPLES = 30;
const WARMUPS = 5;
const BASE_TIME = Date.parse('2026-01-01T00:00:00Z');
const PADDING = 'example.com/history-benchmark-padding';
type Emit = (event: Record<string, unknown>) => Promise<void>;
type VariantName = 'baseline' | 'global' | 'scoped' | 'combined' | 'ordered';
type Options = { refs: number; revisions: number; variants: VariantName[] };
type Source = 'provider' | 'processing';
type Scope = { name: string; provider?: string; source?: Source };
const SCOPES: Scope[] = [
  { name: 'provider-only', provider: 'bench-alpha' },
  { name: 'provider+source', provider: 'bench-alpha', source: 'provider' },
  { name: 'all/source', source: 'provider' },
  { name: 'all' },
];
const PROVENANCES: { provider: string; source: Source }[] = [
  { provider: 'bench-alpha', source: 'provider' },
  { provider: 'bench-alpha', source: 'processing' },
  { provider: 'bench-beta', source: 'provider' },
  { provider: 'bench-beta', source: 'processing' },
];
const CANDIDATES = {
  bench_latest_global: `CREATE INDEX bench_latest_global ON ${TABLE} (entity_ref ASC, changed_at DESC, id DESC) INCLUDE (provider, source, op, etag)`,
  bench_latest_provider_source: `CREATE INDEX bench_latest_provider_source ON ${TABLE} (provider, source, entity_ref ASC, changed_at DESC, id DESC) INCLUDE (op, etag)`,
  bench_latest_source: `CREATE INDEX bench_latest_source ON ${TABLE} (source, entity_ref ASC, changed_at DESC, id DESC) INCLUDE (provider, op, etag)`,
  bench_latest_ordered: `CREATE INDEX bench_latest_ordered ON ${TABLE} (entity_ref ASC, changed_at DESC, id DESC)`,
};
type IndexName = keyof typeof CANDIDATES;
const VARIANTS: { name: VariantName; indexes: IndexName[] }[] = [
  { name: 'baseline', indexes: [] },
  { name: 'global', indexes: ['bench_latest_global'] },
  {
    name: 'scoped',
    indexes: ['bench_latest_provider_source', 'bench_latest_source'],
  },
  {
    name: 'combined',
    indexes: [
      'bench_latest_global',
      'bench_latest_provider_source',
      'bench_latest_source',
    ],
  },
  { name: 'ordered', indexes: ['bench_latest_ordered'] },
];
const EXISTING = [
  'catalog_history_entities_pkey',
  'catalog_history_entities_entity_ref_changed_at_index',
  'catalog_history_entities_cycle_id_index',
  'catalog_history_entities_provider_changed_at_index',
  'catalog_history_entities_owner_partial_idx',
  'catalog_history_entities_parent_partial_idx',
  'catalog_history_entities_member_of_gin_idx',
  'catalog_history_entities_source_changed_at_index',
  'catalog_history_entities_changed_at_id_idx',
];

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
  const refs = integer('HISTORY_INDEX_REFS', '1000', 1, 20000);
  const revisions = integer('HISTORY_INDEX_REVISIONS', '100', 4, 100);
  check(refs * revisions <= 200000, 'Seed exceeds 200000 rows');
  const variants =
    env.HISTORY_INDEX_VARIANTS?.split(',') ?? VARIANTS.map(v => v.name);
  check(
    variants.every(name => VARIANTS.some(v => v.name === name)) &&
      new Set(variants).size === variants.length,
    'HISTORY_INDEX_VARIANTS must contain known unique comma-separated variant names',
  );
  return { refs, revisions, variants: variants as VariantName[] };
}
function summary(values: number[]) {
  check(
    values.length > 0 && values.every(v => Number.isFinite(v) && v >= 0),
    'Invalid durations',
  );
  const sorted = [...values].sort((a, b) => a - b);
  return {
    sampleCount: values.length,
    durationsMs: values,
    p50Ms: sorted[Math.ceil(values.length * 0.5) - 1],
    p95Ms: sorted[Math.ceil(values.length * 0.95) - 1],
    percentileMethod: 'nearest-rank ceil(p*n)-1; no interpolation',
  };
}
function hash(value: unknown) {
  return createHash('sha256')
    .update(stableStringify(value) ?? 'undefined')
    .digest('hex');
}
function errorType(error: unknown) {
  return error instanceof Error ? error.constructor.name : typeof error;
}
type Event = {
  ref: string;
  provider: string;
  source: Source;
  timestamp: number;
  ordinal: number;
  op: 'insert' | 'update' | 'delete';
  etag: string | null;
};
type Oracle = Map<string, Map<string, Event>>;
function createOracle(): Oracle {
  return new Map(SCOPES.map(s => [s.name, new Map()]));
}
/** Scope first, choose by timestamp/ordinal, filter delete/null only on output. */
function append(oracle: Oracle, event: Event) {
  for (const scope of SCOPES) {
    if (scope.provider && scope.provider !== event.provider) continue;
    if (scope.source && scope.source !== event.source) continue;
    const map = oracle.get(scope.name)!;
    const previous = map.get(event.ref);
    if (
      !previous ||
      event.timestamp > previous.timestamp ||
      (event.timestamp === previous.timestamp &&
        event.ordinal > previous.ordinal)
    )
      map.set(event.ref, event);
  }
}
function expectedMap(oracle: Oracle, scope: Scope) {
  const map = new Map<string, unknown>();
  for (const event of oracle.get(scope.name)!.values()) {
    if (event.op === 'delete' || event.etag === null) continue;
    map.set(
      event.ref,
      scope.provider
        ? event.etag
        : { etag: event.etag, provider: event.provider },
    );
  }
  return map;
}
function assertMap(
  actual: Map<string, unknown>,
  expected: Map<string, unknown>,
) {
  check(actual.size === expected.size, 'Latest map size mismatch');
  for (const [ref, value] of expected)
    check(
      hash(actual.get(ref)) === hash(value),
      'Latest map content/provenance mismatch',
    );
}
function callLatest(
  store: PostgresHistoryStore,
  scope: Scope,
): Promise<Map<string, unknown>> {
  if (scope.provider)
    return store.loadCurrentEtags(scope.provider, { source: scope.source });
  return store.loadAllCurrentEtags({ source: scope.source });
}

// Only numeric metrics and named node/index/sort enums survive. No SQL, binds,
// predicates, output columns, aliases, relation names or arbitrary nested keys.
const PLAN_NUMBERS = [
  'Actual Rows',
  'Actual Loops',
  'Actual Startup Time',
  'Actual Total Time',
  'Startup Cost',
  'Total Cost',
  'Plan Rows',
  'Plan Width',
  'Planning Time',
  'Execution Time',
  'Shared Hit Blocks',
  'Shared Read Blocks',
  'Shared Dirtied Blocks',
  'Shared Written Blocks',
  'Local Hit Blocks',
  'Local Read Blocks',
  'Temp Read Blocks',
  'Temp Written Blocks',
  'Sort Space Used',
  'Heap Fetches',
];
function sanitizePlan(raw: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const key of PLAN_NUMBERS)
    if (typeof raw[key] === 'number') result[key] = raw[key];
  for (const key of ['Node Type', 'Sort Method', 'Sort Space Type']) {
    if (typeof raw[key] === 'string' && /^[a-zA-Z -]{1,80}$/.test(raw[key]))
      result[key] = raw[key];
  }
  if (
    typeof raw['Index Name'] === 'string' &&
    [...EXISTING, ...Object.keys(CANDIDATES)].includes(raw['Index Name'])
  )
    result['Index Name'] = raw['Index Name'];
  if (raw.Plan && typeof raw.Plan === 'object')
    result.Plan = sanitizePlan(raw.Plan as Record<string, unknown>);
  if (Array.isArray(raw.Plans)) result.Plans = raw.Plans.map(sanitizePlan);
  return result;
}

async function measure(
  call: () => Promise<unknown>,
  label: string,
  emit: Emit,
) {
  const start = performance.now();
  try {
    const result = await call();
    return { result, durationMs: performance.now() - start };
  } catch (error) {
    try {
      await emit({
        type: 'sample-failure',
        label,
        durationMs: performance.now() - start,
        status: 'nonpass',
        errorType: errorType(error),
      });
    } catch {
      /* preserve original */
    }
    throw error;
  }
}
type CleanupAction = { stage: string; action: () => Promise<unknown> };
async function cleanup(
  actions: CleanupAction[],
  emit: Emit,
  prior?: { error: unknown },
) {
  const failures: { stage: string; error: unknown }[] = [];
  for (const action of actions) {
    try {
      await action.action();
    } catch (error) {
      failures.push({ stage: action.stage, error });
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
        'SDK afterAll still required; not yet claimed complete',
    });
  } catch (error) {
    failures.push({ stage: 'cleanup-artifact', error });
  }
  if (prior) throw prior.error;
  if (failures.length) throw failures[0].error;
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
        client.query("SET statement_timeout = '30000ms'", error =>
          done(error, client),
        );
      },
    },
    acquireConnectionTimeout: 35000,
  });
}
function revisionRows(entities: Entity[], revision: number): EntityRow[] {
  return entities.map(entity => {
    const padding = entity.metadata.annotations?.[PADDING];
    const description = entity.metadata.description;
    check(
      padding && description && description.endsWith('revision 0'),
      'Invalid baseline fixture',
    );
    const revised = {
      ...entity,
      metadata: {
        ...entity.metadata,
        description: description.replace(/revision 0$/, `revision ${revision}`),
        annotations: {
          ...entity.metadata.annotations,
          [PADDING]: padding.slice(
            0,
            padding.length - (String(revision).length - 1),
          ),
        },
      },
    };
    check(
      Buffer.byteLength(JSON.stringify(revised.metadata)) +
        Buffer.byteLength(JSON.stringify(revised.spec)) ===
        1190,
      'Payload byte drift',
    );
    return entityToRow(revised);
  });
}
function cycle(rows: EntityRow[], revision: number): CycleInput {
  const time = new Date(BASE_TIME + revision * 1000);
  return {
    cycleId: randomUUID(),
    ...PROVENANCES[revision % 4],
    mutationType: 'full',
    startedAt: time,
    finishedAt: time,
    inserts: revision === 0 ? rows : [],
    updates: revision === 0 ? [] : rows,
    deletes: [],
    unchangedCount: 0,
  };
}
function applyCycle(oracle: Oracle, input: CycleInput, ordinal: number) {
  let next = ordinal;
  for (const row of [...input.inserts, ...input.updates])
    append(oracle, {
      ref: row.entityRef,
      provider: input.provider,
      source: input.source as Source,
      timestamp: input.finishedAt.getTime(),
      ordinal: ++next,
      op: input.inserts.length ? 'insert' : 'update',
      etag: row.etag,
    });
  for (const ref of input.deletes)
    append(oracle, {
      ref,
      provider: input.provider,
      source: input.source as Source,
      timestamp: input.finishedAt.getTime(),
      ordinal: ++next,
      op: 'delete',
      etag: null,
    });
  return next;
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
      'standard',
      '--stage',
      'initial',
      '--output',
      output,
    ],
    { timeout: 30000 },
  );
  const entities = (await readFile(output, 'utf8'))
    .trim()
    .split('\n')
    .map(line => JSON.parse(line) as Entity);
  check(entities.length === options.refs, 'Generator count mismatch');
  return entities;
}

/** Exact public query shape; equality to captured public SQL is checked below. */
function latestSql(db: Knex, scope: Scope) {
  const columns = scope.provider
    ? ['entity_ref', 'op', 'etag']
    : ['entity_ref', 'op', 'etag', 'provider'];
  const latest = db(TABLE)
    .select(...columns)
    .distinctOn('entity_ref');
  if (scope.provider) latest.where({ provider: scope.provider });
  latest
    .orderBy('entity_ref')
    .orderBy('changed_at', 'desc')
    .orderBy('id', 'desc');
  if (scope.source) latest.where('source', scope.source);
  const output = scope.provider
    ? ['entity_ref', 'etag']
    : ['entity_ref', 'etag', 'provider'];
  return db
    .with('latest', latest)
    .from('latest')
    .where('op', '!=', 'delete')
    .select(...output);
}
async function explain(
  db: Knex,
  store: PostgresHistoryStore,
  scope: Scope,
  oracle: Oracle,
  phase: string,
  emit: Emit,
) {
  const captured: { sql: string; bindings?: readonly unknown[] }[] = [];
  const listener = (query: { sql: string; bindings?: readonly unknown[] }) => {
    captured.push(query);
  };
  db.on('query', listener);
  try {
    assertMap(await callLatest(store, scope), expectedMap(oracle, scope));
  } finally {
    db.removeListener('query', listener);
  }
  const builder = latestSql(db, scope);
  const native = builder.toSQL().toNative();
  const normalize = (sql: string) => sql.replace(/\s+/g, ' ').trim();
  check(
    captured.length === 1 &&
      normalize(captured[0].sql) === normalize(native.sql) &&
      hash(captured[0].bindings) === hash(native.bindings),
    'EXPLAIN/public SQL mismatch',
  );
  const query = builder.toSQL();
  const result = await db.raw(
    `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${query.sql}`,
    query.bindings,
  );
  await emit({
    type: 'plan',
    phase,
    scope: scope.name,
    sqlShapeSha256: hash(normalize(native.sql)),
    matchedPublicSqlAndBindings: true,
    latency: 'EXPLAIN execution/planning only; not public-method latency',
    plan: sanitizePlan(result.rows[0]['QUERY PLAN'][0]),
  });
}
async function validateMaps(
  store: PostgresHistoryStore,
  oracle: Oracle,
  emit: Emit,
) {
  for (const scope of SCOPES) {
    const expected = expectedMap(oracle, scope);
    assertMap(await callLatest(store, scope), expected);
    await emit({
      type: 'map-validated',
      scope: scope.name,
      count: expected.size,
      sha256: hash([...expected].sort()),
    });
  }
}
async function counts(db: Knex, rows: number, cycles: number) {
  const row = await db(TABLE).count('* as count').first();
  const cycleRow = await db('catalog_history_cycles')
    .count('* as count')
    .first();
  check(
    Number(row?.count) === rows && Number(cycleRow?.count) === cycles,
    'Row/cycle count mismatch',
  );
  return { rows, cycles };
}
async function inventory(db: Knex) {
  const result = await db.raw(
    `SELECT c.relname AS name, pg_get_indexdef(i.indexrelid) AS definition, i.indisvalid AS valid, i.indisready AS ready, pg_relation_size(i.indexrelid)::text AS bytes FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid WHERE i.indrelid=?::regclass ORDER BY c.relname`,
    [TABLE],
  );
  for (const name of EXISTING)
    check(
      result.rows.some(
        (r: { name: string; valid: boolean; ready: boolean }) =>
          r.name === name && r.valid && r.ready,
      ),
      'Missing/invalid existing index',
    );
  return result.rows as {
    name: string;
    definition: string;
    valid: boolean;
    ready: boolean;
    bytes: string;
  }[];
}
async function sizes(db: Knex, phase: string, emit: Emit) {
  const indexes = await inventory(db);
  const result = await db.raw(
    `SELECT relname AS relation, pg_relation_size(oid)::text AS heap_bytes, pg_indexes_size(oid)::text AS index_bytes, CASE WHEN reltoastrelid=0 THEN '0' ELSE pg_total_relation_size(reltoastrelid)::text END AS toast_total_bytes, pg_total_relation_size(oid)::text AS total_bytes FROM pg_class WHERE oid IN ('catalog_history_entities'::regclass, 'catalog_history_cycles'::regclass) ORDER BY relname`,
  );
  await emit({
    type: 'sizes',
    phase,
    indexes,
    addedIndexBytes: indexes
      .filter(i => Object.hasOwn(CANDIDATES, i.name))
      .reduce((sum, i) => sum + Number(i.bytes), 0),
    relations: result.rows,
  });
}
async function statistics(db: Knex, phase: string, emit: Emit) {
  const result = await db('pg_stat_user_tables')
    .select(
      'relname',
      'last_vacuum',
      'last_autovacuum',
      'vacuum_count',
      'autovacuum_count',
      'last_analyze',
      'last_autoanalyze',
      'analyze_count',
      'autoanalyze_count',
      'n_live_tup',
      'n_dead_tup',
    )
    .where('relname', TABLE);
  await emit({
    type: 'table-statistics',
    phase,
    values: result,
    autovacuum:
      'default; not disabled; timestamps/counts are observed, not a visibility guarantee',
  });
}
async function buildIndexes(db: Knex, indexes: IndexName[], emit: Emit) {
  for (const name of indexes) {
    const start = performance.now();
    await db.raw(CANDIDATES[name]);
    const buildMs = performance.now() - start;
    const installed = (await inventory(db)).find(i => i.name === name);
    check(installed?.valid && installed.ready, 'Candidate invalid');
    await emit({
      type: 'index-built',
      name,
      safeDdl: CANDIDATES[name],
      buildMs,
      populatedTable: true,
      installed,
    });
  }
}
async function readPhase(
  db: Knex,
  store: PostgresHistoryStore,
  oracle: Oracle,
  phase: string,
  emit: Emit,
) {
  const samples = new Map(SCOPES.map(s => [s.name, [] as number[]]));
  for (let round = -WARMUPS; round < SAMPLES; round++) {
    for (const scope of SCOPES) {
      const timed = await measure(
        () => callLatest(store, scope),
        `${phase}/${scope.name}/${round}`,
        emit,
      );
      // Validation, map hashing and artifact writes are outside the timer.
      try {
        assertMap(
          timed.result as Map<string, unknown>,
          expectedMap(oracle, scope),
        );
      } catch (error) {
        try {
          await emit({
            type: 'sample-validation-failure',
            status: 'nonpass',
            phase,
            scope: scope.name,
            round,
            durationMs: timed.durationMs,
            errorType: errorType(error),
          });
        } catch {
          /* preserve original */
        }
        throw error;
      }
      if (round >= 0) {
        samples.get(scope.name)!.push(timed.durationMs);
        await emit({
          type: 'read-sample',
          phase,
          scope: scope.name,
          round,
          durationMs: timed.durationMs,
        });
      }
    }
  }
  for (const scope of SCOPES) {
    await emit({
      type: 'read-samples',
      phase,
      scope: scope.name,
      ...summary(samples.get(scope.name)!),
      warmupsExcluded: WARMUPS,
      order: 'paired fixed scope order each round',
      includes: 'public method, pool acquisition, SQL, result mapping',
    });
    await explain(db, store, scope, oracle, phase, emit);
  }
}
async function diagnostics(db: Knex, emit: Emit) {
  const activity = await db.raw(
    'SELECT state, count(*)::int AS count FROM pg_stat_activity WHERE datname=current_database() AND pid <> pg_backend_pid() GROUP BY state',
  );
  const pool = db.client.pool;
  const state = {
    used: pool.numUsed(),
    free: pool.numFree(),
    pendingAcquires: pool.numPendingAcquires(),
    pendingCreates: pool.numPendingCreates(),
  };
  await emit({
    type: 'post-shutdown-diagnostics',
    activity: activity.rows,
    pool: state,
  });
  check(
    state.used === 0 &&
      state.pendingAcquires === 0 &&
      state.pendingCreates === 0 &&
      activity.rows.every((r: { state: string }) => r.state === 'idle'),
    'Owned pool/database not idle',
  );
}

/** Every allocation gets its own logical database in the SDK-owned container. */
async function ownedDatabase(
  databases: TestDatabases,
  emit: Emit,
  run: (db: Knex, store: PostgresHistoryStore) => Promise<void>,
) {
  ownedDockerOnly(process.env);
  const allocated = await databases.init('POSTGRES_16');
  let db: Knex | undefined;
  let store: PostgresHistoryStore | undefined;
  let prior: { error: unknown } | undefined;
  try {
    db = fixturePool(allocated);
    store = new PostgresHistoryStore(db, { queryTimeoutMs: 10000 });
    await store.ensureReady();
    const version = await db.raw('SHOW server_version');
    check(
      String(version.rows[0].server_version).startsWith('16.'),
      'PostgreSQL 16 required',
    );
    const settings = await db('pg_settings')
      .select('name', 'setting', 'unit')
      .whereIn('name', [
        'work_mem',
        'shared_buffers',
        'synchronous_commit',
        'statement_timeout',
        'autovacuum',
      ]);
    await emit({
      type: 'database-environment',
      postgresVersion: version.rows[0].server_version,
      settings,
    });
    await run(db, store);
  } catch (error) {
    prior = { error };
    try {
      await emit({
        type: 'database-failure',
        status: 'nonpass',
        errorType: errorType(error),
      });
    } catch {
      /* preserve original */
    }
  } finally {
    await cleanup(
      [
        { stage: 'store.shutdown', action: async () => store?.shutdown() },
        {
          stage: 'post-shutdown-diagnostics',
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

/** Probe an opaque public etag, not a universal PostgreSQL entry-size threshold. */
async function indexWidthCompatibilityProbe(
  databases: TestDatabases,
  emit: Emit,
) {
  await ownedDatabase(databases, emit, async (db, store) => {
    // SHA-256 blocks avoid a repeated, readily compressible oversized fixture.
    const etag = Array.from({ length: 79 }, (_, block) =>
      createHash('sha256')
        .update(`latest-index-width-probe-${block}`)
        .digest('hex'),
    )
      .join('')
      .slice(0, 5000);
    const entity: Entity = {
      apiVersion: 'backstage.io/v1alpha1',
      kind: 'Component',
      metadata: { name: 'opaque-etag-probe' },
      spec: {
        type: 'service',
        lifecycle: 'experimental',
        owner: 'group:default/benchmark',
      },
    };
    const row = { ...entityToRow(entity), etag };
    const input = cycle([row], 0);
    await store.recordCycle(input);
    check(
      (
        await store.loadCurrentEtags(input.provider, { source: 'provider' })
      ).get(row.entityRef) === etag &&
        (await store.loadAllCurrentEtags()).get(row.entityRef)?.etag === etag,
      'Baseline did not preserve the opaque public etag',
    );
    await buildIndexes(db, ['bench_latest_ordered'], emit);
    check(
      (await store.loadCurrentEtags(input.provider)).get(row.entityRef) ===
        etag,
      'Ordering-only index did not preserve the opaque public etag',
    );
    let coveringOutcome: Record<string, unknown> = {
      classification: 'BUILD_SUCCEEDED_AT_PROBED_WIDTH',
      coveringBuildSucceeded: true,
    };
    try {
      // A standalone statement: expected failure cannot poison an outer transaction.
      await db.raw(CANDIDATES.bench_latest_global);
    } catch (error) {
      const code =
        typeof error === 'object' && error !== null && 'code' in error
          ? error.code
          : undefined;
      if (code !== '54000') throw error;
      coveringOutcome = {
        classification: 'COMPATIBILITY_RISK',
        coveringBuildSucceeded: false,
        errorCode: code,
        errorType: errorType(error),
      };
    }
    const installed = await inventory(db);
    check(
      installed.some(
        index =>
          index.name === 'bench_latest_ordered' && index.valid && index.ready,
      ),
      'Ordering-only probe index missing or invalid',
    );
    check(
      (await store.loadAllCurrentEtags()).get(row.entityRef)?.etag === etag,
      'Compatibility probe changed the stored opaque etag',
    );
    await emit({
      type: 'index-width-compatibility-probe',
      status: 'pass',
      etagAsciiBytes: Buffer.byteLength(etag),
      baselinePublicWriteAndExactRead: true,
      orderingOnlyBuildSucceeded: true,
      ...coveringOutcome,
      ...(await counts(db, 1, 1)),
      scope:
        'one deterministic opaque public etag on the recorded PostgreSQL 16 server; not a universal size threshold or an all-inputs compatibility claim',
    });
  });
}

async function semanticFixture(
  databases: TestDatabases,
  emit: Emit,
  entity: Entity,
) {
  await ownedDatabase(databases, emit, async (db, store) => {
    const row = entityToRow(entity);
    const oracle = createOracle();
    let ordinal = 0;
    const commit = async (
      revision: number,
      provenance: number,
      op: 'insert' | 'update' | 'delete',
      time: number,
    ) => {
      const input = {
        ...cycle([{ ...row, etag: `semantic-${revision}` }], revision),
        ...PROVENANCES[provenance],
        finishedAt: new Date(BASE_TIME + time),
        inserts: [],
        updates: [],
        deletes: [],
      } as CycleInput;
      if (op === 'insert')
        input.inserts = [{ ...row, etag: `semantic-${revision}` }];
      if (op === 'update')
        input.updates = [{ ...row, etag: `semantic-${revision}` }];
      if (op === 'delete') input.deletes = [row.entityRef];
      await store.recordCycle(input);
      ordinal = applyCycle(oracle, input, ordinal);
      return input;
    };
    await commit(0, 0, 'insert', 1000);
    await commit(1, 2, 'update', 2000);
    // A later ID with an older timestamp must not win.
    await commit(2, 1, 'update', 500);
    await validateMaps(store, oracle, emit);
    check(
      (await store.loadAllCurrentEtags()).get(row.entityRef)?.provider ===
        'bench-beta',
      'Timestamp order semantic mismatch',
    );
    await commit(3, 1, 'update', 2000);
    await validateMaps(store, oracle, emit);
    check(
      (await store.loadAllCurrentEtags()).get(row.entityRef)?.etag ===
        'semantic-3',
      'ID tie semantic mismatch',
    );
    await commit(4, 2, 'delete', 3000);
    await validateMaps(store, oracle, emit);
    check(
      (await store.loadAllCurrentEtags()).size === 0 &&
        (
          await store.loadCurrentEtags('bench-alpha', { source: 'provider' })
        ).get(row.entityRef) === 'semantic-0',
      'Delete/scope semantic mismatch',
    );
    await commit(5, 0, 'insert', 4000);
    await validateMaps(store, oracle, emit);
    const ledger = await commit(6, 3, 'update', 4500);
    // NULL etag on a non-delete is outside public EntityRow's contract. Only
    // this tiny SQL fixture inserts it; no contract or schema is weakened.
    await db(TABLE).insert({
      cycle_id: ledger.cycleId,
      entity_ref: row.entityRef,
      kind: row.kind,
      namespace: row.namespace,
      name: row.name,
      provider: ledger.provider,
      source: ledger.source,
      changed_at: new Date(BASE_TIME + 5000),
      op: 'update',
      etag: null,
    });
    append(oracle, {
      ref: row.entityRef,
      provider: ledger.provider,
      source: ledger.source as Source,
      timestamp: BASE_TIME + 5000,
      ordinal: ++ordinal,
      op: 'update',
      etag: null,
    });
    for (const variant of VARIANTS) {
      // Add cumulatively only in this tiny semantic DB; timing databases are fresh.
      const installed = await inventory(db);
      await buildIndexes(
        db,
        variant.indexes.filter(name => !installed.some(i => i.name === name)),
        emit,
      );
      await validateMaps(store, oracle, emit);
      check(
        (await store.loadAllCurrentEtags()).size === 0 &&
          (await store.loadCurrentEtags('bench-alpha')).get(row.entityRef) ===
            'semantic-5',
        'NULL/scope semantic mismatch',
      );
    }
    await emit({
      type: 'semantic-fixture',
      status: 'pass',
      cases: [
        'competing provenance',
        'scope before selection',
        'timestamp before ID',
        'equal timestamp ID DESC',
        'delete after latest',
        'reinsert',
        'non-delete NULL etag after latest',
      ],
      layoutNote:
        'baseline, global, scoped, combined, ordered traversed cumulatively in this tiny DB, ending with all four candidate indexes; timed selected variants each fresh',
    });
  });
}

async function runVariant(
  databases: TestDatabases,
  variant: (typeof VARIANTS)[number],
  options: Options,
  entities: Entity[],
  emit: Emit,
) {
  await ownedDatabase(databases, emit, async (db, store) => {
    const oracle = createOracle();
    let ordinal = 0;
    await emit({ type: 'installed-before-seed', indexes: await inventory(db) });
    for (let revision = 0; revision < options.revisions; revision++) {
      const input = cycle(revisionRows(entities, revision), revision);
      await measure(() => store.recordCycle(input), `seed/${revision}`, emit);
      ordinal = applyCycle(oracle, input, ordinal);
    }
    await validateMaps(store, oracle, emit);
    const invalid = await db.raw(
      `SELECT count(*)::int AS count FROM (SELECT entity_ref FROM catalog_history_entities GROUP BY entity_ref HAVING count(*) <> ? OR count(DISTINCT etag) <> ?) invalid`,
      [options.revisions, options.revisions],
    );
    check(invalid.rows[0].count === 0, 'Seed revisions/unique etags mismatch');
    const totals = await db('catalog_history_cycles')
      .sum({
        added: 'n_added',
        modified: 'n_modified',
        removed: 'n_removed',
        unchanged: 'n_unchanged',
      })
      .first();
    check(
      Number(totals?.added) === options.refs &&
        Number(totals?.modified) === options.refs * (options.revisions - 1) &&
        Number(totals?.removed) === 0 &&
        Number(totals?.unchanged) === 0,
      'Seed ledger totals mismatch',
    );
    await emit({
      type: 'seed-validated',
      ...(await counts(
        db,
        options.refs * options.revisions,
        options.revisions,
      )),
      cycleTotals: totals,
      payloadBytes: 1190,
      candidateIndexesDuringSeed: 0,
      cost: 'seed excluded from candidate write cost',
    });
    await buildIndexes(db, variant.indexes, emit);
    await sizes(db, 'after-build', emit);
    // Outside any transaction, same explicit visibility preparation for all.
    await db.raw('VACUUM (ANALYZE) catalog_history_entities');
    await statistics(db, 'vacuum-analyzed-before-reads', emit);
    await readPhase(db, store, oracle, 'vacuum-analyzed', emit);
    await statistics(db, 'before-writes', emit);
    const durations: number[] = [];
    const width = Math.min(100, options.refs);
    for (let round = 0; round < SAMPLES; round++) {
      const input = cycle(
        revisionRows(entities.slice(0, width), options.revisions + round),
        options.revisions + round,
      );
      const timed = await measure(
        () => store.recordCycle(input),
        `committed-write/${round}`,
        emit,
      );
      durations.push(timed.durationMs);
      ordinal = applyCycle(oracle, input, ordinal);
      await emit({
        type: 'write-sample',
        round,
        durationMs: timed.durationMs,
        rows: width,
      });
    }
    await emit({
      type: 'normal-committed-write-samples',
      ...summary(durations),
      cycles: SAMPLES,
      rowsPerCycle: width,
      mappingExcluded: true,
      includes:
        'recordCycle acknowledgement including normal transaction and commit',
      heldWriterBarrier: false,
    });
    await validateMaps(store, oracle, emit);
    await readPhase(
      db,
      store,
      oracle,
      'fresh committed writes; no manual vacuum after write phase',
      emit,
    );
    await statistics(db, 'after-write-reads', emit);
    await sizes(db, 'after-writes', emit);
    await emit({
      type: 'final-validated',
      ...(await counts(
        db,
        options.refs * options.revisions + SAMPLES * width,
        options.revisions + SAMPLES,
      )),
    });
    await validateMaps(store, oracle, emit);
  });
}

async function environment(options: Options, emit: Emit) {
  const sourceSha = (
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
    platform: process.platform,
    arch: arch(),
    cpuModel: cpus()[0]?.model,
    cpuCount: cpus().length,
    hostMemoryBytes: totalmem(),
    containerCpuQuota: 'unknown',
    containerMemoryQuotaBytes: 'unknown',
    sourceSha,
    dirty,
    packages,
    options,
    variants: VARIANTS,
    selectedMatrix: VARIANTS.filter(v => options.variants.includes(v.name)),
    scopes: SCOPES,
    pluginQueryTimeoutMs: 10000,
    latestPluginDeadline: 'none (unchanged public methods)',
    fixtureStatementTimeoutMs: 30000,
    fixtureAcquireTimeoutMs: 35000,
    poolMax: 12,
    samples: SAMPLES,
    warmupsExcluded: WARMUPS,
    watchdogMs: 900000,
    watchdog: 'test watchdog only; not application SLO or SQL deadline',
    scope: 'OUR store only; no HTTP, catalog backend or upstream tests',
    settledVisibility:
      'VACUUM ANALYZE before first phase; no manual vacuum or analyze after writes; default autovacuum may run',
  });
}
async function runBenchmark(databases: TestDatabases) {
  const options = optionsFromEnvironment(process.env);
  const directory = resolve(ROOT, '.tmp/latest-state-indexes', randomUUID());
  await mkdir(directory, { recursive: true });
  const artifact = await open(resolve(directory, 'report.jsonl'), 'wx');
  const emit: Emit = async event => {
    await artifact.write(`${JSON.stringify(event)}\n`);
  };
  let stage = 'environment';
  try {
    await environment(options, emit);
    stage = 'generation';
    const entities = await generate(options, directory);
    stage = 'index-width-compatibility-probe';
    await indexWidthCompatibilityProbe(databases, emit);
    stage = 'semantic-fixture';
    await semanticFixture(databases, emit, entities[0]);
    for (const variant of VARIANTS.filter(v =>
      options.variants.includes(v.name),
    )) {
      stage = variant.name;
      const variantEmit: Emit = event =>
        emit({ ...event, variant: variant.name });
      await runVariant(databases, variant, options, entities, variantEmit);
      await variantEmit({
        type: 'variant-result',
        status: 'pass',
        poolsDestroyed: true,
      });
    }
    await emit({
      type: 'result',
      status: 'pass',
      poolsDestroyed: true,
      sdkContainerCleanup:
        'SDK afterAll still required; not yet claimed complete',
    });
  } catch (error) {
    try {
      await emit({
        type: 'result',
        status: 'nonpass',
        stage,
        errorType: errorType(error),
      });
    } catch {
      /* preserve original */
    }
    throw error;
  } finally {
    await artifact.close();
    console.info(
      `Latest-state index artifact: ${resolve(directory, 'report.jsonl')}`,
    );
  }
}

// Presence, including an empty value, is refused before SDK hook registration.
ownedDockerOnly(process.env);
optionsFromEnvironment(process.env);
check(
  ['22', '24'].includes(process.versions.node.split('.')[0]),
  'Node 22 or 24 required',
);
const databases = TestDatabases.create({
  ids: ['POSTGRES_16'],
  disableDocker: false,
});
jest.setTimeout(900000);

describe('latest-state index harness invariants', () => {
  it('accepts default and maximum finite options', () => {
    // Arrange / Act
    const defaults = optionsFromEnvironment({});
    const maximum = optionsFromEnvironment({
      HISTORY_INDEX_REFS: '20000',
      HISTORY_INDEX_REVISIONS: '10',
    });
    // Assert
    expect([defaults, maximum]).toEqual([
      {
        refs: 1000,
        revisions: 100,
        variants: ['baseline', 'global', 'scoped', 'combined', 'ordered'],
      },
      {
        refs: 20000,
        revisions: 10,
        variants: ['baseline', 'global', 'scoped', 'combined', 'ordered'],
      },
    ]);
  });
  it('selects only known requested variants without adding ordered to combined', () => {
    // Arrange
    const env = { HISTORY_INDEX_VARIANTS: 'combined,ordered' };
    // Act
    const options = optionsFromEnvironment(env);
    const selected = VARIANTS.filter(v => options.variants.includes(v.name));
    // Assert
    expect(selected).toEqual([
      {
        name: 'combined',
        indexes: [
          'bench_latest_global',
          'bench_latest_provider_source',
          'bench_latest_source',
        ],
      },
      { name: 'ordered', indexes: ['bench_latest_ordered'] },
    ]);
  });
  it.each([
    '',
    'unknown',
    'ordered,ordered',
    'ordered,',
    ',ordered',
    ' ordered',
  ])('rejects invalid variant list %j', variants => {
    // Arrange
    const env = { HISTORY_INDEX_VARIANTS: variants };
    // Act / Assert
    expect(() => optionsFromEnvironment(env)).toThrow('HISTORY_INDEX_VARIANTS');
  });
  it.each([
    { HISTORY_INDEX_REFS: '' },
    { HISTORY_INDEX_REFS: '0' },
    { HISTORY_INDEX_REFS: '1.5' },
    { HISTORY_INDEX_REFS: '20001' },
    { HISTORY_INDEX_REVISIONS: '3' },
    { HISTORY_INDEX_REVISIONS: '101' },
    { HISTORY_INDEX_REFS: '20000', HISTORY_INDEX_REVISIONS: '100' },
  ])('rejects invalid workload %j', env => {
    // Arrange / Act / Assert
    expect(() => optionsFromEnvironment(env)).toThrow();
  });
  it('permits only absent external override', () => {
    // Arrange / Act / Assert
    expect(() => ownedDockerOnly({})).not.toThrow();
  });
  it.each(['', 'postgres://not-used'])(
    'refuses override presence %j',
    value => {
      // Arrange
      const env = {
        BACKSTAGE_TEST_DATABASE_POSTGRES16_CONNECTION_STRING: value,
      };
      // Act / Assert
      expect(() => ownedDockerOnly(env)).toThrow('override refused');
    },
  );
  it('uses nearest rank without mutating raw samples', () => {
    // Arrange
    const values = Array.from({ length: 30 }, (_, i) => 30 - i);
    // Act
    const result = summary(values);
    // Assert
    expect([result.p50Ms, result.p95Ms, values[0]]).toEqual([15, 29, 30]);
  });
  it.each([[], [-1], [NaN], [Infinity]])(
    'rejects invalid series %j',
    (...values) => {
      // Arrange / Act / Assert
      expect(() => summary(values as number[])).toThrow();
    },
  );
  it('keeps provenance, timestamp/ID order and scope before filtering delete/null', () => {
    // Arrange
    const oracle = createOracle();
    const base: Event = {
      ref: 'component:default/a',
      ...PROVENANCES[0],
      timestamp: 10,
      ordinal: 1,
      op: 'insert',
      etag: 'first',
    };
    // Act
    append(oracle, base);
    append(oracle, {
      ...base,
      ...PROVENANCES[2],
      timestamp: 20,
      ordinal: 2,
      etag: 'beta',
    });
    append(oracle, { ...base, timestamp: 5, ordinal: 3, etag: 'older' });
    // Assert
    expect([...expectedMap(oracle, SCOPES[3])]).toEqual([
      [base.ref, { provider: 'bench-beta', etag: 'beta' }],
    ]);
    expect([...expectedMap(oracle, SCOPES[0])]).toEqual([[base.ref, 'first']]);
  });
  it.each(['delete', 'null', 'tie', 'reinsert'])(
    'handles latest %s without resurrecting earlier values',
    scenario => {
      // Arrange
      const oracle = createOracle();
      const base: Event = {
        ref: 'x',
        ...PROVENANCES[0],
        timestamp: 10,
        ordinal: 1,
        op: 'insert',
        etag: 'first',
      };
      append(oracle, base);
      const event: Event = {
        ...base,
        ...PROVENANCES[3],
        ordinal: 2,
        op: 'update',
        etag: 'second',
      };
      if (scenario === 'delete' || scenario === 'reinsert') event.op = 'delete';
      if (scenario === 'null') event.etag = null;
      // Act
      append(oracle, event);
      if (scenario === 'reinsert')
        append(oracle, { ...base, ordinal: 3, etag: 'back' });
      // Assert
      const expected = new Map<string, unknown>();
      if (scenario === 'tie')
        expected.set('x', { etag: 'second', provider: 'bench-beta' });
      if (scenario === 'reinsert')
        expected.set('x', { etag: 'back', provider: 'bench-alpha' });
      expect(expectedMap(oracle, SCOPES[3])).toEqual(expected);
      expect(expectedMap(oracle, SCOPES[1]).get('x')).toBe(
        scenario === 'reinsert' ? 'back' : 'first',
      );
    },
  );
  it('retains safe plan metrics but strips raw SQL, predicates and arbitrary nested data', () => {
    // Arrange
    const raw = {
      'Execution Time': 2,
      SQL: 'private',
      Plan: {
        'Node Type': 'Index Only Scan',
        'Index Name': 'bench_latest_global',
        'Heap Fetches': 3,
        'Index Cond': 'private',
        Filter: 'private',
        Output: ['private'],
        Plans: [
          {
            'Node Type': 'Sort',
            'Sort Method': 'external merge',
            'Temp Written Blocks': 4,
            'Sort Space Type': 'Disk',
            'Sort Space Used': 5,
            Alias: 'private',
          },
        ],
      },
    };
    // Act
    const result = sanitizePlan(raw);
    // Assert
    expect(result).toEqual({
      'Execution Time': 2,
      Plan: {
        'Node Type': 'Index Only Scan',
        'Index Name': 'bench_latest_global',
        'Heap Fetches': 3,
        Plans: [
          {
            'Node Type': 'Sort',
            'Sort Method': 'external merge',
            'Temp Written Blocks': 4,
            'Sort Space Type': 'Disk',
            'Sort Space Used': 5,
          },
        ],
      },
    });
    expect(
      sanitizePlan({ 'Index Name': 'private', 'Actual Rows': 'private' }),
    ).toEqual({});
  });
  it.each(['none', 'shutdown', 'diagnostics', 'custom', 'allocated'])(
    'attempts all cleanup actions after %s failure',
    async failing => {
      // Arrange
      const actions = ['shutdown', 'diagnostics', 'custom', 'allocated'].map(
        stage => ({
          stage,
          action: jest.fn(async () => {
            if (stage === failing) throw new Error(stage);
          }),
        }),
      );
      const emit = jest.fn().mockResolvedValue(undefined);
      // Act
      const result = await cleanup(actions, emit).then(
        () => undefined,
        error => error,
      );
      // Assert
      expect(actions.every(a => a.action.mock.calls.length === 1)).toBe(true);
      expect(result).toEqual(
        failing === 'none' ? undefined : new Error(failing),
      );
    },
  );
  it('preserves prior error even when both destroys and artifact fail', async () => {
    // Arrange
    const original = new Error('original');
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
});

it('measures unchanged public latest methods across owned PostgreSQL index layouts', async () => {
  // Arrange: finite fixture and owned Docker only. Act: run phases. Assert:
  // independent maps, SQL identity, counts and cleanup are checked throughout.
  await expect(runBenchmark(databases)).resolves.toBeUndefined();
});
