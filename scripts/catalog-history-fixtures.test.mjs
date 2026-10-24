import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import {
  generateSnapshot,
  PROFILE_BYTES,
  STAGES,
  writeSnapshot,
} from './catalog-history-fixtures.mjs';

const run = promisify(execFile);
const script = fileURLToPath(
  new URL('./catalog-history-fixtures.mjs', import.meta.url),
);
const seed = 'catalog-history-benchmark-v1';
const stages = [
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
  'remove-all',
];

function temporaryDirectory(t) {
  const directory = mkdtempSync(
    join(tmpdir(), 'catalog-history-fixtures-test-'),
  );
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function captureOutput() {
  const chunks = [];
  const stdout = new Writable({
    write(chunk, encoding, callback) {
      chunks.push(chunk.toString());
      callback();
    },
  });
  return { stdout, text: () => chunks.join('') };
}

function parseRows(text) {
  if (text === '') return [];
  assert.ok(text.endsWith('\n'), 'JSONL ends with a newline');
  return text
    .slice(0, -1)
    .split('\n')
    .map(line => JSON.parse(line));
}

function adaptedBytes(entity) {
  return (
    Buffer.byteLength(JSON.stringify(entity.metadata)) +
    Buffer.byteLength(JSON.stringify(entity.spec))
  );
}

function revisionCounts(rows) {
  const counts = { 0: 0, 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  for (const row of rows) {
    const match = row.metadata.description.match(/revision ([0-5])$/);
    assert.ok(match, 'description carries a supported revision');
    counts[match[1]] += 1;
  }
  return counts;
}

function expectedRevisions(stage, count) {
  const result = { 0: 0, 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  if (stage === 'remove-all') return result;
  if (stage === 'initial' || stage === 'unchanged') result[0] = count;
  else if (stage === 'change-1pct') {
    result[1] = Math.floor(count / 100);
    result[0] = count - result[1];
  } else if (stage === 'remove-half') result[2] = Math.ceil(count / 2);
  else if (stage === 'revision-1') result[3] = count;
  else if (stage === 'revision-2') result[4] = count;
  else if (stage === 'revision-3' || stage === 'unchanged-after-retention')
    result[5] = count;
  else result[2] = count;
  return result;
}

function withoutDescription(row) {
  const copy = structuredClone(row);
  delete copy.metadata.description;
  return copy;
}

function padding(row) {
  const fields = Object.entries(row.metadata.annotations).filter(([key]) =>
    key.startsWith('example.com/'),
  );
  assert.equal(fields.length, 1, 'one public example.com padding annotation');
  return fields[0][1];
}

function assertSummary(summary, rows, options) {
  const sizes = rows.map(adaptedBytes);
  const fullSizes = rows.map(row => Buffer.byteLength(JSON.stringify(row)));
  assert.deepEqual(summary, {
    requestedCount: options.count,
    emittedCount: rows.length,
    profile: options.profile,
    stage: options.stage,
    seed: options.seed,
    metadataSpecJsonBytes: {
      target: options.profile === 'standard' ? 1190 : 8882,
      min: sizes.length ? Math.min(...sizes) : null,
      max: sizes.length ? Math.max(...sizes) : null,
    },
    entityJsonBytes: {
      min: fullSizes.length ? Math.min(...fullSizes) : null,
      max: fullSizes.length ? Math.max(...fullSizes) : null,
    },
    descriptionRevisionCounts: revisionCounts(rows),
  });
}

test('default generator emits 1000 valid, ordered, uniquely named Components', () => {
  // Arrange
  const options = {};
  // Act
  const rows = [...generateSnapshot(options)];
  // Assert
  assert.equal(rows.length, 1000);
  const prefix = rows[0].metadata.name.slice(0, -7);
  assert.ok(prefix.length > 0);
  assert.equal(new Set(rows.map(row => row.metadata.name)).size, 1000);
  assert.equal(
    rows.reduce((total, row) => total + adaptedBytes(row), 0),
    1_190_000,
  );
  rows.forEach((row, index) => {
    assert.equal(row.apiVersion, 'backstage.io/v1alpha1');
    assert.equal(row.kind, 'Component');
    assert.equal(row.metadata.namespace, 'benchmark');
    assert.equal(
      row.metadata.name,
      `${prefix}${String(index + 1).padStart(7, '0')}`,
    );
    assert.match(row.metadata.name, /^[a-z0-9][a-z0-9_.-]*$/i);
    assert.match(row.metadata.description, /revision 0$/);
    for (const field of ['type', 'lifecycle', 'owner'])
      assert.ok(
        typeof row.spec[field] === 'string' && row.spec[field].length > 0,
      );
    assert.equal(adaptedBytes(row), 1190);
  });
  assert.deepEqual(rows, [
    ...generateSnapshot({
      count: 1000,
      profile: 'standard',
      stage: 'initial',
      seed,
    }),
  ]);
});

test('exports the agreed literal profile sizes and stage names', () => {
  // Arrange
  const expectedProfiles = { standard: 1190, heavy: 8882 };
  // Act
  const profiles = PROFILE_BYTES;
  const actualStages = STAGES;
  // Assert
  assert.deepEqual(profiles, expectedProfiles);
  assert.deepEqual(actualStages, stages);
});

for (const [profile, target] of [
  ['standard', 1190],
  ['heavy', 8882],
]) {
  test(`${profile} sizes metadata plus spec, not the full entity or wrapper`, () => {
    // Arrange
    const options = { count: 3, profile, seed: 'unicode seed 雪' };
    // Act
    const rows = [...generateSnapshot(options)];
    // Assert
    for (const row of rows) {
      assert.equal(adaptedBytes(row), target);
      assert.notEqual(Buffer.byteLength(JSON.stringify(row)), target);
      assert.notEqual(
        Buffer.byteLength(
          JSON.stringify({ metadata: row.metadata, spec: row.spec }),
        ),
        target,
      );
      assert.notEqual(adaptedBytes(row), profile === 'standard' ? 512 : 8192);
      const value = padding(row);
      assert.match(value, /^[a-f0-9]+$/);
      assert.notEqual(
        value.slice(0, 64),
        value.slice(64, 128),
        'SHA-256 blocks do not repeat',
      );
    }
    assert.notEqual(
      padding(rows[0]),
      padding(rows[1]),
      'IDs get distinct padding',
    );
  });
}

for (const count of [0, 1, 99, 101, 1000]) {
  for (const stage of stages) {
    test(`${stage} preserves identity/order and exact revision distribution for count ${count}`, () => {
      // Arrange
      const baseline = [...generateSnapshot({ count })];
      const expected = expectedRevisions(stage, count);
      // Act
      const rows = [...generateSnapshot({ count, stage })];
      // Assert
      assert.equal(
        rows.length,
        Object.values(expected).reduce((sum, value) => sum + value, 0),
      );
      assert.deepEqual(revisionCounts(rows), expected);
      rows.forEach((row, index) => {
        assert.deepEqual(
          withoutDescription(row),
          withoutDescription(baseline[index]),
          'only description may change',
        );
        if (stage === 'change-1pct')
          assert.match(
            row.metadata.description,
            (index + 1) % 100 === 0 ? /revision 1$/ : /revision 0$/,
          );
      });
      if (stage === 'initial' || stage === 'unchanged')
        assert.deepEqual(rows, baseline);
    });
  }
}

test('retention-labelled stage is byte-identical to revision-3', () => {
  // Arrange
  const options = { count: 101, profile: 'heavy', seed: 'retention fixture' };
  const previous = [
    ...generateSnapshot({ ...options, stage: 'revision-3' }),
  ].map(JSON.stringify);
  // Act
  const rows = [
    ...generateSnapshot({ ...options, stage: 'unchanged-after-retention' }),
  ].map(JSON.stringify);
  // Assert
  assert.deepEqual(rows, previous);
});

test('seed is reproducible, changes padding only, and IDs do not depend on total count', () => {
  // Arrange
  const options = { count: 3, seed: 'first seed' };
  // Act
  const first = [...generateSnapshot(options)];
  const repeat = [...generateSnapshot(options)];
  const larger = [...generateSnapshot({ ...options, count: 5 })];
  const otherSeed = [...generateSnapshot({ ...options, seed: 'other seed' })];
  // Assert
  assert.deepEqual(first, repeat);
  assert.deepEqual(first, larger.slice(0, 3));
  first.forEach((row, index) => {
    assert.notEqual(padding(row), padding(otherSeed[index]));
    const other = structuredClone(otherSeed[index]);
    other.metadata.annotations = row.metadata.annotations;
    assert.deepEqual(other, row);
  });
});

test('mutating a row cannot alter another row, later iterator rows, or subsequent snapshots', () => {
  // Arrange
  const iterator = generateSnapshot({ count: 3 });
  const first = iterator.next().value;
  const pristine = [...generateSnapshot({ count: 3 })];
  // Act
  first.metadata.description = 'mutated';
  first.metadata.annotations.extra = 'mutated';
  first.spec.owner = 'mutated';
  const second = iterator.next().value;
  const third = iterator.next().value;
  const nextSnapshot = [...generateSnapshot({ count: 3 })];
  // Assert
  assert.deepEqual(second, pristine[1]);
  assert.deepEqual(third, pristine[2]);
  assert.notEqual(second.metadata, third.metadata);
  assert.notEqual(second.metadata.annotations, third.metadata.annotations);
  assert.notEqual(second.spec, third.spec);
  assert.deepEqual(nextSnapshot, pristine);
});

test('generator allows consuming only a prefix at the maximum configured count', () => {
  // Arrange
  const iterator = generateSnapshot({ count: 1_000_000 });
  // Act
  const first = iterator.next();
  const second = iterator.next();
  iterator.return();
  // Assert
  assert.equal(first.done, false);
  assert.equal(second.done, false);
  assert.deepEqual(
    [first.value, second.value],
    [...generateSnapshot({ count: 2 })],
  );
});

const invalidOptions = [
  ...[-1, 1.5, 1_000_001, NaN, Infinity, -Infinity, '2', null].map(count => ({
    count,
  })),
  ...['unknown', '', 'toString', null].map(profile => ({ profile })),
  ...['revision-4', '', null].map(stage => ({ stage })),
  ...['', '   ', null, 42].map(value => ({ seed: value })),
];

for (const options of invalidOptions) {
  test(`invalid API options fail before emitting data: ${JSON.stringify(options)}`, async () => {
    // Arrange
    const output = captureOutput();
    // Act / Assert
    assert.throws(() => [...generateSnapshot(options)]);
    await assert.rejects(writeSnapshot(options, { stdout: output.stdout }));
    assert.equal(output.text(), '');
  });
}

for (const profile of ['standard', 'heavy']) {
  for (const stage of stages) {
    test(`writer reports actual JSONL sizes and revisions for ${profile}/${stage}`, async () => {
      // Arrange
      const output = captureOutput();
      const options = { count: 101, profile, stage, seed };
      // Act
      const summary = await writeSnapshot(options, { stdout: output.stdout });
      const rows = parseRows(output.text());
      // Assert
      assert.deepEqual(rows, [...generateSnapshot(options)]);
      assertSummary(summary, rows, options);
      assert.deepEqual(
        summary.descriptionRevisionCounts,
        expectedRevisions(stage, 101),
      );
      assert.equal(
        output.stdout.writableEnded,
        false,
        'caller owns stdout lifetime',
      );
      for (const row of rows)
        assert.equal(adaptedBytes(row), profile === 'standard' ? 1190 : 8882);
    });
  }
}

test('zero count emits no JSONL and reports null byte ranges', async () => {
  // Arrange
  const output = captureOutput();
  const options = { count: 0, profile: 'standard', stage: 'initial', seed };
  // Act
  const summary = await writeSnapshot(options, { stdout: output.stdout });
  // Assert
  assert.equal(output.text(), '');
  assertSummary(summary, [], options);
});

test('writer defaults match the default generator and summary contract', async () => {
  // Arrange
  const output = captureOutput();
  // Act
  const summary = await writeSnapshot(undefined, { stdout: output.stdout });
  const rows = parseRows(output.text());
  // Assert
  assert.deepEqual(rows, [...generateSnapshot()]);
  assertSummary(summary, rows, {
    count: 1000,
    profile: 'standard',
    stage: 'initial',
    seed,
  });
});

test('writer waits for a slow destination and does not finish before its last callback', async () => {
  // Arrange: manually release callbacks; no timing thresholds or sleeps.
  const chunks = [];
  const callbacks = [];
  let signalWrite;
  let nextWrite = new Promise(resolve => {
    signalWrite = resolve;
  });
  const stdout = new Writable({
    highWaterMark: 1,
    write(chunk, encoding, callback) {
      chunks.push(chunk.toString());
      callbacks.push(callback);
      signalWrite();
    },
  });
  let completed = false;
  // Act
  const pending = writeSnapshot({ count: 3 }, { stdout }).then(summary => {
    completed = true;
    return summary;
  });
  for (let index = 0; index < 3; index += 1) {
    await nextWrite;
    assert.equal(completed, false);
    assert.equal(
      chunks.length,
      index + 1,
      'writer does not flood the pending destination',
    );
    nextWrite = new Promise(resolve => {
      signalWrite = resolve;
    });
    callbacks.shift()();
  }
  const summary = await pending;
  // Assert
  assert.equal(summary.emittedCount, 3);
  assert.deepEqual(parseRows(chunks.join('')), [
    ...generateSnapshot({ count: 3 }),
  ]);
});

test('writer rejects a destination failure after partial output', async () => {
  // Arrange
  let writes = 0;
  const stdout = new Writable({
    write(chunk, encoding, callback) {
      writes += 1;
      callback(
        writes === 2 ? new Error('simulated output failure') : undefined,
      );
    },
  });
  // Act / Assert
  await assert.rejects(
    writeSnapshot({ count: 5 }, { stdout }),
    /simulated output failure/,
  );
  assert.equal(writes, 2);
});

test('file output contains only JSONL and does not write to injected stdout', async t => {
  // Arrange
  const outputPath = join(temporaryDirectory(t), 'snapshot.jsonl');
  const output = captureOutput();
  const options = { count: 3, profile: 'heavy', stage: 'restore', seed };
  // Act
  const summary = await writeSnapshot(options, {
    outputPath,
    stdout: output.stdout,
  });
  const rows = parseRows(readFileSync(outputPath, 'utf8'));
  // Assert
  assert.deepEqual(rows, [...generateSnapshot(options)]);
  assertSummary(summary, rows, options);
  assert.equal(output.text(), '');
});

test('file output refuses to overwrite an existing file', async t => {
  // Arrange
  const outputPath = join(temporaryDirectory(t), 'existing.jsonl');
  const original = Buffer.from('original bytes\n');
  writeFileSync(outputPath, original);
  // Act / Assert
  await assert.rejects(writeSnapshot({ count: 3 }, { outputPath }), {
    code: 'EEXIST',
  });
  assert.deepEqual(readFileSync(outputPath), original);
});

test('invalid API options do not create an output file', async t => {
  // Arrange
  const outputPath = join(temporaryDirectory(t), 'invalid.jsonl');
  // Act / Assert
  await assert.rejects(writeSnapshot({ count: -1 }, { outputPath }));
  assert.equal(existsSync(outputPath), false);
});

for (const outputPath of ['', null, 42]) {
  test(`writer rejects invalid outputPath ${JSON.stringify(outputPath)}`, async () => {
    // Arrange
    const output = captureOutput();
    // Act / Assert
    await assert.rejects(
      writeSnapshot({ count: 1 }, { outputPath, stdout: output.stdout }),
    );
    assert.equal(output.text(), '');
  });
}

test('CLI separates stdout JSONL from the final stderr summary', async () => {
  // Arrange
  const options = {
    count: 3,
    profile: 'heavy',
    stage: 'revision-2',
    seed: 'CLI seed',
  };
  // Act
  const { stdout, stderr } = await run(process.execPath, [
    script,
    '--count',
    '3',
    '--profile',
    options.profile,
    '--stage',
    options.stage,
    '--seed',
    options.seed,
  ]);
  // Assert
  const rows = parseRows(stdout);
  assert.deepEqual(rows, [...generateSnapshot(options)]);
  assertSummary(JSON.parse(stderr), rows, options);
});

test('CLI help emits usage, not data or a success summary', async () => {
  // Arrange
  const args = [script, '--help'];
  // Act
  const { stdout, stderr } = await run(process.execPath, args);
  // Assert
  assert.match(stdout, /usage:/i);
  for (const flag of ['count', 'profile', 'stage', 'seed', 'output', 'help'])
    assert.ok(stdout.includes(`--${flag}`));
  assert.equal(stderr, '');
  assert.ok(!stdout.includes('"apiVersion"'));
});

test('CLI accepts zero count and emits only the empty summary', async () => {
  // Arrange
  const options = { count: 0, profile: 'standard', stage: 'initial', seed };
  // Act
  const { stdout, stderr } = await run(process.execPath, [
    script,
    '--count',
    '0',
  ]);
  // Assert
  assert.equal(stdout, '');
  assertSummary(JSON.parse(stderr), [], options);
});

for (const args of [['--output'], ['--output', '']]) {
  test(`CLI rejects missing output value ${JSON.stringify(args)}`, async () => {
    // Arrange
    const commandArgs = [script, ...args];
    // Act / Assert
    await assert.rejects(run(process.execPath, commandArgs), error => {
      assert.equal(error.code, 1);
      assert.equal(error.stdout, '');
      assert.match(error.stderr, /missing|output/i);
      assert.ok(!error.stderr.includes('"emittedCount"'));
      return true;
    });
  });
}

const invalidArguments = [
  ['--unknown', 'value'],
  ['positional'],
  ['--count', '1', '--count', '2'],
  ['--profile', 'standard', '--profile', 'heavy'],
  ['--stage', 'initial', '--stage', 'restore'],
  ['--seed', 'one', '--seed', 'two'],
  ['--help', '--help'],
  ...['count', 'profile', 'stage', 'seed'].map(flag => [`--${flag}`]),
  ...['-1', '1.5', 'NaN', 'Infinity', '1000001', '1e3', ''].map(value => [
    '--count',
    value,
  ]),
  ['--profile', 'unknown'],
  ['--stage', 'unknown'],
  ['--seed', '   '],
  ['--seed', ''],
];

for (const args of invalidArguments) {
  test(`CLI rejects ${JSON.stringify(args)} before creating output`, async t => {
    // Arrange: put output first to catch parsers that open it prematurely.
    const outputPath = join(temporaryDirectory(t), 'invalid.jsonl');
    // Act / Assert
    await assert.rejects(
      run(process.execPath, [script, '--output', outputPath, ...args]),
      error => {
        assert.equal(error.code, 1);
        assert.equal(error.stdout, '');
        assert.ok(error.stderr.trim().length > 0);
        assert.ok(!error.stderr.includes('"emittedCount"'));
        return true;
      },
    );
    assert.equal(existsSync(outputPath), false);
  });
}

test('CLI output file succeeds once and preserves bytes on duplicate output or overwrite errors', async t => {
  // Arrange
  const directory = temporaryDirectory(t);
  const outputPath = join(directory, 'snapshot.jsonl');
  const options = { count: 2, profile: 'standard', stage: 'initial', seed };
  // Act
  const result = await run(process.execPath, [
    script,
    '--count',
    '2',
    '--output',
    outputPath,
  ]);
  const original = readFileSync(outputPath);
  // Assert
  assert.equal(result.stdout, '');
  assertSummary(
    JSON.parse(result.stderr),
    parseRows(original.toString()),
    options,
  );
  for (const args of [
    ['--count', '1', '--output', outputPath],
    ['--output', outputPath, '--output', join(directory, 'other.jsonl')],
  ]) {
    await assert.rejects(run(process.execPath, [script, ...args]), error => {
      assert.equal(error.code, 1);
      assert.equal(error.stdout, '');
      assert.ok(!error.stderr.includes('"emittedCount"'));
      return true;
    });
  }
  assert.deepEqual(readFileSync(outputPath), original);
  assert.equal(existsSync(join(directory, 'other.jsonl')), false);
});

test('CLI output failure never prints a success summary', async t => {
  // Arrange
  const outputPath = join(
    temporaryDirectory(t),
    'missing-parent',
    'snapshot.jsonl',
  );
  // Act / Assert
  await assert.rejects(
    run(process.execPath, [script, '--count', '2', '--output', outputPath]),
    error => {
      assert.equal(error.code, 1);
      assert.equal(error.stdout, '');
      assert.match(error.stderr, /ENOENT|no such file/i);
      assert.ok(!error.stderr.includes('"emittedCount"'));
      return true;
    },
  );
});
