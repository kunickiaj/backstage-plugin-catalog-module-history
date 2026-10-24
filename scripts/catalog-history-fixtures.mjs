import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { pathToFileURL } from 'node:url';

export const PROFILE_BYTES = Object.freeze({ standard: 1190, heavy: 8882 });
export const STAGES = Object.freeze([
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
]);

function validateOptions(options) {
  const {
    count = 1000,
    profile = 'standard',
    stage = 'initial',
    seed = 'catalog-history-benchmark-v1',
  } = options;
  if (!Number.isInteger(count) || count < 0 || count > 1_000_000) {
    throw new Error('count must be an integer between 0 and 1000000');
  }
  if (typeof profile !== 'string' || !Object.hasOwn(PROFILE_BYTES, profile)) {
    throw new Error('profile must be standard or heavy');
  }
  if (!STAGES.includes(stage)) {
    throw new Error(`stage must be one of: ${STAGES.join(', ')}`);
  }
  if (typeof seed !== 'string' || seed.trim().length === 0) {
    throw new Error('seed must be a nonempty string');
  }
  return { count, profile, stage, seed };
}

function descriptionRevision(stage, id) {
  if (stage === 'initial' || stage === 'unchanged') return 0;
  if (stage === 'change-1pct') return id % 100 === 0 ? 1 : 0;
  const revisions = {
    'revision-1': 3,
    'revision-2': 4,
    'revision-3': 5,
    'unchanged-after-retention': 5,
  };
  return revisions[stage] ?? 2;
}

function metadataSpecBytes(entity) {
  return (
    Buffer.byteLength(JSON.stringify(entity.metadata)) +
    Buffer.byteLength(JSON.stringify(entity.spec))
  );
}

function createPadding(seed, id, length) {
  let padding = '';
  for (let block = 0; padding.length < length; block += 1) {
    padding += createHash('sha256')
      .update(JSON.stringify([seed, id, block]))
      .digest('hex');
  }
  return padding.slice(0, length);
}

function createEntity({ profile, stage, seed }, id) {
  const paddedId = String(id).padStart(7, '0');
  const entity = {
    apiVersion: 'backstage.io/v1alpha1',
    kind: 'Component',
    metadata: {
      name: `benchmark-project-${paddedId}`,
      namespace: 'benchmark',
      description: `Synthetic project ${paddedId} revision 0`,
      annotations: { 'example.com/history-benchmark-padding': '' },
    },
    spec: {
      type: 'service',
      lifecycle: 'experimental',
      owner: 'group:default/benchmark-team',
    },
  };
  // Size means compact UTF-8 metadata + spec, not the full Entity or JSONL.
  const paddingLength = PROFILE_BYTES[profile] - metadataSpecBytes(entity);
  entity.metadata.annotations['example.com/history-benchmark-padding'] =
    createPadding(seed, id, paddingLength);
  entity.metadata.description = `Synthetic project ${paddedId} revision ${descriptionRevision(stage, id)}`;
  return entity;
}

export function* generateSnapshot(options = {}) {
  const validated = validateOptions(options);
  if (validated.stage === 'remove-all') return;
  let emittedCount = validated.count;
  if (validated.stage === 'remove-half') {
    emittedCount = Math.ceil(validated.count / 2);
  }
  for (let id = 1; id <= emittedCount; id += 1) {
    yield createEntity(validated, id);
  }
}

function createSummary({ count, profile, stage, seed }) {
  return {
    requestedCount: count,
    emittedCount: 0,
    profile,
    stage,
    seed,
    metadataSpecJsonBytes: {
      target: PROFILE_BYTES[profile],
      min: null,
      max: null,
    },
    entityJsonBytes: { min: null, max: null },
    descriptionRevisionCounts: { 0: 0, 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 },
  };
}

function recordSize(range, bytes) {
  range.min = range.min === null ? bytes : Math.min(range.min, bytes);
  range.max = range.max === null ? bytes : Math.max(range.max, bytes);
}

function* serializeSnapshot(options, summary) {
  for (const entity of generateSnapshot(options)) {
    const json = JSON.stringify(entity);
    recordSize(summary.metadataSpecJsonBytes, metadataSpecBytes(entity));
    recordSize(summary.entityJsonBytes, Buffer.byteLength(json));
    const revision = entity.metadata.description.match(/revision ([0-5])$/)[1];
    summary.descriptionRevisionCounts[revision] += 1;
    summary.emittedCount += 1;
    yield `${json}\n`;
  }
}

async function writeToStdout(rows, stdout) {
  // Wait for each write callback without ending the caller's stream.
  const destination = new Writable({
    write(chunk, encoding, callback) {
      stdout.write(chunk, encoding, callback);
    },
  });
  const onError = error => destination.destroy(error);
  stdout.on('error', onError);
  try {
    await pipeline(rows, destination);
  } finally {
    stdout.off('error', onError);
  }
}

export async function writeSnapshot(
  options = {},
  { outputPath, stdout = process.stdout } = {},
) {
  const validated = validateOptions(options);
  if (
    outputPath !== undefined &&
    (typeof outputPath !== 'string' || outputPath.length === 0)
  ) {
    throw new Error('outputPath must be a nonempty string');
  }
  const summary = createSummary(validated);
  const rows = serializeSnapshot(validated, summary);
  if (outputPath !== undefined) {
    await pipeline(rows, createWriteStream(outputPath, { flags: 'wx' }));
  } else {
    await writeToStdout(rows, stdout);
  }
  return summary;
}

const HELP = `Usage: node scripts/catalog-history-fixtures.mjs [options]

Emit deterministic Backstage Entity JSONL, with a JSON summary on stderr.
  --count N       Entity count, 0..1000000 (default: 1000)
  --profile NAME  standard (1190) or heavy (8882 metadata+spec JSON bytes)
  --stage NAME    Snapshot stage (default: initial)
  --seed TEXT     Padding seed (default: catalog-history-benchmark-v1)
  --output PATH   Create a new file; never overwrite an existing file
  --help          Show this help

Stages: ${STAGES.join(', ')}
This generates data only; it does not run providers, databases, or retention.
`;

function parseArgs(args) {
  const options = {};
  const seen = new Set();
  const allowed = new Set([
    'count',
    'profile',
    'stage',
    'seed',
    'output',
    'help',
  ]);
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    const key = flag.startsWith('--') ? flag.slice(2) : '';
    if (!allowed.has(key)) throw new Error(`Unknown option: ${flag}`);
    if (seen.has(key)) throw new Error(`Duplicate option: ${flag}`);
    seen.add(key);
    if (key === 'help') {
      options.help = true;
      continue;
    }
    const value = args[index + 1];
    if (value === undefined || value.startsWith('--') || value.length === 0) {
      throw new Error(`Missing value for ${flag}`);
    }
    index += 1;
    if (key === 'count' && !/^\d+$/.test(value)) {
      throw new Error('count must be an integer between 0 and 1000000');
    }
    options[key] = key === 'count' ? Number(value) : value;
  }
  validateOptions(options);
  return options;
}

export async function main(args = process.argv.slice(2)) {
  const { output, help, ...options } = parseArgs(args);
  if (help) {
    await writeToStdout([HELP], process.stdout);
    return;
  }
  const summary = await writeSnapshot(options, { outputPath: output });
  await new Promise((resolve, reject) => {
    process.stderr.write(`${JSON.stringify(summary)}\n`, error => {
      if (error) reject(error);
      else resolve();
    });
  });
  return summary;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch(error => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
