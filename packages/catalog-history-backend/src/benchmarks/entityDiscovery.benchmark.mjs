/**
 * Opt-in PostgreSQL 16 query experiment, not production SQL or an API contract.
 * From the repo root after yarn install --immutable:
 * node packages/catalog-history-backend/src/benchmarks/entityDiscovery.benchmark.mjs
 * Writes SQL, plans, timings and assertions to ignored .tmp/entity-discovery/.
 * Only a newly created, randomly authenticated Docker database is accepted.
 */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import knex from 'knex';
import pg from 'pg';

const exec = promisify(execFile);
const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL('../../../../', import.meta.url));
const output = `${root}.tmp/entity-discovery`;
const table = 'catalog_history_entities';
const index = 'history_discovery_name128_idx';
// 128 UTF-8 characters take at most 512 bytes. Do not include unbounded ref,
// kind, namespace or full name: those can exceed the B-tree tuple limit.
const expression = '(left(lower(name), 128) COLLATE "C")';
const ddl = `CREATE INDEX ${index} ON ${table} (${expression} text_pattern_ops)`;
const escape = value =>
  `replace(replace(replace(${value}, chr(92), chr(92)||chr(92)), '%', chr(92)||'%'), '_', chr(92)||'_')`;
const evidence = { baseline: '7d59fd6', assertions: [], runs: [] };

function query(options = {}, strategy = 'plain') {
  const values = [];
  const bind = value => {
    values.push(value);
    return `$${values.length}`;
  };
  const predicates = [];
  if (options.prefix !== undefined && options.prefix !== '') {
    const prefix = `lower(${bind(options.prefix)}::text)`;
    predicates.push(
      `lower(name) COLLATE "C" LIKE ${escape(prefix)} || '%' ESCAPE chr(92)`,
    );
    if (strategy === 'bounded') {
      predicates.push(
        `${expression} LIKE ${escape(`left(${prefix}, 128)`)} || '%' ESCAPE chr(92)`,
      );
    }
    if (strategy === 'oracle') {
      predicates.pop();
      predicates.push(
        `left(lower(name), length(${prefix})) COLLATE "C" = ${prefix} COLLATE "C"`,
      );
    }
  }
  for (const field of ['source', 'provider', 'op']) {
    if (options[field])
      predicates.push(`${field} = ANY(${bind(options[field])}::text[])`);
  }
  if (options.kind)
    predicates.push(`lower(kind) = lower(${bind(options.kind)}::text)`);
  if (options.from)
    predicates.push(`changed_at >= ${bind(options.from)}::timestamptz`);
  if (options.to)
    predicates.push(`changed_at <= ${bind(options.to)}::timestamptz`);
  const cursor = options.cursor;
  const after = cursor
    ? `WHERE (folded_name COLLATE "C", entity_ref COLLATE "C") > (${bind(cursor.folded_name)}::text COLLATE "C", ${bind(cursor.entity_ref)}::text COLLATE "C")`
    : '';
  // Pick all display fields from ONE latest matching event, never MAX(name),
  // MAX(kind), etc. Scope filters apply BEFORE dedup; cursor applies AFTER it.
  // A future opaque cursor must bind prefix + source/provider/kind/op/time
  // context and this ordering version, never the already-selected entityRef.
  // This is live pagination, not a snapshot: concurrent writes/retention may
  // change choices between pages. 26 rows means 25 choices plus lookahead.
  const text = `WITH choices AS (
    SELECT DISTINCT ON (entity_ref COLLATE "C")
      name, kind, namespace, entity_ref, lower(name) AS folded_name
    FROM ${table} ${predicates.length ? `WHERE ${predicates.join(' AND ')}` : ''}
    ORDER BY entity_ref COLLATE "C", changed_at DESC, id DESC
  ) SELECT * FROM choices ${after}
  ORDER BY folded_name COLLATE "C", entity_ref COLLATE "C"
  LIMIT ${bind(options.limit ?? 26)}`;
  return { text, values };
}

const cases = [
  ['empty', {}],
  ['rare25', { prefix: 'rare' }],
  ['missing', { prefix: 'not-present' }],
  ['common', { prefix: 'APP' }],
  ['late-page', { cursor: { folded_name: 'zulu-0002400', entity_ref: '' } }],
  [
    'kind-time',
    {
      kind: 'cOmPoNeNt',
      from: '2026-01-01T00:00:07.000Z',
      to: '2026-01-01T00:00:08.000Z',
    },
  ],
  [
    'scope',
    {
      prefix: 'app',
      source: ['processing'],
      provider: ['provider-1'],
      op: ['delete'],
    },
  ],
  ['percent', { prefix: 'literal%' }],
  ['underscore', { prefix: 'literal_' }],
  ['backslash', { prefix: 'literal\\' }],
  ['quote', { prefix: "literal'" }],
  ['unicode', { prefix: 'É' }],
  ['long-prefix', { prefix: `${'x'.repeat(128)}needle` }],
];

async function seed(db, rows) {
  await db.query(`TRUNCATE ${table}, catalog_history_cycles CASCADE`);
  await db.query(`INSERT INTO catalog_history_cycles
    (cycle_id, provider, source, mutation_type, started_at, finished_at)
    VALUES ('00000000-0000-4000-8000-000000000001', 'fixture', 'provider', 'full', '2026-01-01Z', '2026-01-01Z')`);
  await db.query(
    `INSERT INTO ${table}
    (cycle_id, entity_ref, kind, namespace, name, provider, source, op, metadata, changed_at)
    SELECT '00000000-0000-4000-8000-000000000001',
      lower(kind)||':'||ns||'/'||lower(name),
      CASE WHEN revision=9 THEN lower(kind) ELSE kind END, ns,
      CASE WHEN revision=9 THEN lower(name) ELSE name END,
      'provider-'||(revision%2),
      CASE WHEN revision%2=0 THEN 'provider' ELSE 'processing' END,
      CASE WHEN entity%19=0 OR revision=9 THEN 'delete' WHEN revision=0 THEN 'insert' ELSE 'update' END,
      CASE WHEN entity%19=0 OR revision=9 THEN NULL ELSE jsonb_build_object('padding', repeat('v',1190)) END,
      '2026-01-01Z'::timestamptz + revision * interval '1 second'
    FROM generate_series(0,$1::int-1) entity
    CROSS JOIN generate_series(0,9) revision
    CROSS JOIN LATERAL (SELECT
      CASE WHEN entity%2=0 THEN 'Component' ELSE 'CustomKind' END kind,
      CASE WHEN entity%4<2 THEN 'default' ELSE 'other' END ns,
      CASE WHEN entity<25 THEN 'Rare-'||lpad(entity::text,7,'0')
        WHEN entity%5=0 THEN 'Zulu-'||lpad((entity/4)::text,7,'0')
        ELSE 'App-'||lpad((entity/4)::text,7,'0') END name) f`,
    [rows / 10],
  );
  const names = [
    'literal%one',
    'literal_one',
    'literal\\one',
    "literal'one",
    'Éclair',
    'Eclair',
    `${'x'.repeat(128)}needle`,
    `${'x'.repeat(128)}other`,
  ];
  for (const name of names) {
    await insert(db, {
      ref: `deleteonlycustom:default/${name.toLowerCase()}`,
      name,
      kind: 'DeleteOnlyCustom',
    });
  }
  for (let id = 0; id < 35; id++) {
    await insert(db, {
      ref: `customkind${String(id).padStart(2, '0')}:default/delete-only-${id}`,
      name: `delete-only-${id}`,
      kind: `CustomKind${String(id).padStart(2, '0')}`,
    });
  }
  // Public store accepts a name independent of entityRef, with no width check.
  // Keep the ref short so the BASELINE entity_ref index remains valid.
  const wide = Array.from(
    { length: 200 },
    (_, i) => randomBytes(16).toString('hex') + i,
  ).join('');
  await insert(db, {
    ref: 'custom:default/wide',
    name: wide,
    kind: 'WideKind',
  });
  await insert(db, {
    ref: 'component:default/case-tie',
    name: 'CASE-TIE',
    kind: 'Component',
    namespace: 'DEFAULT',
  });
  await insert(db, {
    ref: 'component:default/case-tie',
    name: 'Case-Tie',
    kind: 'COMPONENT',
    namespace: 'Default',
  });
  // Historical casing and delete rows are facts, not live existence labels.
  evidence.assertions.push({
    rows,
    retainedRows: Number(
      (await db.query(`SELECT count(*) FROM ${table}`)).rows[0].count,
    ),
    wideNameBytes: Buffer.byteLength(wide),
    baselineWideInsert: 'accepted',
  });
}

async function insert(db, { ref, name, kind, namespace = 'default' }) {
  await db.query(
    `INSERT INTO ${table}
    (cycle_id,entity_ref,kind,namespace,name,provider,source,op,changed_at)
    VALUES ('00000000-0000-4000-8000-000000000001',$1,$2,$3,$4,'special','provider','delete','2026-01-01T00:00:10.123456Z')`,
    [ref, kind, namespace, name],
  );
}

async function explain(db, built) {
  const result = await db.query(
    `EXPLAIN (ANALYZE, BUFFERS, WAL, FORMAT JSON) ${built.text}`,
    built.values,
  );
  return result.rows[0]['QUERY PLAN'][0];
}

async function measure(db, rows, strategy, statistics) {
  for (const [name, options] of cases) {
    const built = query(options, strategy);
    const actual = (await db.query(built)).rows;
    assert.deepEqual(
      actual,
      (await db.query(query(options, 'oracle'))).rows,
      name,
    );
    const plans = [];
    for (let sample = 0; sample < 5; sample++)
      plans.push(await explain(db, built));
    evidence.runs.push({
      rows,
      strategy,
      statistics,
      name,
      options,
      returned: actual.length,
      sql: built,
      executionMs: plans.map(plan => plan['Execution Time']),
      plan: plans[0],
    });
  }
  const kinds = {
    text: `SELECT DISTINCT lower(kind) COLLATE "C" AS kind FROM ${table} ORDER BY kind`,
    values: [],
  };
  const plans = [];
  for (let sample = 0; sample < 5; sample++)
    plans.push(await explain(db, kinds));
  evidence.runs.push({
    rows,
    strategy,
    statistics,
    name: 'retained-kinds',
    returned: (await db.query(kinds)).rows.length,
    sql: kinds,
    executionMs: plans.map(plan => plan['Execution Time']),
    plan: plans[0],
  });
}

async function prepared(db, rows, strategy) {
  const client = await db.connect();
  const name = `discovery_${strategy}_${rows}`;
  try {
    // Use the server's normal plan_cache_mode=auto, not a forced index or plan.
    for (let sample = 0; sample < 8; sample++) {
      const built = query({ prefix: sample % 2 ? 'rare' : 'app' }, strategy);
      await client.query({ ...built, name });
    }
    const counters = (
      await client.query(
        'SELECT name, generic_plans::text, custom_plans::text FROM pg_prepared_statements WHERE name=$1',
        [name],
      )
    ).rows;
    const plan = (
      await client.query(
        `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) EXECUTE ${name}('rare',26)`,
      )
    ).rows[0]['QUERY PLAN'][0];
    evidence.assertions.push({
      rows,
      strategy,
      preparedAutoPlan: { counters, plan },
    });
  } finally {
    client.release();
  }
}

async function semantics(db, strategy, rows) {
  for (const [prefix, expected] of [
    ['literal%', 1],
    ['literal_', 1],
    ['literal\\', 1],
    ["literal'", 1],
    ['É', 1],
    ['rare', 25],
    [`${'x'.repeat(128)}needle`, 1],
  ]) {
    assert.equal(
      (await db.query(query({ prefix, limit: 100 }, strategy))).rows.length,
      expected,
      prefix,
    );
  }
  const tie = (await db.query(query({ prefix: 'case-tie' }, strategy))).rows;
  assert.deepEqual(tie, [
    {
      name: 'Case-Tie',
      kind: 'COMPONENT',
      namespace: 'Default',
      entity_ref: 'component:default/case-tie',
      folded_name: 'case-tie',
    },
  ]);
  assert.equal(
    (await db.query(query({ prefix: 'component:' }, strategy))).rows.length,
    0,
    'name prefix, not ref',
  );
  const raw = await db.query(
    `SELECT changed_at::text AS date FROM ${table} WHERE entity_ref='component:default/case-tie' LIMIT 1`,
  );
  assert.match(raw.rows[0].date, /10\.123456/);
  const all = (await db.query(query({ limit: 20000 }, 'oracle'))).rows;
  const pages = [];
  let cursor;
  do {
    const page = (await db.query(query({ cursor, limit: 25 }, strategy))).rows;
    pages.push(...page);
    cursor = page.length === 25 ? page.at(-1) : undefined;
  } while (cursor);
  assert.deepEqual(
    pages,
    all,
    'cursor ties neither duplicate nor skip entities',
  );
  assert.equal(new Set(all.map(row => row.entity_ref)).size, all.length);
  const kinds = (
    await db.query(
      `SELECT DISTINCT lower(kind) COLLATE "C" AS kind FROM ${table} ORDER BY kind`,
    )
  ).rows;
  assert.deepEqual(
    kinds.map(row => row.kind),
    [
      'component',
      'customkind',
      ...Array.from(
        { length: 35 },
        (_, id) => `customkind${String(id).padStart(2, '0')}`,
      ),
      'deleteonlycustom',
      'widekind',
    ],
  );
  const filtered = (
    await db.query(
      query(
        {
          source: ['processing'],
          provider: ['provider-1'],
          op: ['update'],
          from: '2026-01-01T00:00:07Z',
          to: '2026-01-01T00:00:07Z',
          limit: 20000,
        },
        strategy,
      ),
    )
  ).rows;
  assert(filtered.length > 25);
  assert(
    filtered.every(
      row => row.kind === 'Component' || row.kind === 'CustomKind',
    ),
  );
  const selected = all[0].entity_ref;
  assert(
    (await db.query(query({}, strategy))).rows.some(
      row => row.entity_ref === selected,
    ),
    'selected ref deliberately does not scope discovery',
  );
  evidence.assertions.push({
    rows,
    strategy,
    distinctEntities: all.length,
    exhaustivePages: Math.ceil(all.length / 25),
    kinds,
    rawTimestamp: raw.rows[0].date,
    result: 'passed',
  });
}

async function writes(db, label) {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const plan = await explain(client, {
      text: `INSERT INTO ${table}
      (cycle_id,entity_ref,kind,namespace,name,provider,source,op,changed_at)
      SELECT '00000000-0000-4000-8000-000000000001','component:default/write-'||i,
      'Component','default','write-'||i,'write','provider','insert',now()
      FROM generate_series(1,1000) i`,
      values: [],
    });
    return { label, plan };
  } finally {
    try {
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
  }
}

async function buildAndLock(db) {
  const builder = await db.connect();
  let writer;
  try {
    writer = await db.connect();
    await builder.query('BEGIN');
    const start = performance.now();
    await builder.query(ddl);
    const buildMs = performance.now() - start;
    // Hold the actual regular CREATE INDEX lock until transaction completion.
    const locks = (
      await db.query(
        `SELECT mode, granted FROM pg_locks WHERE pid=$1 AND relation=$2::regclass`,
        [
          (await builder.query('SELECT pg_backend_pid() pid')).rows[0].pid,
          table,
        ],
      )
    ).rows;
    assert(locks.some(lock => lock.mode === 'ShareLock' && lock.granted));
    assert.equal(
      (await db.query(`SELECT count(*) FROM ${table}`)).rows.length,
      1,
      'reads continue',
    );
    await writer.query('BEGIN');
    await writer.query("SET LOCAL lock_timeout='100ms'");
    let blockedCode;
    try {
      await writer.query(`UPDATE ${table} SET name=name WHERE id=-1`);
    } catch (error) {
      blockedCode = error.code;
    }
    assert.equal(blockedCode, '55P03', 'regular index build blocks writer');
    await writer.query('ROLLBACK');
    await builder.query('COMMIT');
    const size = (
      await db.query('SELECT pg_relation_size($1::regclass)::text AS bytes', [
        index,
      ])
    ).rows[0].bytes;
    return {
      ddl,
      buildMs,
      bytes: size,
      locks,
      writerBlockedCode: blockedCode,
      writerLockTimeoutMs: 100,
    };
  } finally {
    await Promise.allSettled([
      builder.query('ROLLBACK'),
      writer?.query('ROLLBACK'),
    ]);
    builder.release();
    writer?.release();
  }
}

async function scenario(db, rows) {
  await db.query(`DROP INDEX IF EXISTS ${index}`);
  await seed(db, rows);
  // TRUNCATE does not remove old pg_statistic entries; explicitly remove them
  // ONLY in this owned fixture so the second size really tests no statistics.
  await db.query(`DELETE FROM pg_statistic WHERE starelid=$1::regclass`, [
    table,
  ]);
  await measure(db, rows, 'plain', 'none');
  await db.query(`ANALYZE ${table}`);
  await semantics(db, 'plain', rows);
  await measure(db, rows, 'plain', 'analyzed');
  await prepared(db, rows, 'plain');
  const writeBefore = await writes(db, 'without-name-index');
  let fullWidthCode;
  try {
    await db.query(
      `CREATE INDEX history_discovery_unsafe_full_idx ON ${table} (lower(name) text_pattern_ops)`,
    );
  } catch (error) {
    fullWidthCode = error.code;
  }
  assert.equal(
    fullWidthCode,
    '54000',
    'full lower(name) index rejects baseline-valid wide names',
  );
  const build = await buildAndLock(db);
  await db.query(
    `DELETE FROM pg_statistic WHERE starelid IN ($1::regclass,$2::regclass)`,
    [table, index],
  );
  await measure(db, rows, 'bounded', 'none');
  await db.query(`ANALYZE ${table}`);
  await semantics(db, 'bounded', rows);
  await measure(db, rows, 'bounded', 'analyzed');
  await prepared(db, rows, 'bounded');
  await insert(db, {
    ref: 'custom:default/post-index-wide',
    kind: 'WideKind',
    name: randomBytes(6000).toString('hex'),
  });
  evidence.assertions.push({
    rows,
    fullWidthIndexRejectedCode: fullWidthCode,
    boundedIndexPostBuildWideInsert: 'accepted',
    build,
    writes: [writeBefore, await writes(db, 'with-name-index')],
  });
}

async function main() {
  await mkdir(output, { recursive: true });
  const name = `history-discovery-${randomUUID()}`;
  const password = randomBytes(24).toString('hex');
  let container;
  let pool;
  let migration;
  try {
    container = (
      await exec(
        'docker',
        [
          'run',
          '--detach',
          '--rm',
          '--name',
          name,
          '--publish',
          '127.0.0.1::5432',
          '--env',
          'POSTGRES_PASSWORD',
          '--env',
          'POSTGRES_USER=fixture',
          '--env',
          'POSTGRES_DB=fixture',
          'postgres:16',
          '-c',
          'max_connections=20',
          '-c',
          'autovacuum=off',
        ],
        { env: { ...process.env, POSTGRES_PASSWORD: password } },
      )
    ).stdout.trim();
    assert.match(container, /^[a-f0-9]{64}$/);
    for (let attempt = 0; ; attempt++) {
      const ready = await exec('docker', [
        'exec',
        container,
        'pg_isready',
        '-h',
        '127.0.0.1',
        '-U',
        'fixture',
        '-d',
        'fixture',
      ]).then(
        () => true,
        () => false,
      );
      if (ready) break;
      assert(attempt < 60, 'Owned database did not become ready');
      await delay(250);
    }
    const address = (
      await exec('docker', ['port', container, '5432/tcp'])
    ).stdout.trim();
    assert.match(address, /^127\.0\.0\.1:\d+$/);
    const connection = {
      host: '127.0.0.1',
      port: Number(address.split(':')[1]),
      user: 'fixture',
      database: 'fixture',
      password,
    };
    migration = knex({ client: 'pg', connection, pool: { min: 0, max: 1 } });
    for (const file of [
      '20260512000000_initial.js',
      '20260705000000_source_and_stitched_fields.js',
      '20261023000000_global_feed_ordering_index.js',
    ]) {
      await migration.transaction(tx =>
        require(`../../migrations/${file}`).up(tx),
      );
    }
    await migration.destroy();
    migration = undefined;
    pool = new pg.Pool({
      ...connection,
      max: 3,
      connectionTimeoutMillis: 5000,
      statement_timeout: 30000,
    });
    pool.on('error', error => {
      evidence.poolError = { code: error.code, message: error.message };
    });
    evidence.server = (
      await pool.query(
        'SELECT version(), datcollate AS collation, datctype AS ctype FROM pg_database WHERE datname=current_database()',
      )
    ).rows[0];
    evidence.method =
      'Single client serial queries; five EXPLAIN ANALYZE samples per shape, warm shared buffers; no forced planner settings; unnamed parameterized custom plans. LIMIT is not a database-work cap. No production SLO claim.';
    for (const rows of [10000, 100000]) await scenario(pool, rows);
    assert.equal(evidence.poolError, undefined);
  } catch (error) {
    evidence.failure = { code: error.code, message: error.message };
    if (container) {
      evidence.startupLog = await exec('docker', [
        'logs',
        '--tail',
        '60',
        container,
      ]).then(
        result => result.stdout + result.stderr,
        () => 'unavailable',
      );
    }
    throw error;
  } finally {
    const cleanup = await Promise.allSettled([
      pool?.end(),
      migration?.destroy(),
    ]);
    if (container)
      cleanup.push(
        ...(await Promise.allSettled([
          exec('docker', ['rm', '--force', container]),
        ])),
      );
    evidence.cleanup = cleanup.map(result => result.status);
    await writeFile(
      `${output}/evidence.json`,
      `${JSON.stringify(evidence, null, 2)}\n`,
    );
    assert(
      cleanup.every(result => result.status === 'fulfilled'),
      'Owned fixture cleanup failed',
    );
  }
  process.stdout.write(
    'Entity discovery assertions passed; evidence: .tmp/entity-discovery/evidence.json\n',
  );
}

main().catch(error => {
  // Do not print connection objects, process env, credentials or Docker args.
  process.stderr.write(
    `Entity discovery benchmark failed: ${error.code ?? error.name}: ${error.message}\n`,
  );
  process.exitCode = 1;
});
