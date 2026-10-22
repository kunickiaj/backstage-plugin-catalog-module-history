import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  assertPublishingContext,
  inspectArchive,
  main,
  PACKAGES,
  packRelease,
  publishRelease,
  REGISTRY,
  registryIntegrity,
  REPOSITORY,
  validateRelease,
} from './npm-release.mjs';

const VERSION = '0.1.0';
const context = {
  GITHUB_ACTIONS: 'true',
  GITHUB_EVENT_NAME: 'workflow_dispatch',
  GITHUB_REF: 'refs/heads/main',
  GITHUB_REPOSITORY: REPOSITORY,
  ACTIONS_ID_TOKEN_REQUEST_URL: 'https://oidc.example.test',
  ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'test-only-placeholder',
};
const packedFiles = [
  'package/package.json',
  'package/dist/index.cjs.js',
  'package/dist/index.d.ts',
  'package/dist/index.esm.js',
  'package/LICENSE',
  'package/migrations/001.js',
];

function manifest(name) {
  return {
    name,
    version: VERSION,
    publishConfig: { access: 'public' },
    main: 'dist/index.cjs.js',
    types: 'dist/index.d.ts',
    exports: {
      '.': {
        import: './dist/index.esm.js',
        require: './dist/index.cjs.js',
        types: './dist/index.d.ts',
      },
    },
    files: ['dist', 'migrations'],
    dependencies: { [PACKAGES[0][0]]: `^${VERSION}` },
  };
}

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'npm-release-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, 'package.json'), JSON.stringify({ private: true }));
  const packages = PACKAGES.map(([name, directory], index) => {
    const path = join(root, 'packages', directory);
    mkdirSync(path, { recursive: true });
    const data = manifest(name);
    writeFileSync(join(path, 'package.json'), JSON.stringify(data));
    const archive = join(
      root,
      '.tmp/npm-release',
      `${directory}-${VERSION}.tgz`,
    );
    mkdirSync(join(root, '.tmp/npm-release'), { recursive: true });
    const bytes = Buffer.from(`fixture archive ${index}\n`);
    writeFileSync(archive, bytes);
    return {
      name,
      version: VERSION,
      archive,
      manifest: data,
      files: [...packedFiles],
      integrity: `sha512-${createHash('sha512').update(bytes).digest('base64')}`,
    };
  });
  return { root, packages };
}

function updateManifest(root, index, change) {
  const path = join(root, 'packages', PACKAGES[index][1], 'package.json');
  const data = JSON.parse(readFileSync(path, 'utf8'));
  change(data);
  writeFileSync(path, JSON.stringify(data));
}

function registryError(code, stdout = JSON.stringify({ error: { code } })) {
  return Object.assign(new Error('Simulated registry failure'), { stdout });
}

// Every subprocess is simulated; unexpected commands fail instead of falling back.
function runner(packages, { existing = new Map(), failPublish } = {}) {
  const calls = [];
  const run = (command, args, options) => {
    calls.push({ command, args, options });
    assert.equal(options.shell ?? false, false);
    if (command === 'yarn' && args[0] === 'workspace') return '';
    if (command === 'tar') {
      const pkg = packages.find(item => item.archive === args[1]);
      assert.ok(pkg, 'tar must inspect a known archive');
      if (args[0] === '-xOf') return JSON.stringify(pkg.manifest);
      if (args[0] === '-tzf') return pkg.files.join('\n');
    }
    if (command === 'npm' && args[0] === 'view') {
      const pkg = packages.find(item => `${item.name}@${VERSION}` === args[1]);
      assert.ok(pkg, 'registry lookup must use an exact package version');
      if (!existing.has(pkg.name)) throw registryError('E404');
      return JSON.stringify(existing.get(pkg.name));
    }
    if (command === 'npm' && args[0] === 'publish') {
      const pkg = packages.find(item => item.archive === args[1]);
      assert.ok(pkg, 'publish must use a preflighted archive');
      if (pkg.name === failPublish)
        throw new Error('Simulated publish failure');
      return '';
    }
    assert.fail(`Unexpected subprocess: ${command} ${args.join(' ')}`);
  };
  return { run, calls };
}

test('validates all four shared-version packages, not the private workspace root', t => {
  // Arrange
  const { root } = fixture(t);
  updateManifest(root, 1, data => {
    data.dependencies[PACKAGES[0][0]] = VERSION;
  });
  // Act
  const result = validateRelease(VERSION, root);
  // Assert
  assert.deepEqual(
    result.map(pkg => pkg.name),
    [
      '@kunickiaj/catalog-history-common',
      '@kunickiaj/catalog-history-node',
      '@kunickiaj/catalog-history-backend',
      'backstage-plugin-catalog-backend-module-history',
    ],
  );
  assert.ok(result.every(pkg => pkg.version === VERSION));
  assert.equal(
    JSON.parse(readFileSync(join(root, 'package.json'))).private,
    true,
  );
});

for (const version of [
  undefined,
  '',
  'v0.1.0',
  '01.1.0',
  '0.1',
  '0.1.0-beta.1',
  '0.1.0+build',
  '0.1.0;echo unsafe',
  '--registry=other',
  '0.1.0\n',
]) {
  test(`rejects malformed or nonstable version ${JSON.stringify(version)}`, t => {
    // Arrange
    const { root } = fixture(t);
    // Act / Assert
    assert.throws(
      () => validateRelease(version, root),
      /explicit stable version/,
    );
  });
}

for (const [label, change, message] of [
  [
    'wrong name',
    data => {
      data.name = 'different-package';
    },
    /must have version/,
  ],
  [
    'different version',
    data => {
      data.version = '0.2.0';
    },
    /must have version/,
  ],
  [
    'private package',
    data => {
      data.private = true;
    },
    /public publication/,
  ],
  [
    'missing public config',
    data => {
      delete data.publishConfig;
    },
    /public publication/,
  ],
  [
    'restricted access',
    data => {
      data.publishConfig.access = 'restricted';
    },
    /public publication/,
  ],
  [
    'stale internal range',
    data => {
      data.dependencies[PACKAGES[0][0]] = '^0.0.1';
    },
    /update/,
  ],
  [
    'workspace internal range',
    data => {
      data.dependencies[PACKAGES[0][0]] = 'workspace:^';
    },
    /update/,
  ],
]) {
  test(`rejects ${label} even in the final package`, t => {
    // Arrange
    const { root } = fixture(t);
    updateManifest(root, 3, change);
    // Act / Assert
    assert.throws(() => validateRelease(VERSION, root), message);
  });
}

test('checks nested export targets and hashes the exact archive bytes with SHA-512', t => {
  // Arrange
  const { packages } = fixture(t);
  const { run, calls } = runner(packages);
  // Act
  const integrity = inspectArchive(packages[0], run);
  // Assert
  assert.equal(integrity, packages[0].integrity);
  assert.deepEqual(
    calls.map(call => call.args),
    [
      ['-xOf', packages[0].archive, 'package/package.json'],
      ['-tzf', packages[0].archive],
    ],
  );
});

for (const [label, change, message] of [
  [
    'wrong archive name',
    pkg => {
      pkg.manifest.name = 'wrong';
    },
    /identity/,
  ],
  [
    'wrong archive version',
    pkg => {
      pkg.manifest.version = '0.2.0';
    },
    /identity/,
  ],
  [
    'private archive',
    pkg => {
      pkg.manifest.private = true;
    },
    /identity/,
  ],
  [
    'absent main field',
    pkg => {
      delete pkg.manifest.main;
    },
    /entry point/,
  ],
  [
    'absent types field',
    pkg => {
      delete pkg.manifest.types;
    },
    /entry point/,
  ],
  [
    'missing main file',
    pkg => {
      pkg.files = pkg.files.filter(file => !file.endsWith('index.cjs.js'));
    },
    /entry point/,
  ],
  [
    'missing types file',
    pkg => {
      pkg.files = pkg.files.filter(file => !file.endsWith('index.d.ts'));
    },
    /entry point/,
  ],
  [
    'missing nested export file',
    pkg => {
      pkg.files = pkg.files.filter(file => !file.endsWith('index.esm.js'));
    },
    /entry point/,
  ],
  [
    'missing LICENSE',
    pkg => {
      pkg.files = pkg.files.filter(file => !file.endsWith('LICENSE'));
    },
    /LICENSE/,
  ],
  [
    'missing declared migrations',
    pkg => {
      pkg.files = pkg.files.filter(file => !file.includes('/migrations/'));
    },
    /migrations/,
  ],
  [
    'source entry point',
    pkg => {
      pkg.manifest.main = 'src/index.ts';
      pkg.files.push('package/src/index.ts');
    },
    /source entry point/,
  ],
]) {
  test(`rejects ${label}`, t => {
    // Arrange
    const { packages } = fixture(t);
    change(packages[0]);
    const { run } = runner(packages);
    // Act / Assert
    assert.throws(() => inspectArchive(packages[0], run), message);
  });
}

test('accepts a direct export and packages without declared migrations', t => {
  // Arrange
  const { packages } = fixture(t);
  packages[0].manifest.exports = './dist/index.esm.js';
  packages[0].manifest.files = ['dist'];
  packages[0].files = packages[0].files.filter(
    file => !file.includes('/migrations/'),
  );
  const { run } = runner(packages);
  // Act
  const integrity = inspectArchive(packages[0], run);
  // Assert
  assert.equal(integrity, packages[0].integrity);
});

test('reads registry integrity using an exact version and explicit public registry', t => {
  // Arrange
  const { packages } = fixture(t);
  const { run, calls } = runner(packages, {
    existing: new Map([[packages[0].name, packages[0].integrity]]),
  });
  // Act
  const result = registryIntegrity(packages[0], run);
  // Assert
  assert.equal(result, packages[0].integrity);
  assert.deepEqual(calls[0].args, [
    'view',
    `${packages[0].name}@${VERSION}`,
    'dist.integrity',
    '--json',
    '--registry',
    REGISTRY,
  ]);
});

test('treats structured E404 as absent', t => {
  // Arrange
  const { packages } = fixture(t);
  const { run } = runner(packages);
  // Act
  const result = registryIntegrity(packages[0], run);
  // Assert
  assert.equal(result, undefined);
});

for (const error of [
  registryError('E401'),
  registryError('E500'),
  registryError('E404', 'not JSON: E404'),
  registryError(undefined, '{}'),
]) {
  test(`fails closed for registry error ${error.stdout}`, t => {
    // Arrange
    const { packages } = fixture(t);
    const run = () => {
      throw error;
    };
    // Act / Assert
    assert.throws(
      () => registryIntegrity(packages[0], run),
      /Registry lookup failed/,
    );
  });
}

for (const output of [
  'not JSON',
  'null',
  '{}',
  '42',
  '"sha256-abc"',
  '"sha512-"',
  '"sha512-not-base64!"',
]) {
  test(`rejects malformed registry integrity ${output}`, t => {
    // Arrange
    const { packages } = fixture(t);
    const run = () => output;
    // Act / Assert
    assert.throws(() => registryIntegrity(packages[0], run));
  });
}

test('packs and inspects all packages serially with argument arrays', t => {
  // Arrange
  const { root, packages } = fixture(t);
  const { run, calls } = runner(packages);
  // Act
  const result = packRelease(VERSION, { root, run });
  // Assert
  assert.equal(result.length, 4);
  assert.deepEqual(
    calls.map(call => call.command),
    PACKAGES.flatMap(() => ['yarn', 'tar', 'tar']),
  );
  assert.deepEqual(
    calls.filter(call => call.command === 'yarn').map(call => call.args),
    packages.map(pkg => ['workspace', pkg.name, 'pack', '--out', pkg.archive]),
  );
  assert.ok(
    calls
      .filter(call => call.command === 'yarn')
      .every(call => call.options.cwd === root),
  );
});

test('stops packing after a broken archive', t => {
  // Arrange
  const { root, packages } = fixture(t);
  packages[1].manifest.private = true;
  const { run, calls } = runner(packages);
  // Act / Assert
  assert.throws(() => packRelease(VERSION, { root, run }), /identity/);
  assert.equal(calls.filter(call => call.command === 'yarn').length, 2);
});

test('finishes every archive and registry preflight before publishing in dependency order', t => {
  // Arrange
  const { root, packages } = fixture(t);
  const { run, calls } = runner(packages);
  // Act
  const plan = publishRelease(VERSION, { root, run, env: context });
  // Assert
  assert.deepEqual(
    calls.slice(0, 12).map(call => [call.command, call.args[0]]),
    PACKAGES.flatMap(() => [
      ['tar', '-xOf'],
      ['tar', '-tzf'],
      ['npm', 'view'],
    ]),
  );
  assert.deepEqual(
    calls.slice(12).map(call => call.args),
    packages.map(pkg => [
      'publish',
      pkg.archive,
      '--access',
      'public',
      '--tag',
      'latest',
      '--provenance',
      '--ignore-scripts',
      '--registry',
      REGISTRY,
    ]),
  );
  assert.ok(calls.slice(12).every(call => call.options.cwd === root));
  assert.ok(plan.every(pkg => pkg.published === false));
});

for (const failure of ['archive', 'integrity']) {
  test(`final-package ${failure} mismatch prevents every publish`, t => {
    // Arrange
    const { root, packages } = fixture(t);
    const existing = new Map();
    if (failure === 'archive') packages[3].manifest.version = '0.2.0';
    else existing.set(packages[3].name, packages[0].integrity);
    const { run, calls } = runner(packages, { existing });
    // Act / Assert
    assert.throws(
      () => publishRelease(VERSION, { root, run, env: context }),
      /identity|different bytes/,
    );
    assert.equal(calls.filter(call => call.args[0] === 'publish').length, 0);
  });
}

test('partial retry skips only exact integrity matches and preserves serial dependency order', t => {
  // Arrange
  const { root, packages } = fixture(t);
  const existing = new Map(
    [0, 2].map(index => [packages[index].name, packages[index].integrity]),
  );
  const { run, calls } = runner(packages, { existing });
  t.mock.method(console, 'log', () => {});
  // Act
  const plan = publishRelease(VERSION, { root, run, env: context });
  // Assert
  assert.deepEqual(
    plan.map(pkg => pkg.published),
    [true, false, true, false],
  );
  assert.deepEqual(
    calls.filter(call => call.args[0] === 'publish').map(call => call.args[1]),
    [packages[1].archive, packages[3].archive],
  );
  assert.equal(calls.filter(call => call.args[0] === 'view').length, 4);
});

test('a fully published retry performs preflights but never publishes', t => {
  // Arrange
  const { root, packages } = fixture(t);
  const { run, calls } = runner(packages, {
    existing: new Map(packages.map(pkg => [pkg.name, pkg.integrity])),
  });
  t.mock.method(console, 'log', () => {});
  // Act
  const plan = publishRelease(VERSION, { root, run, env: context });
  // Assert
  assert.ok(plan.every(pkg => pkg.published));
  assert.equal(calls.length, 12);
});

test('a failed publish stops the remaining dependent packages', t => {
  // Arrange
  const { root, packages } = fixture(t);
  const { run, calls } = runner(packages, { failPublish: packages[1].name });
  // Act / Assert
  assert.throws(
    () => publishRelease(VERSION, { root, run, env: context }),
    /Simulated publish failure/,
  );
  assert.deepEqual(
    calls.filter(call => call.args[0] === 'publish').map(call => call.args[1]),
    [packages[0].archive, packages[1].archive],
  );
});

test('accepts only the manual main-branch repository context with OIDC', () => {
  // Arrange
  const env = { ...context };
  // Act / Assert
  assert.doesNotThrow(() => assertPublishingContext(env));
});

for (const [key, value] of [
  ['GITHUB_ACTIONS', 'false'],
  ['GITHUB_EVENT_NAME', 'push'],
  ['GITHUB_EVENT_NAME', 'pull_request'],
  ['GITHUB_REF', 'refs/heads/feature'],
  ['GITHUB_REF', 'refs/tags/0.1.0'],
  ['GITHUB_REPOSITORY', `fork/${REPOSITORY.split('/')[1]}`],
  ['ACTIONS_ID_TOKEN_REQUEST_URL', ''],
  ['ACTIONS_ID_TOKEN_REQUEST_TOKEN', ''],
]) {
  test(`rejects publishing when ${key} is ${JSON.stringify(value)}`, t => {
    // Arrange
    const { root, packages } = fixture(t);
    const env = { ...context, [key]: value };
    const { run, calls } = runner(packages);
    // Act / Assert
    assert.throws(() => assertPublishingContext(env), /Publishing requires/);
    assert.throws(
      () => publishRelease(VERSION, { root, run, env }),
      /Publishing requires/,
    );
    assert.equal(calls.length, 0);
  });
}

test('main validates the private-root release without executing any subprocess', t => {
  // Arrange
  const { root } = fixture(t);
  const previous = process.cwd();
  process.chdir(root);
  const subprocess = t.mock.method(childProcess, 'execFileSync', () =>
    assert.fail('No child process permitted'),
  );
  syncBuiltinESMExports();
  t.after(() => {
    process.chdir(previous);
    subprocess.mock.restore();
    syncBuiltinESMExports();
  });
  // Act
  const packages = main(['validate', VERSION], {});
  // Assert
  assert.equal(packages.length, 4);
  assert.equal(subprocess.mock.callCount(), 0);
});

for (const [args, env, message] of [
  [['publish', '0.1.0;echo unsafe'], context, /explicit stable version/],
  [['unknown', VERSION], context, /Usage/],
  [[], {}, /Usage/],
  [
    ['validate', VERSION],
    {
      ...context,
      GITHUB_REPOSITORY: `fork/${REPOSITORY.split('/')[1]}`,
      PUBLISH_REQUESTED: 'true',
    },
    /upstream repository/,
  ],
  [
    ['publish', VERSION],
    { ...context, GITHUB_REF: 'refs/heads/feature' },
    /manual run/,
  ],
  [
    ['validate', VERSION],
    { ...context, GITHUB_REF: 'refs/heads/feature', PUBLISH_REQUESTED: 'true' },
    /must select main/,
  ],
  [
    ['pack', VERSION],
    { ...context, GITHUB_REF: 'refs/heads/feature', PUBLISH_REQUESTED: 'true' },
    /must select main/,
  ],
]) {
  test(`main refuses ${JSON.stringify(args)} before any subprocess`, t => {
    // Arrange
    const subprocess = t.mock.method(childProcess, 'execFileSync', () =>
      assert.fail('No child process permitted'),
    );
    syncBuiltinESMExports();
    t.after(() => {
      subprocess.mock.restore();
      syncBuiltinESMExports();
    });
    // Act / Assert
    assert.throws(() => main(args, env), message);
    assert.equal(subprocess.mock.callCount(), 0);
  });
}
