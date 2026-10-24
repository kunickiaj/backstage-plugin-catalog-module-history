/** Opt-in, owned-Docker diagnostics; deliberately not a normal *.test.ts file. */
// The import rule does not recognize *.benchmark.ts as test-only. These tools
// intentionally use devDependencies; this file is not a production entry point.
/* eslint-disable @backstage/no-undeclared-imports */
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile } from 'node:fs/promises';
import { cpus, totalmem } from 'node:os';
import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import {
  coreServices,
  createBackendModule,
} from '@backstage/backend-plugin-api';
import {
  mockCredentials,
  mockServices,
  startTestBackend,
  TestDatabases,
  type TestBackend,
} from '@backstage/backend-test-utils';
import { type Entity, stringifyEntityRef } from '@backstage/catalog-model';
import catalogBackend from '@backstage/plugin-catalog-backend';
import {
  catalogProcessingExtensionPoint,
  type EntityProviderConnection,
} from '@backstage/plugin-catalog-node';
import { AuthorizeResult } from '@backstage/plugin-permission-common';
import { historyStoreServiceRef } from '@kunickiaj/backstage-plugin-catalog-history-node';
import historyFeature, {
  entityToRow,
  HistoryRecordingEntityProvider,
} from '@kunickiaj/backstage-plugin-catalog-backend-module-history';
import { knex, type Knex } from 'knex';
import type { Client } from 'pg';
import request from 'supertest';

// Source-only harness; production build directory resolution is not applicable.
// eslint-disable-next-line no-restricted-syntax
const ROOT = resolve(__dirname, '../../../..');
const executeFile = promisify(execFile);
const STAGES = [
  'initial',
  'unchanged',
  'change-1pct',
  'change-all',
  'remove-half',
  'restore',
  'revision-1',
  'revision-2',
  'revision-3',
  'unchanged-after-retention',
] as const;
type Options = { count: number; profile: string; stages: string[] };
type DescriptionMap = Map<string, string | undefined>;
type Counters = {
  n_added: number;
  n_modified: number;
  n_removed: number;
  n_unchanged: number;
};
const REQUEST_MS = 5000;
const CONVERGENCE_MS = 120_000;
const CLEANUP_MS = 65_000;
const STATEMENT_MS = 30_000;
const WARM_SAMPLES = 5;

function optionsFromEnvironment(env: NodeJS.ProcessEnv): Options {
  const raw = env.HISTORY_BENCH_COUNT ?? '1000';
  const count = Number(raw);
  if (!/^[1-9]\d*$/.test(raw) || count > 20_000) {
    throw new Error('HISTORY_BENCH_COUNT must be an integer in 1..20000');
  }
  const profile = env.HISTORY_BENCH_PROFILE ?? 'standard';
  if (!['standard', 'heavy'].includes(profile)) {
    throw new Error('HISTORY_BENCH_PROFILE must be standard or heavy');
  }
  if (profile === 'heavy' && count > 1000) {
    throw new Error('heavy profile is limited to 1000 entities');
  }
  const stages = (env.HISTORY_BENCH_STAGES ?? STAGES.join(',')).split(',');
  if (
    stages[0] !== 'initial' ||
    new Set(stages).size !== stages.length ||
    stages.some(stage => !STAGES.includes(stage as (typeof STAGES)[number]))
  ) {
    throw new Error('Stages must be unique whitelist values, initial first');
  }
  return { count, profile, stages };
}

function assertOwnedDocker(env: NodeJS.ProcessEnv) {
  // Check presence, not truthiness: even an empty caller override is refused.
  if (env.BACKSTAGE_TEST_DATABASE_POSTGRES16_CONNECTION_STRING !== undefined) {
    throw new Error('Caller database override refused; owned Docker only');
  }
}

function hash(value: unknown) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function mapSummary(map: DescriptionMap) {
  const entries = [...map].sort(([a], [b]) => a.localeCompare(b));
  const distribution: Record<string, number> = {};
  for (const [, description] of entries) {
    const revision = description?.match(/revision (\d+)$/)?.[1] ?? 'other';
    distribution[revision] = (distribution[revision] ?? 0) + 1;
  }
  return {
    count: map.size,
    sha256: hash(entries),
    revisionDistribution: distribution,
  };
}

function descriptionMap(entities: Entity[]): DescriptionMap {
  const result = new Map(
    entities.map(e => [stringifyEntityRef(e), e.metadata.description]),
  );
  if (result.size !== entities.length)
    throw new Error('Duplicate fixture refs');
  return result;
}

function expectedCycle(previous: Map<string, string>, entities: Entity[]) {
  const current = new Map(
    entities.map(e => {
      const row = entityToRow(e);
      return [row.entityRef, row.etag] as const;
    }),
  );
  const counters: Counters = {
    n_added: 0,
    n_modified: 0,
    n_removed: 0,
    n_unchanged: 0,
  };
  for (const [ref, etag] of current) {
    if (!previous.has(ref)) counters.n_added++;
    else if (previous.get(ref) === etag) counters.n_unchanged++;
    else counters.n_modified++;
  }
  for (const ref of previous.keys()) {
    if (!current.has(ref)) counters.n_removed++;
  }
  return { current, counters };
}

type Emit = (event: Record<string, unknown>) => Promise<void>;

async function generate(
  options: Options,
  stage: string,
  directory: string,
  emit: Emit,
) {
  const output = resolve(directory, `${stage}.jsonl`);
  const { stderr } = await executeFile(
    process.execPath,
    [
      resolve(ROOT, 'scripts/catalog-history-fixtures.mjs'),
      '--count',
      String(options.count),
      '--profile',
      options.profile,
      '--stage',
      stage,
      '--output',
      output,
    ],
    { timeout: 30_000 },
  );
  const entities = (await readFile(output, 'utf8'))
    .trim()
    .split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line) as Entity)
    .map(entity => ({
      ...entity,
      metadata: {
        ...entity.metadata,
        annotations: {
          ...entity.metadata.annotations,
          'backstage.io/managed-by-location': 'benchmark:synthetic',
          'backstage.io/managed-by-origin-location': 'benchmark:synthetic',
        },
      },
    }));
  const sizes = entities.map(
    e =>
      Buffer.byteLength(JSON.stringify(e.metadata)) +
      Buffer.byteLength(JSON.stringify(e.spec)),
  );
  await emit({
    type: 'fixture',
    stage,
    generator: JSON.parse(stderr),
    providerMetadataSpecCompactJsonBytes: {
      min: Math.min(...sizes),
      max: Math.max(...sizes),
    },
  });
  return entities;
}

/** SQL text is hashed, never logged; bindings and errors never enter artifacts. */
function observeQueries(db: Knex) {
  type Query = { __knexQueryUid?: string; sql: string };
  const controls = new Map<
    string,
    {
      fingerprint: string;
      queryClass: string;
      emitted: number;
      responses: number;
      errors: number;
    }
  >();
  const controlCategory = (query: Query) => {
    // Transaction.query bypasses Runner.query's query-response event. Never
    // invent completion or duration for these commands.
    if (query.__knexQueryUid) return undefined;
    return query.sql
      .trim()
      .match(
        /^(BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE|SET TRANSACTION)\b/i,
      )?.[1]
      .toLowerCase();
  };
  const fingerprintOf = (query: Query) =>
    hash(query.sql.replace(/'[^']*'/g, '?').replace(/\b\d+\b/g, '?'));
  const pending = new Map<
    string,
    { start: number; fingerprint: string; queryClass: string }
  >();
  const aggregates = new Map<
    string,
    {
      fingerprint: string;
      queryClass: string;
      count: number;
      errors: number;
      milliseconds: number;
    }
  >();
  db.on('query', (query: Query) => {
    const fingerprint = fingerprintOf(query);
    const control = controlCategory(query);
    if (control) {
      const aggregate = controls.get(fingerprint) ?? {
        fingerprint,
        queryClass: control,
        emitted: 0,
        responses: 0,
        errors: 0,
      };
      aggregate.emitted++;
      controls.set(fingerprint, aggregate);
      return;
    }
    const queryClass = query.sql.trim().split(/[\s;]/)[0].toLowerCase();
    pending.set(query.__knexQueryUid ?? fingerprint, {
      start: performance.now(),
      fingerprint,
      queryClass,
    });
  });
  const finish = (query: Query, failed: boolean) => {
    if (controlCategory(query)) {
      const aggregate = controls.get(fingerprintOf(query));
      if (aggregate) {
        if (failed) aggregate.errors++;
        else aggregate.responses++;
      }
      return;
    }
    const key =
      query.__knexQueryUid ??
      hash(query.sql.replace(/'[^']*'/g, '?').replace(/\b\d+\b/g, '?'));
    const item = pending.get(key);
    if (!item) return;
    pending.delete(key);
    const aggregate = aggregates.get(item.fingerprint) ?? {
      fingerprint: item.fingerprint,
      queryClass: item.queryClass,
      count: 0,
      errors: 0,
      milliseconds: 0,
    };
    aggregate.count++;
    aggregate.errors += Number(failed);
    aggregate.milliseconds += performance.now() - item.start;
    aggregates.set(item.fingerprint, aggregate);
  };
  db.on('query-response', (_response: unknown, query: Query) =>
    finish(query, false),
  );
  db.on('query-error', (_error: unknown, query: Query) => finish(query, true));
  const unmatched = () =>
    [...pending.values()].map(item => ({
      fingerprint: item.fingerprint,
      queryClass: item.queryClass,
      ageMs: performance.now() - item.start,
    }));
  const controlSummary = () =>
    [...controls.values()].map(item => ({
      ...item,
      completionUnobserved: item.emitted - item.responses - item.errors,
      completionTiming: 'unavailable-no-query-response-event',
    }));
  return {
    pending,
    unmatched,
    controlSummary,
    summary: () => [...aggregates.values()],
  };
}

function createFixturePool(allocated: Knex): Knex {
  // This connection is generated by TestDatabases AFTER the override refusal.
  // Never accept caller config, URLs, role settings, or global/server settings.
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

async function get(backend: TestBackend, path: string) {
  const response = await request(backend.server)
    .get(path)
    .set('Authorization', mockCredentials.user.header())
    .timeout({ response: REQUEST_MS, deadline: REQUEST_MS });
  if (response.status !== 200)
    throw new Error(`Fixture HTTP status ${response.status}`);
  return response.body;
}

async function servedMap(backend: TestBackend, deadline: number) {
  const result: DescriptionMap = new Map();
  const cursors = new Set<string>();
  let cursor: string | undefined;
  do {
    if (performance.now() >= deadline)
      throw new Error('Convergence deadline exceeded');
    const query = new URLSearchParams({ limit: '500', totalItems: 'exclude' });
    if (cursor) query.set('cursor', cursor);
    else query.set('filter', 'kind=Component,metadata.namespace=benchmark');
    const body = await get(backend, `/api/catalog/entities/by-query?${query}`);
    for (const entity of body.items as Entity[]) {
      const ref = stringifyEntityRef(entity);
      if (result.has(ref)) throw new Error('Duplicate served ref');
      result.set(ref, entity.metadata.description);
    }
    cursor = body.pageInfo?.nextCursor;
    if (cursor && cursors.has(cursor))
      throw new Error('Repeated catalog cursor');
    if (cursor) cursors.add(cursor);
  } while (cursor);
  return result;
}

async function converge(
  backend: TestBackend,
  expected: DescriptionMap,
  emit: Emit,
) {
  const start = performance.now();
  const expectedSummary = mapSummary(expected);
  let served: DescriptionMap = new Map();
  do {
    served = await servedMap(backend, start + CONVERGENCE_MS);
    if (mapSummary(served).sha256 === expectedSummary.sha256) {
      await emit({
        type: 'convergence',
        milliseconds: performance.now() - start,
        expected: expectedSummary,
        served: mapSummary(served),
      });
      return;
    }
    await delay(200);
  } while (performance.now() < start + CONVERGENCE_MS);
  await emit({
    type: 'convergence-partial',
    expected: expectedSummary,
    served: mapSummary(served),
  });
  throw new Error('Catalog did not converge within fixture deadline');
}

async function measureReads(
  backend: TestBackend,
  entities: Entity[],
  emit: Emit,
  firstHistory: boolean,
) {
  for (let sample = 0; sample <= WARM_SAMPLES; sample++) {
    const start = performance.now();
    const body = await get(
      backend,
      '/api/catalog/entities/by-query?filter=metadata.namespace=benchmark&limit=1',
    );
    expect(body.items).toHaveLength(Math.min(1, entities.length));
    expect(body.totalItems).toBe(entities.length);
    await emit({
      type: 'stock-count-read',
      phase:
        sample === 0 ? 'first-after-convergence-not-cold-db-cache' : 'warm',
      sample,
      milliseconds: performance.now() - start,
      items: body.items.length,
      totalItems: body.totalItems,
    });
  }
  const name = entities[0]?.metadata.name ?? 'benchmark-project-0000001';
  for (let sample = 0; sample <= WARM_SAMPLES; sample++) {
    const start = performance.now();
    const body = await get(
      backend,
      `/api/catalog/history/entities/component/benchmark/${name}/history?limit=25`,
    );
    expect(Array.isArray(body.items)).toBe(true);
    let phase = 'warm';
    if (sample === 0 && firstHistory)
      phase = 'first-history-http-query-schema-promise-unprepared';
    await emit({
      type: 'history-read',
      phase,
      sample,
      items: body.items.length,
      milliseconds: performance.now() - start,
    });
  }
}

async function historyCounts(db: Knex) {
  const cycles = await db('catalog_history_cycles').select(
    'cycle_id',
    'n_added',
    'n_modified',
    'n_removed',
    'n_unchanged',
  );
  const rows = await db('catalog_history_entities').count('* as count').first();
  const operations = await db('catalog_history_entities')
    .select('op')
    .count('* as count')
    .groupBy('op');
  return { cycles, rows: Number(rows?.count), operations };
}

async function relationSizes(db: Knex) {
  return (
    await db.raw(`SELECT c.relname AS relation,
    CASE WHEN c.relname LIKE 'catalog_history_%' THEN 'history' ELSE 'catalog' END AS category,
    pg_relation_size(c.oid)::text AS heap_bytes,
    pg_indexes_size(c.oid)::text AS index_bytes,
    CASE WHEN c.reltoastrelid = 0 THEN 0 ELSE pg_total_relation_size(c.reltoastrelid) END::text AS toast_total_bytes,
    pg_total_relation_size(c.oid)::text AS total_bytes
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind = 'r' ORDER BY c.relname`)
  ).rows;
}

async function waitForQuiescence(
  db: Knex,
  observer: ReturnType<typeof observeQueries>,
  emit: Emit,
) {
  const start = performance.now();
  let quietSamples = 0;
  let lastEvidence: Record<string, unknown> = {};
  while (performance.now() - start < CLEANUP_MS) {
    const pool = db.client.pool;
    const used = pool.numUsed();
    const pending = pool.numPendingAcquires() + pool.numPendingCreates();
    const states = (
      await db.raw(`SELECT state, wait_event_type, count(*)::integer AS count FROM pg_stat_activity
      WHERE datname = current_database() AND pid <> pg_backend_pid()
      AND backend_type = 'client backend' GROUP BY state, wait_event_type`)
    ).rows as {
      state: string;
      wait_event_type: string | null;
      count: number;
    }[];
    const active = states
      .filter(row => row.state !== 'idle')
      .reduce((sum, row) => sum + row.count, 0);
    lastEvidence = {
      used,
      pending,
      active,
      pgStates: states,
      unmatchedSql: observer.unmatched(),
      transactionControls: observer.controlSummary(),
      controlNote:
        'No completion events, not active SQL evidence; pool and PG independently required idle',
    };
    if (quietSamples === 0)
      await emit({ type: 'cleanup-observation', ...lastEvidence });
    if (
      used === 0 &&
      pending === 0 &&
      observer.pending.size === 0 &&
      active === 0
    )
      quietSamples++;
    else quietSamples = 0;
    if (quietSamples >= 4) {
      await emit({
        type: 'cleanup-quiescent',
        ...lastEvidence,
        quietSamples,
        milliseconds: performance.now() - start,
      });
      return;
    }
    await delay(400);
  }
  await emit({
    type: 'cleanup-failure',
    ...lastEvidence,
    milliseconds: performance.now() - start,
  });
  throw new Error('Fixture pool did not quiesce after backend stop');
}

type OwnedCleanup = {
  stop: () => Promise<void>;
  quiesce: () => Promise<void>;
  summarize: () => Promise<void>;
  destroyFixture: () => Promise<void>;
  destroyAllocated: () => Promise<void>;
  emit: Emit;
  priorFailure?: { error: unknown };
};

async function cleanupOwnedPools(options: OwnedCleanup) {
  const failures: { stage: string; error: unknown }[] = [];
  const attempt = async (stage: string, action: () => Promise<void>) => {
    try {
      await action();
      return true;
    } catch (error) {
      failures.push({ stage, error });
      return false;
    }
  };
  await attempt('stop-start-evidence', () =>
    options.emit({ type: 'backend-stop-started' }),
  );
  const stopped = await attempt('backend-stop', options.stop);
  if (stopped)
    await attempt('stop-returned-evidence', () =>
      options.emit({
        type: 'backend-stop-returned',
        pipelineTasksAwaitedBySdk: false,
      }),
    );
  const quiescenceProven =
    stopped && (await attempt('quiescence', options.quiesce));
  if (quiescenceProven) await attempt('sql-summary', options.summarize);
  // Even an unproven/failed shutdown must attempt BOTH owned pools. Capturing
  // each failure defers rejection until destruction and safe evidence finish.
  await attempt('fixture-pool-destroy', options.destroyFixture);
  await attempt('allocated-pool-destroy', options.destroyAllocated);
  if (failures.length === 0)
    await attempt('destroyed-evidence', () =>
      options.emit({
        type: 'fixture-pools-destroyed',
        quiescenceProven,
        sdkCleanup:
          'Owned TestDatabases registered afterAll shutdown still required',
      }),
    );
  if (failures.length > 0)
    await attempt('cleanup-failure-evidence', () =>
      options.emit({
        type: 'cleanup-failure',
        status: 'nonpass',
        quiescenceProven,
        failures: failures.map(({ stage, error }) => ({
          stage,
          errorType:
            error instanceof Error ? error.constructor.name : typeof error,
        })),
      }),
    );
  if (options.priorFailure) throw options.priorFailure.error;
  if (failures.length > 0) throw failures[0].error;
}

async function runCase(
  databases: TestDatabases,
  options: Options,
  snapshots: Map<string, Entity[]>,
  enabled: boolean,
  emit: Emit,
) {
  assertOwnedDocker(process.env);
  const allocated = await databases.init('POSTGRES_16');
  const db = createFixturePool(allocated);
  const observer = observeQueries(db);
  let backend: TestBackend | undefined;
  let priorFailure: { error: unknown } | undefined;
  let connection: EntityProviderConnection | undefined;
  const providerModule = createBackendModule({
    pluginId: 'catalog',
    moduleId: 'baseline-fixture',
    register(reg) {
      reg.registerInit({
        deps: {
          catalog: catalogProcessingExtensionPoint,
          store: historyStoreServiceRef,
          logger: coreServices.logger,
        },
        async init({ catalog, store, logger }) {
          catalog.addEntityProvider(
            new HistoryRecordingEntityProvider({
              inner: {
                getProviderName: () => 'baseline-synthetic',
                async connect(conn) {
                  connection = conn;
                },
              },
              store,
              logger,
              enabled,
              convertFullToDelta: false,
            }),
          );
        },
      });
    },
  });
  try {
    const start = performance.now();
    backend = await startTestBackend({
      features: [
        catalogBackend,
        historyFeature,
        providerModule,
        mockServices.database.factory({ knex: db }),
        mockServices.httpAuth.factory({
          defaultCredentials: mockCredentials.none(),
        }),
        mockServices.permissions.factory({ result: AuthorizeResult.ALLOW }),
        mockServices.rootConfig.factory({
          data: {
            catalog: {
              history: {
                enabled: true,
                api: { enabled: true, queryTimeoutMs: 0 },
                provider: { enabled },
                processing: { enabled: false },
                reconciler: { enabled: false },
              },
            },
          },
        }),
      ],
    });
    await emit({
      type: 'startup',
      milliseconds: performance.now() - start,
      settings: (
        await db.raw(`SELECT name, setting, unit FROM pg_settings WHERE name IN
        ('server_version','shared_buffers','work_mem','synchronous_commit','statement_timeout') ORDER BY name`)
      ).rows,
    });
    if (!connection) throw new Error('Synthetic provider connection missing');
    let previous = new Map<string, string>();
    let expectedRows = 0;
    const expectedCycles: Counters[] = [];
    for (const stage of options.stages) {
      const entities = snapshots.get(stage)!;
      const expected = expectedCycle(previous, entities);
      if (enabled) {
        expectedCycles.push(expected.counters);
        expectedRows +=
          expected.counters.n_added +
          expected.counters.n_modified +
          expected.counters.n_removed;
      }
      const stageEmit: Emit = event => emit({ stage, ...event });
      const mutationStart = performance.now();
      await connection.applyMutation({
        type: 'full',
        entities: entities.map(entity => ({
          entity,
          locationKey: `benchmark:synthetic:${stringifyEntityRef(entity)}`,
        })),
      });
      await stageEmit({
        type: 'provider-full-complete',
        milliseconds: performance.now() - mutationStart,
        note: 'Provider and history writes complete; processing is not implied',
      });
      await converge(backend, descriptionMap(entities), stageEmit);
      const actual = await historyCounts(db);
      await stageEmit({
        type: 'history-counters',
        expectedCycles,
        expectedRows,
        actual,
        retentionPerformed: false,
      });
      expect(actual.cycles).toHaveLength(expectedCycles.length);
      expect(actual.rows).toBe(expectedRows);
      expect(
        actual.cycles
          .map(({ cycle_id: _id, ...counts }) => counts)
          .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
      ).toEqual(
        [...expectedCycles].sort((a, b) =>
          JSON.stringify(a).localeCompare(JSON.stringify(b)),
        ),
      );
      await measureReads(backend, entities, stageEmit, stage === 'initial');
      await stageEmit({
        type: 'relation-sizes',
        relations: await relationSizes(db),
        databaseBytes: (
          await db.raw(
            'SELECT pg_database_size(current_database())::text AS bytes',
          )
        ).rows[0].bytes,
      });
      previous = expected.current;
    }
  } catch (error) {
    priorFailure = { error };
    throw error;
  } finally {
    // Submissions and all awaited clients have settled. SDK stop only signals the
    // processing pipeline: require pool AND PostgreSQL quiescence before destroy.
    await cleanupOwnedPools({
      stop: async () => {
        await backend?.stop();
      },
      quiesce: () => waitForQuiescence(db, observer, emit),
      summarize: () =>
        emit({
          type: 'sql-aggregates',
          attribution: 'whole-case-including-background-not-http-request',
          queries: observer.summary(),
          unassignedInFlight: observer.pending.size,
          unmatchedSql: observer.unmatched(),
          transactionControls: observer.controlSummary(),
        }),
      destroyFixture: () => db.destroy(),
      destroyAllocated: () => allocated.destroy(),
      emit,
      priorFailure,
    });
  }
}

// Refuse caller databases before TestDatabases.create registers any SDK hooks.
assertOwnedDocker(process.env);
const databases = TestDatabases.create({
  ids: ['POSTGRES_16'],
  disableDocker: false,
});
jest.setTimeout(600_000);

describe('baseline diagnostic safety and deterministic expectations', () => {
  it.each([
    'stop',
    'quiesce',
    'summarize',
    'destroyFixture',
    'destroyAllocated',
  ] as const)(
    'cleanup attempts both owned pools and preserves %s failure',
    async failedStep => {
      // Arrange: callbacks isolate control flow; no SQL or actual hanging pools.
      const failure = new Error('synthetic private connection detail');
      const events: Record<string, unknown>[] = [];
      const options: OwnedCleanup = {
        stop: jest.fn().mockResolvedValue(undefined),
        quiesce: jest.fn().mockResolvedValue(undefined),
        summarize: jest.fn().mockResolvedValue(undefined),
        destroyFixture: jest.fn().mockResolvedValue(undefined),
        destroyAllocated: jest.fn().mockResolvedValue(undefined),
        emit: async event => {
          events.push(event);
        },
      };
      options[failedStep] = jest.fn().mockRejectedValue(failure);
      // Act / Assert: rejection stays nonpass but neither destroy is skipped.
      await expect(cleanupOwnedPools(options)).rejects.toBe(failure);
      expect(options.destroyFixture).toHaveBeenCalledTimes(1);
      expect(options.destroyAllocated).toHaveBeenCalledTimes(1);
      expect(events).toContainEqual(
        expect.objectContaining({ type: 'cleanup-failure', status: 'nonpass' }),
      );
      expect(
        events.some(event => event.type === 'fixture-pools-destroyed'),
      ).toBe(false);
      expect(JSON.stringify(events)).not.toContain('private connection detail');
    },
  );

  it('cleanup preserves stop, quiescence, and destroy order before success evidence', async () => {
    // Arrange: the real quiescence callback owns the four-observation check.
    const calls: string[] = [];
    const action = (name: string) => async () => {
      calls.push(name);
    };
    const options: OwnedCleanup = {
      stop: action('stop'),
      quiesce: action('quiesce'),
      summarize: action('summary'),
      destroyFixture: action('fixture'),
      destroyAllocated: action('allocated'),
      emit: async event => {
        if (event.type === 'fixture-pools-destroyed') calls.push('success');
      },
    };
    // Act
    await cleanupOwnedPools(options);
    // Assert
    expect(calls).toEqual([
      'stop',
      'quiesce',
      'summary',
      'fixture',
      'allocated',
      'success',
    ]);
  });

  it('cleanup attempts both pools even when evidence emission rejects', async () => {
    // Arrange: unavailable artifact writes must not prevent resource cleanup.
    const failure = new Error('synthetic artifact write failure');
    const options: OwnedCleanup = {
      stop: jest.fn().mockResolvedValue(undefined),
      quiesce: jest.fn().mockResolvedValue(undefined),
      summarize: jest.fn().mockResolvedValue(undefined),
      destroyFixture: jest.fn().mockResolvedValue(undefined),
      destroyAllocated: jest.fn().mockResolvedValue(undefined),
      emit: jest.fn().mockRejectedValue(failure),
    };
    // Act / Assert
    await expect(cleanupOwnedPools(options)).rejects.toBe(failure);
    expect(options.stop).toHaveBeenCalledTimes(1);
    expect(options.destroyFixture).toHaveBeenCalledTimes(1);
    expect(options.destroyAllocated).toHaveBeenCalledTimes(1);
  });

  it('cleanup keeps the original domain failure when cleanup also rejects', async () => {
    // Arrange: preserve the initiating failure, record safe secondary evidence.
    const original = new Error('synthetic domain failure');
    const events: Record<string, unknown>[] = [];
    const options: OwnedCleanup = {
      stop: jest.fn().mockResolvedValue(undefined),
      quiesce: jest
        .fn()
        .mockRejectedValue(new Error('synthetic quiescence failure')),
      summarize: jest.fn().mockResolvedValue(undefined),
      destroyFixture: jest
        .fn()
        .mockRejectedValue(new Error('synthetic pool failure')),
      destroyAllocated: jest.fn().mockResolvedValue(undefined),
      emit: async event => {
        events.push(event);
      },
      priorFailure: { error: original },
    };
    // Act / Assert
    await expect(cleanupOwnedPools(options)).rejects.toBe(original);
    expect(options.destroyFixture).toHaveBeenCalledTimes(1);
    expect(options.destroyAllocated).toHaveBeenCalledTimes(1);
    expect(events).toContainEqual({
      type: 'cleanup-failure',
      status: 'nonpass',
      quiescenceProven: false,
      failures: [
        { stage: 'quiescence', errorType: 'Error' },
        { stage: 'fixture-pool-destroy', errorType: 'Error' },
      ],
    });
    expect(events.some(event => event.type === 'fixture-pools-destroyed')).toBe(
      false,
    );
  });

  it('reproduces installed Knex transaction events without a database', async () => {
    // Arrange: mock only the pg wire connection, not Knex transaction/event code.
    const db = knex({ client: 'pg' });
    const connection = {
      query: jest.fn((_query, callback) =>
        callback(null, { rows: [], command: 'SELECT' }),
      ),
    };
    jest.spyOn(db.client, 'acquireConnection').mockResolvedValue(connection);
    jest.spyOn(db.client, 'releaseConnection').mockResolvedValue(undefined);
    const observer = observeQueries(db);
    const events: Record<string, string[]> = {
      query: [],
      response: [],
      error: [],
    };
    const category = (query: { sql: string }) =>
      query.sql.trim().split(/[\s;]/)[0].toLowerCase();
    db.on('query', query => events.query.push(category(query)));
    db.on('query-response', (_response, query) =>
      events.response.push(category(query)),
    );
    db.on('query-error', (_error, query) => events.error.push(category(query)));
    try {
      // Act: await a successful commit and a deliberate rollback fully.
      await db.transaction(async tx => {
        await tx.raw('SELECT 1');
      });
      await expect(
        db.transaction(async tx => {
          await tx.raw('SELECT 1');
          throw new Error('synthetic rollback');
        }),
      ).rejects.toThrow('synthetic rollback');
      // Assert: control commands lack response events even after transaction completion.
      expect(events).toEqual({
        query: ['begin', 'select', 'commit', 'begin', 'select', 'rollback'],
        response: ['select', 'select'],
        error: [],
      });
      expect(observer.unmatched()).toEqual([]);
      expect(
        observer
          .controlSummary()
          .map(item => [
            item.queryClass,
            item.emitted,
            item.completionUnobserved,
            item.responses,
            item.errors,
          ])
          .sort(),
      ).toEqual([
        ['begin', 2, 2, 0, 0],
        ['commit', 1, 1, 0, 0],
        ['rollback', 1, 1, 0, 0],
      ]);
    } finally {
      await db.destroy();
    }
  });

  it('accepts safe defaults and rejects malformed controls and caller database overrides', () => {
    // Arrange
    const bad = [
      { HISTORY_BENCH_COUNT: '0' },
      { HISTORY_BENCH_COUNT: '1.5' },
      { HISTORY_BENCH_COUNT: '20001' },
      { HISTORY_BENCH_PROFILE: 'unknown' },
      { HISTORY_BENCH_PROFILE: 'heavy', HISTORY_BENCH_COUNT: '1001' },
      { HISTORY_BENCH_STAGES: 'unchanged' },
      { HISTORY_BENCH_STAGES: 'initial,bad' },
    ];
    // Act / Assert: success and failure boundaries never create a database.
    expect(optionsFromEnvironment({}).count).toBe(1000);
    for (const env of bad) expect(() => optionsFromEnvironment(env)).toThrow();
    expect(() => assertOwnedDocker({})).not.toThrow();
    expect(() =>
      assertOwnedDocker({
        BACKSTAGE_TEST_DATABASE_POSTGRES16_CONNECTION_STRING: '',
      }),
    ).toThrow();
  });

  it('detects changed descriptions and duplicates instead of accepting matching counts', () => {
    // Arrange
    const entity: Entity = {
      apiVersion: 'backstage.io/v1alpha1',
      kind: 'Component',
      metadata: { name: 'fixture', description: 'revision 0' },
    };
    const changed = {
      ...entity,
      metadata: { ...entity.metadata, description: 'revision 1' },
    };
    // Act
    const initial = expectedCycle(new Map(), [entity]);
    const unchanged = expectedCycle(initial.current, [entity]);
    const modified = expectedCycle(initial.current, [changed]);
    const removed = expectedCycle(initial.current, []);
    // Assert
    expect(initial.counters.n_added).toBe(1);
    expect(unchanged.counters.n_unchanged).toBe(1);
    expect(modified.counters.n_modified).toBe(1);
    expect(removed.counters.n_removed).toBe(1);
    expect(mapSummary(descriptionMap([entity])).sha256).not.toBe(
      mapSummary(descriptionMap([changed])).sha256,
    );
    expect(() => descriptionMap([entity, entity])).toThrow('Duplicate');
  });
});

it('diagnoses the public catalog backend with provider recording off and on', async () => {
  // Arrange: independent snapshots and expectations; artifacts survive failures.
  const options = optionsFromEnvironment(process.env);
  const directory = resolve(ROOT, '.tmp/history-baseline', randomUUID());
  await mkdir(directory, { recursive: true });
  const artifact = await open(resolve(directory, 'report.jsonl'), 'wx');
  const emit: Emit = async event => {
    await artifact.write(`${JSON.stringify(event)}\n`);
  };
  try {
    const git = await executeFile('git', ['rev-parse', 'HEAD'], { cwd: ROOT });
    const dirty = await executeFile('git', ['status', '--porcelain'], {
      cwd: ROOT,
    });
    await emit({
      type: 'environment',
      options,
      node: process.version,
      arch: process.arch,
      visibleCpuCount: cpus().length,
      hostMemoryBytes: totalmem(),
      containerQuotas: 'unknown',
      sourceSha: git.stdout.trim(),
      dirty: Boolean(dirty.stdout.trim()),
      versions: {
        module: require('../../package.json').version,
        catalog: require('@backstage/plugin-catalog-backend/package.json')
          .version,
        testUtils: require('@backstage/backend-test-utils/package.json')
          .version,
      },
      comparison:
        'Runtime 0.2 baseline at this SHA, not the report catalog 4.0.2, not scale proof or original timeout cause attribution',
      readDeadlineFeature:
        'Prior PR93 read deadline guard absent; requested queryTimeoutMs=0 not claimed enforced',
      authentication:
        'Mock user headers on all requests; default NONE and permission ALLOW; not production policy proof',
      metrics: 'SDK default noop',
      retentionPerformed: false,
      coldOsCacheMeasured: false,
      safety: {
        ownedDockerOnly: true,
        callerDatabaseOverridePresent: false,
        statementTimeoutMs: STATEMENT_MS,
        statementTimeoutScope:
          'dedicated fixture pool sessions only, not application deadline support',
        requestDeadlineMs: REQUEST_MS,
        convergenceDeadlineMs: CONVERGENCE_MS,
        cleanupDeadlineMs: CLEANUP_MS,
        warmSamples: WARM_SAMPLES,
        operationalProbeNotSlo: true,
      },
    });
    const snapshots = new Map<string, Entity[]>();
    for (const stage of options.stages)
      snapshots.set(stage, await generate(options, stage, directory, emit));
    // Act: real processing and stitching, no substituted catalog service or EP.
    for (const enabled of [false, true]) {
      const caseEmit: Emit = event => emit({ recording: enabled, ...event });
      await runCase(databases, options, snapshots, enabled, caseEmit);
    }
    // Assert: runCase verifies entire served maps, history rows and stock counts.
    expect(snapshots.size).toBe(options.stages.length);
    await emit({ type: 'result', status: 'pass' });
  } catch (error) {
    await emit({
      type: 'result',
      status: 'nonpass-partial',
      errorType: error instanceof Error ? error.name : 'unknown',
      note: 'Stopped submissions; raw error messages omitted to avoid credentials and SQL bindings',
    });
    throw new Error(
      `Baseline diagnostics failed; inspect ${directory}/report.jsonl`,
    );
  } finally {
    await artifact.close();
    // eslint-disable-next-line no-console
    console.info(`Baseline diagnostic artifact: ${directory}/report.jsonl`);
  }
});
