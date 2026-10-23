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
  registryPackageExists,
  REPOSITORY,
  validateRelease,
} from './npm-release.mjs';

const VERSION = '0.2.0';
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
    module: 'dist/index.esm.js',
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
    mkdirSync(join(path, 'migrations'));
    writeFileSync(join(path, 'migrations/001.js'), 'module.exports = {};');
    writeFileSync(join(path, 'migrations/002.js'), 'module.exports = {};');
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
      requiredFiles: ['package/migrations/001.js', 'package/migrations/002.js'],
      manifest: data,
      files: [
        ...packedFiles,
        'package/migrations/002.js',
        ...(name === '@kunickiaj/backstage-plugin-catalog-history'
          ? ['package/dist/components/History.module.css.esm.js']
          : []),
      ],
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
function runner(
  packages,
  { existing = new Map(), frontendExists = true, failPublish } = {},
) {
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
      if (args[1] === PACKAGES[4][0]) {
        assert.deepEqual(args, [
          'view',
          PACKAGES[4][0],
          'name',
          '--json',
          '--registry',
          REGISTRY,
        ]);
        if (!frontendExists) throw registryError('E404');
        return JSON.stringify(PACKAGES[4][0]);
      }
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

test('validates all five shared-version packages, not the private workspace root', t => {
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
      '@kunickiaj/backstage-plugin-catalog-history-common',
      '@kunickiaj/backstage-plugin-catalog-history-node',
      '@kunickiaj/backstage-plugin-catalog-history-storage-node',
      '@kunickiaj/backstage-plugin-catalog-backend-module-history',
      '@kunickiaj/backstage-plugin-catalog-history',
    ],
  );
  assert.ok(result.every(pkg => pkg.version === VERSION));
  assert.deepEqual(
    result,
    PACKAGES.map(([name, directory]) => ({
      name,
      version: VERSION,
      archive: join(root, '.tmp/npm-release', `${directory}-${VERSION}.tgz`),
      requiredFiles: ['package/migrations/001.js', 'package/migrations/002.js'],
    })),
  );
  assert.equal(
    JSON.parse(readFileSync(join(root, 'package.json'))).private,
    true,
  );
});

test('derives every migration requirement from source JavaScript files in sorted order', t => {
  // Arrange: only declared migrations/*.js files belong in the archive contract.
  const { root } = fixture(t);
  const migrations = join(root, 'packages', PACKAGES[2][1], 'migrations');
  writeFileSync(join(migrations, '000.js'), 'module.exports = {};');
  writeFileSync(join(migrations, 'notes.txt'), 'not a migration');
  mkdirSync(join(migrations, 'nested.js'));
  // Act
  const result = validateRelease(VERSION, root);
  // Assert
  assert.deepEqual(result[2].requiredFiles, [
    'package/migrations/000.js',
    'package/migrations/001.js',
    'package/migrations/002.js',
  ]);
});

for (const field of [
  'dependencies',
  'optionalDependencies',
  'peerDependencies',
]) {
  test(`accepts coordinated source workspace:^ references in ${field}`, t => {
    // Arrange: each package references another approved release package.
    const { root } = fixture(t);
    PACKAGES.forEach((_, index) => {
      updateManifest(root, index, data => {
        data[field] = {
          [PACKAGES[(index + 1) % PACKAGES.length][0]]: 'workspace:^',
        };
      });
    });
    // Act
    const result = validateRelease(VERSION, root);
    // Assert
    assert.equal(result.length, 5);
    assert.ok(result.every(pkg => pkg.version === VERSION));
  });
}

test('workspace references do not hide a target package with a different version', t => {
  // Arrange
  const { root } = fixture(t);
  PACKAGES.forEach((_, index) => {
    updateManifest(root, index, data => {
      for (const field of [
        'dependencies',
        'optionalDependencies',
        'peerDependencies',
      ]) {
        data[field] = { [PACKAGES.at(-1)[0]]: 'workspace:^' };
      }
    });
  });
  updateManifest(root, PACKAGES.length - 1, data => {
    data.version = '0.3.0';
  });
  // Act / Assert
  assert.throws(
    () => validateRelease(VERSION, root),
    /must have version 0\.2\.0/,
  );
});

test('does not require migrations for a package that does not declare them', t => {
  // Arrange
  const { root } = fixture(t);
  updateManifest(root, 0, data => {
    data.files = ['dist'];
  });
  rmSync(join(root, 'packages', PACKAGES[0][1], 'migrations'), {
    recursive: true,
  });
  // Act
  const result = validateRelease(VERSION, root);
  // Assert
  assert.deepEqual(result[0].requiredFiles, []);
});

test('storage must declare migrations before any packing or publishing subprocess', t => {
  // Arrange: migration source files exist, but the package allowlist omits them.
  const { root, packages } = fixture(t);
  updateManifest(root, 2, data => {
    data.files = ['dist'];
  });
  const { run, calls } = runner(packages);
  // Act / Assert
  assert.throws(
    () => validateRelease(VERSION, root),
    /must declare migration files/,
  );
  assert.throws(
    () => packRelease(VERSION, { root, run }),
    /must declare migration files/,
  );
  assert.throws(
    () => publishRelease(VERSION, { root, run, env: context }),
    /must declare migration files/,
  );
  assert.equal(calls.length, 0);
});

for (const state of ['missing', 'empty', 'no JavaScript files']) {
  test(`rejects a declared migration directory that is ${state}`, t => {
    // Arrange
    const { root } = fixture(t);
    const migrations = join(root, 'packages', PACKAGES[2][1], 'migrations');
    rmSync(migrations, { recursive: true });
    if (state !== 'missing') mkdirSync(migrations);
    if (state === 'no JavaScript files') {
      writeFileSync(join(migrations, '001.ts'), 'export {};');
    }
    // Act / Assert
    assert.throws(() => validateRelease(VERSION, root), /migrations/);
  });
}

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
      data.version = '0.3.0';
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
    'unsupported workspace wildcard range',
    data => {
      data.dependencies[PACKAGES[0][0]] = 'workspace:*';
    },
    /unsupported workspace dependency/,
  ],
  [
    'unsupported workspace tilde range',
    data => {
      data.optionalDependencies = { [PACKAGES[0][0]]: 'workspace:~' };
    },
    /unsupported workspace dependency/,
  ],
  [
    'unknown workspace target',
    data => {
      data.peerDependencies = { 'unknown-package': 'workspace:^' };
    },
    /unsupported workspace dependency/,
  ],
]) {
  test(`rejects ${label} even in the final package`, t => {
    // Arrange
    const { root } = fixture(t);
    updateManifest(root, PACKAGES.length - 1, change);
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
      pkg.manifest.version = '0.3.0';
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
  delete packages[0].manifest.module;
  packages[0].manifest.files = ['dist'];
  packages[0].requiredFiles = [];
  packages[0].files = packages[0].files.filter(
    file => !file.includes('/migrations/'),
  );
  const { run } = runner(packages);
  // Act
  const integrity = inspectArchive(packages[0], run);
  // Assert
  assert.equal(integrity, packages[0].integrity);
});

test('rejects a storage archive missing one of multiple source migrations', t => {
  // Arrange: one surviving migration must not hide another missing migration.
  const { root, packages } = fixture(t);
  const storage = packages[2];
  storage.requiredFiles = validateRelease(VERSION, root)[2].requiredFiles;
  storage.files = storage.files.filter(
    file => file !== 'package/migrations/002.js',
  );
  const { run } = runner(packages);
  // Act / Assert
  assert.throws(() => inspectArchive(storage, run), /migrations\/002\.js/);
});

test('accepts an ESM-only frontend with a nonpath Backstage export marker', t => {
  // Arrange: the actual frontend build has no CommonJS entry point.
  const { packages } = fixture(t);
  const frontend = packages.at(-1);
  frontend.manifest.main = 'dist/index.esm.js';
  frontend.manifest.exports = {
    '.': {
      backstage: '@backstage/FrontendPlugin',
      import: './dist/index.esm.js',
      types: './dist/index.d.ts',
      default: './dist/index.esm.js',
    },
  };
  frontend.files = frontend.files.filter(
    file => !file.endsWith('index.cjs.js'),
  );
  const { run } = runner(packages);
  // Act
  const integrity = inspectArchive(frontend, run);
  // Assert
  assert.equal(integrity, frontend.integrity);
});

test('an ESM frontend export cannot hide a missing CommonJS main before publishing', t => {
  // Arrange: a stale main still points to a file absent from the ESM-only build.
  const { root, packages } = fixture(t);
  const frontend = packages.at(-1);
  frontend.manifest.exports = {
    '.': {
      backstage: '@backstage/FrontendPlugin',
      import: './dist/index.esm.js',
      types: './dist/index.d.ts',
      default: './dist/index.esm.js',
    },
  };
  frontend.files = frontend.files.filter(
    file => !file.endsWith('index.cjs.js'),
  );
  const { run, calls } = runner(packages);
  // Act / Assert
  assert.throws(
    () => publishRelease(VERSION, { root, run, env: context }),
    /missing packed entry point dist\/index\.cjs\.js/,
  );
  assert.equal(calls.filter(call => call.args[0] === 'publish').length, 0);
});

for (const css of [
  'package/dist/components/History.module.css.esm.js',
  'package/dist/components/History.module.css',
]) {
  test(`accepts the frontend compiled module with CSS asset ${css}`, t => {
    // Arrange
    const { packages } = fixture(t);
    const frontend = packages.at(-1);
    frontend.files = frontend.files.filter(file => !file.includes('.css'));
    frontend.files.push(css);
    const { run } = runner(packages);
    // Act
    const integrity = inspectArchive(frontend, run);
    // Assert
    assert.equal(integrity, frontend.integrity);
  });
}

for (const [label, change, message] of [
  [
    'missing CSS',
    pkg => {
      pkg.files = pkg.files.filter(file => !file.includes('.css'));
    },
    /CSS/,
  ],
  [
    'missing module declaration',
    pkg => {
      delete pkg.manifest.module;
    },
    /module entry point/,
  ],
  [
    'missing module file',
    pkg => {
      pkg.manifest.module = 'dist/missing.esm.js';
    },
    /entry point/,
  ],
  [
    'raw source module',
    pkg => {
      pkg.manifest.module = 'src/index.ts';
      pkg.files.push('package/src/index.ts');
    },
    /module entry point|source entry point/,
  ],
  [
    'declarations instead of a compiled module',
    pkg => {
      pkg.manifest.module = 'dist/index.d.ts';
    },
    /module entry point/,
  ],
  [
    'stale packed internal dependency',
    pkg => {
      pkg.manifest.dependencies[PACKAGES[0][0]] = '^0.0.1';
    },
    /update/,
  ],
]) {
  test(`frontend ${label} fails archive preflight before any publish`, t => {
    // Arrange: source manifests stay valid while the final packed artifact changes.
    const { root, packages } = fixture(t);
    change(packages.at(-1));
    const { run, calls } = runner(packages);
    // Act / Assert
    assert.throws(
      () => publishRelease(VERSION, { root, run, env: context }),
      message,
    );
    assert.equal(calls.filter(call => call.args[0] === 'publish').length, 0);
  });
}

test('validates an optional nonfrontend module entry point when supplied', t => {
  // Arrange
  const { packages } = fixture(t);
  packages[0].manifest.module = 'dist/missing.esm.js';
  const { run } = runner(packages);
  // Act / Assert
  assert.throws(() => inspectArchive(packages[0], run), /entry point/);
});

for (const field of [
  'dependencies',
  'optionalDependencies',
  'peerDependencies',
]) {
  for (const dependency of [PACKAGES[0][0], 'unknown-package']) {
    test(`unresolved packed workspace reference in ${field} to ${dependency} prevents every publish`, t => {
      // Arrange: source stays valid; only the final archive retains workspace syntax.
      const { root, packages } = fixture(t);
      packages.at(-1).manifest[field] = { [dependency]: 'workspace:^' };
      const { run, calls } = runner(packages);
      // Act / Assert
      assert.throws(
        () => publishRelease(VERSION, { root, run, env: context }),
        /unresolved or unsupported workspace dependency/,
      );
      assert.equal(calls.filter(call => call.args[0] === 'publish').length, 0);
    });
  }
}

for (const field of ['optionalDependencies', 'peerDependencies']) {
  test(`stale packed numeric internal range in ${field} prevents every publish`, t => {
    // Arrange
    const { root, packages } = fixture(t);
    packages.at(-1).manifest[field] = { [PACKAGES[0][0]]: '^0.1.0' };
    const { run, calls } = runner(packages);
    // Act / Assert
    assert.throws(
      () => publishRelease(VERSION, { root, run, env: context }),
      /update/,
    );
    assert.equal(calls.filter(call => call.args[0] === 'publish').length, 0);
  });
}

for (const range of [VERSION, `^${VERSION}`]) {
  test(`accepts packed internal range ${range} in every runtime dependency field`, t => {
    // Arrange
    const { packages } = fixture(t);
    for (const field of [
      'dependencies',
      'optionalDependencies',
      'peerDependencies',
    ]) {
      packages.at(-1).manifest[field] = { [PACKAGES[0][0]]: range };
    }
    const { run } = runner(packages);
    // Act
    const integrity = inspectArchive(packages.at(-1), run);
    // Assert
    assert.equal(integrity, packages.at(-1).integrity);
  });
}

test('preserves normal external npm ranges in source and packed runtime dependencies', t => {
  // Arrange
  const { root, packages } = fixture(t);
  const externalRanges = {
    dependencies: { 'external-package': '^1.2.3' },
    optionalDependencies: { 'optional-package': '~2.3.4' },
    peerDependencies: { 'peer-package': '>=3 <5' },
  };
  updateManifest(root, PACKAGES.length - 1, data => {
    Object.assign(data, externalRanges);
  });
  Object.assign(packages.at(-1).manifest, externalRanges);
  const { run } = runner(packages);
  // Act
  const release = validateRelease(VERSION, root);
  const integrity = inspectArchive(packages.at(-1), run);
  // Assert
  assert.equal(release.length, 5);
  assert.equal(integrity, packages.at(-1).integrity);
});

for (const [index, [name]] of PACKAGES.entries()) {
  for (const leaked of [
    'package/src/index.ts',
    'package/dev/index.js',
    'package/dist/dev/index.js',
    'package/dist/fixtures/entity.json',
  ]) {
    test(`rejects leaked ${leaked} in ${name}`, t => {
      // Arrange: unrelated valid entry points must not conceal excluded files.
      const { packages } = fixture(t);
      packages[index].files.push(leaked);
      const { run } = runner(packages);
      // Act / Assert
      assert.throws(
        () => inspectArchive(packages[index], run),
        /source|fixture|dev/,
      );
    });
  }
}

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

test('package existence checks the unversioned name against the public registry', () => {
  // Arrange: only the exact requested name proves that this package exists.
  const name = PACKAGES[4][0];
  const calls = [];
  const run = (...args) => {
    calls.push(args);
    return JSON.stringify(name);
  };
  // Act
  const exists = registryPackageExists(name, run);
  // Assert
  assert.equal(exists, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'npm');
  assert.deepEqual(calls[0][1], [
    'view',
    name,
    'name',
    '--json',
    '--registry',
    REGISTRY,
  ]);
  assert.equal(calls[0][2].encoding, 'utf8');
  assert.equal(calls[0][2].shell ?? false, false);
});

test('package existence treats only a structured E404 failure as absent', () => {
  // Arrange
  const run = () => {
    throw registryError('E404');
  };
  // Act
  const exists = registryPackageExists(PACKAGES[4][0], run);
  // Assert
  assert.equal(exists, false);
});

for (const error of [
  registryError('E401'),
  registryError('E403'),
  registryError('E500'),
  registryError('ETIMEDOUT'),
  Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }),
  registryError('E404', 'not JSON: E404'),
  registryError(undefined, '{}'),
]) {
  test(`package existence fails closed for ${error.stdout ?? error.code}`, () => {
    // Arrange
    const run = () => {
      throw error;
    };
    // Act / Assert
    assert.throws(() => registryPackageExists(PACKAGES[4][0], run));
  });
}

for (const output of [
  'not JSON',
  '',
  'null',
  '{}',
  '42',
  'true',
  JSON.stringify([PACKAGES[4][0]]),
  JSON.stringify({ name: PACKAGES[4][0] }),
  JSON.stringify(PACKAGES[0][0]),
  JSON.stringify(`${PACKAGES[4][0]}@${VERSION}`),
  JSON.stringify({ error: { code: 'E404' } }),
]) {
  test(`package existence rejects unexpected response ${JSON.stringify(output)}`, () => {
    // Arrange
    const run = () => output;
    // Act / Assert
    assert.throws(() => registryPackageExists(PACKAGES[4][0], run));
  });
}

test('packs and inspects all packages serially with argument arrays', t => {
  // Arrange
  const { root, packages } = fixture(t);
  const { run, calls } = runner(packages);
  // Act
  const result = packRelease(VERSION, { root, run });
  // Assert
  assert.equal(result.length, 5);
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
  const versionedCalls = calls.filter(call => call.args[1] !== PACKAGES[4][0]);
  assert.deepEqual(
    versionedCalls
      .slice(0, PACKAGES.length * 3)
      .map(call => [call.command, call.args[0]]),
    PACKAGES.flatMap(() => [
      ['tar', '-xOf'],
      ['tar', '-tzf'],
      ['npm', 'view'],
    ]),
  );
  assert.deepEqual(
    versionedCalls.slice(PACKAGES.length * 3).map(call => call.args),
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
  assert.ok(
    versionedCalls
      .slice(PACKAGES.length * 3)
      .every(call => call.options.cwd === root),
  );
  assert.ok(plan.every(pkg => pkg.published === false));
  assert.ok(plan.every(pkg => pkg.deferred === false));
  assert.ok(
    calls.findIndex(call => call.args[1] === PACKAGES[4][0]) <
      calls.findIndex(call => call.args[0] === 'publish'),
  );
});

for (const failure of ['archive', 'integrity']) {
  test(`final-package ${failure} mismatch prevents every publish`, t => {
    // Arrange
    const { root, packages } = fixture(t);
    const existing = new Map();
    const frontend = packages.at(-1);
    assert.equal(frontend.name, '@kunickiaj/backstage-plugin-catalog-history');
    if (failure === 'archive') frontend.manifest.version = '0.3.0';
    else existing.set(frontend.name, packages[0].integrity);
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
    [true, false, true, false, false],
  );
  assert.deepEqual(
    calls.filter(call => call.args[0] === 'publish').map(call => call.args[1]),
    [packages[1].archive, packages[3].archive, packages[4].archive],
  );
  assert.equal(calls.filter(call => call.args[0] === 'view').length, 6);
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
  assert.equal(calls.length, PACKAGES.length * 3 + 1);
});

test('a final frontend registry error prevents every publish', t => {
  // Arrange
  const { root, packages } = fixture(t);
  const simulated = runner(packages);
  const run = (command, args, options) => {
    if (
      command === 'npm' &&
      args[0] === 'view' &&
      args[1] === `${packages.at(-1).name}@${VERSION}`
    ) {
      throw registryError('E500');
    }
    return simulated.run(command, args, options);
  };
  // Act / Assert
  assert.throws(
    () => publishRelease(VERSION, { root, run, env: context }),
    /Registry lookup failed/,
  );
  assert.equal(
    simulated.calls.filter(call => call.args[0] === 'publish').length,
    0,
  );
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

for (const bootstrap of [undefined, 'false']) {
  test(`normal publication (${bootstrap}) refuses an absent frontend name before publishing`, t => {
    // Arrange: every exact target version is absent too.
    const { root, packages } = fixture(t);
    const { run, calls } = runner(packages, { frontendExists: false });
    // Act / Assert
    assert.throws(
      () =>
        publishRelease(VERSION, {
          root,
          run,
          env: { ...context, BOOTSTRAP_FRONTEND: bootstrap },
        }),
      /frontend|bootstrap/i,
    );
    assert.equal(calls.filter(call => call.args[0] === 'publish').length, 0);
  });
}

test('explicit false keeps normal five-package publishing when the frontend name exists', t => {
  // Arrange: the name exists at a prior version, but no target version exists.
  const { root, packages } = fixture(t);
  const { run, calls } = runner(packages);
  // Act
  const plan = publishRelease(VERSION, {
    root,
    run,
    env: { ...context, BOOTSTRAP_FRONTEND: 'false' },
  });
  // Assert
  assert.deepEqual(
    calls.filter(call => call.args[0] === 'publish').map(call => call.args[1]),
    packages.map(pkg => pkg.archive),
  );
  assert.ok(plan.every(pkg => pkg.deferred === false));
});

for (const matching of [[], [0, 2], [0, 1, 2, 3]]) {
  test(`bootstrap defers only the frontend with matching backend indexes ${matching}`, t => {
    // Arrange: bootstrap must still inspect all five archives and exact versions.
    const { root, packages } = fixture(t);
    const existing = new Map(
      matching.map(index => [packages[index].name, packages[index].integrity]),
    );
    const { run, calls } = runner(packages, {
      frontendExists: false,
      existing,
    });
    const log = t.mock.method(console, 'log', () => {});
    // Act
    const plan = publishRelease(VERSION, {
      root,
      run,
      env: { ...context, BOOTSTRAP_FRONTEND: 'true' },
    });
    // Assert
    assert.deepEqual(
      plan.map(pkg => pkg.deferred),
      [false, false, false, false, true],
    );
    assert.deepEqual(
      plan.map(pkg => pkg.published),
      packages.map((_, index) => matching.includes(index)),
    );
    assert.deepEqual(
      calls
        .filter(call => call.args[0] === 'publish')
        .map(call => call.args[1]),
      packages
        .slice(0, 4)
        .filter((_, index) => !matching.includes(index))
        .map(pkg => pkg.archive),
    );
    const firstPublish = calls.findIndex(call => call.args[0] === 'publish');
    const preflights =
      firstPublish === -1 ? calls : calls.slice(0, firstPublish);
    assert.deepEqual(
      preflights
        .filter(call => call.args[0] === '-xOf')
        .map(call => call.args[1]),
      packages.map(pkg => pkg.archive),
    );
    assert.deepEqual(
      preflights
        .filter(call => call.args[0] === '-tzf')
        .map(call => call.args[1]),
      packages.map(pkg => pkg.archive),
    );
    assert.deepEqual(
      preflights
        .filter(call => call.args[2] === 'dist.integrity')
        .map(call => call.args[1]),
      packages.map(pkg => `${pkg.name}@${VERSION}`),
    );
    assert.ok(
      log.mock.calls.some(
        call =>
          call.arguments[0] ===
          `Manual frontend publication pending: ${packages[4].name}@${VERSION}; use validated archive ${packages[4].archive}`,
      ),
    );
  });
}

test('bootstrap refuses an existing frontend name even when its target version is absent', t => {
  // Arrange
  const { root, packages } = fixture(t);
  const { run, calls } = runner(packages);
  // Act / Assert
  assert.throws(
    () =>
      publishRelease(VERSION, {
        root,
        run,
        env: { ...context, BOOTSTRAP_FRONTEND: 'true' },
      }),
    /exist|bootstrap/i,
  );
  assert.equal(calls.filter(call => call.args[0] === 'publish').length, 0);
});

test('bootstrap refuses inconsistent absent-name and existing-version registry responses', t => {
  // Arrange: simulate inconsistent registry responses without bypassing integrity checks.
  const { root, packages } = fixture(t);
  const frontend = packages[4];
  const { run, calls } = runner(packages, {
    frontendExists: false,
    existing: new Map([[frontend.name, frontend.integrity]]),
  });
  // Act / Assert
  assert.throws(
    () =>
      publishRelease(VERSION, {
        root,
        run,
        env: { ...context, BOOTSTRAP_FRONTEND: 'true' },
      }),
    /already exists|bootstrap/i,
  );
  assert.equal(calls.filter(call => call.args[0] === 'publish').length, 0);
});

test('bootstrap refuses different bytes in a previously published backend before any publish', t => {
  // Arrange: retry safety applies to the four nondeferred packages too.
  const { root, packages } = fixture(t);
  const { run, calls } = runner(packages, {
    frontendExists: false,
    existing: new Map([[packages[3].name, packages[0].integrity]]),
  });
  // Act / Assert
  assert.throws(
    () =>
      publishRelease(VERSION, {
        root,
        run,
        env: { ...context, BOOTSTRAP_FRONTEND: 'true' },
      }),
    /different bytes/,
  );
  assert.equal(calls.filter(call => call.args[0] === 'publish').length, 0);
});

for (const failure of ['archive', 'integrity', 'registry', 'name lookup']) {
  test(`bootstrap final frontend ${failure} failure prevents all backend publishes`, t => {
    // Arrange: deferring the frontend cannot bypass any preflight.
    const { root, packages } = fixture(t);
    const existing = new Map();
    if (failure === 'archive') packages[4].manifest.version = '0.3.0';
    if (failure === 'integrity')
      existing.set(packages[4].name, packages[0].integrity);
    const simulated = runner(packages, { frontendExists: false, existing });
    const run = (command, args, options) => {
      const target =
        failure === 'name lookup'
          ? packages[4].name
          : `${packages[4].name}@${VERSION}`;
      if (
        ['registry', 'name lookup'].includes(failure) &&
        command === 'npm' &&
        args[0] === 'view' &&
        args[1] === target
      )
        throw registryError('E401');
      return simulated.run(command, args, options);
    };
    // Act / Assert
    assert.throws(() =>
      publishRelease(VERSION, {
        root,
        run,
        env: { ...context, BOOTSTRAP_FRONTEND: 'true' },
      }),
    );
    assert.equal(
      simulated.calls.filter(call => call.args[0] === 'publish').length,
      0,
    );
  });
}

test('bootstrap stops on a backend publish failure and a retry skips matching successful bytes', t => {
  // Arrange
  const { root, packages } = fixture(t);
  const first = runner(packages, {
    frontendExists: false,
    failPublish: packages[1].name,
  });
  const retry = runner(packages, {
    frontendExists: false,
    existing: new Map([[packages[0].name, packages[0].integrity]]),
  });
  const env = { ...context, BOOTSTRAP_FRONTEND: 'true' };
  t.mock.method(console, 'log', () => {});
  // Act / Assert: the failed attempt cannot publish dependents.
  assert.throws(
    () => publishRelease(VERSION, { root, run: first.run, env }),
    /Simulated publish failure/,
  );
  assert.deepEqual(
    first.calls
      .filter(call => call.args[0] === 'publish')
      .map(call => call.args[1]),
    [packages[0].archive, packages[1].archive],
  );
  // Act
  const plan = publishRelease(VERSION, { root, run: retry.run, env });
  // Assert
  assert.equal(plan[0].published, true);
  assert.deepEqual(
    retry.calls
      .filter(call => call.args[0] === 'publish')
      .map(call => call.args[1]),
    packages.slice(1, 4).map(pkg => pkg.archive),
  );
});

for (const value of [
  '',
  'TRUE',
  'False',
  '1',
  'true ',
  'frontend',
  true,
  false,
  null,
]) {
  test(`invalid bootstrap flag ${JSON.stringify(value)} fails before subprocesses in publishRelease and main`, t => {
    // Arrange
    const { root, packages } = fixture(t);
    const { run, calls } = runner(packages);
    const env = { ...context, BOOTSTRAP_FRONTEND: value };
    const subprocess = t.mock.method(childProcess, 'execFileSync', () =>
      assert.fail('No child process permitted'),
    );
    syncBuiltinESMExports();
    t.after(() => {
      subprocess.mock.restore();
      syncBuiltinESMExports();
    });
    // Act / Assert
    assert.throws(
      () => publishRelease(VERSION, { root, run, env }),
      /BOOTSTRAP_FRONTEND|bootstrap/i,
    );
    for (const command of ['validate', 'pack', 'publish']) {
      assert.throws(
        () => main([command, VERSION], env),
        /BOOTSTRAP_FRONTEND|bootstrap/i,
      );
    }
    assert.equal(calls.length, 0);
    assert.equal(subprocess.mock.callCount(), 0);
  });
}

test('accepts only the manual main-branch repository context with OIDC', () => {
  // Arrange
  const env = { ...context };
  // Act / Assert
  assert.doesNotThrow(() => assertPublishingContext(env));
});

test('does not fall back to npm tokens when OIDC is absent', t => {
  // Arrange: these are fake inputs, not changes to the process environment.
  const { root, packages } = fixture(t);
  const env = {
    ...context,
    ACTIONS_ID_TOKEN_REQUEST_URL: '',
    ACTIONS_ID_TOKEN_REQUEST_TOKEN: '',
    NODE_AUTH_TOKEN: 'test-only-placeholder',
    NPM_TOKEN: 'test-only-placeholder',
  };
  const { run, calls } = runner(packages);
  // Act / Assert
  assert.throws(() => publishRelease(VERSION, { root, run, env }), /OIDC/);
  assert.equal(calls.length, 0);
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
  assert.equal(packages.length, 5);
  assert.equal(subprocess.mock.callCount(), 0);
});

for (const [key, value] of [
  ['GITHUB_ACTIONS', 'false'],
  ['GITHUB_EVENT_NAME', 'push'],
  ['GITHUB_EVENT_NAME', 'pull_request'],
  ['GITHUB_REF', 'refs/heads/feature'],
  ['GITHUB_REF', 'refs/tags/0.2.0'],
  ['GITHUB_REPOSITORY', `fork/${REPOSITORY.split('/')[1]}`],
  ['ACTIONS_ID_TOKEN_REQUEST_URL', ''],
  ['ACTIONS_ID_TOKEN_REQUEST_TOKEN', ''],
]) {
  test(`bootstrap cannot bypass publishing restriction ${key}=${value}`, t => {
    // Arrange
    const { root, packages } = fixture(t);
    const { run, calls } = runner(packages, { frontendExists: false });
    const env = {
      ...context,
      BOOTSTRAP_FRONTEND: 'true',
      [key]: value,
      NODE_AUTH_TOKEN: 'test-only-placeholder',
      NPM_TOKEN: 'test-only-placeholder',
    };
    const subprocess = t.mock.method(childProcess, 'execFileSync', () =>
      assert.fail('No child process permitted'),
    );
    syncBuiltinESMExports();
    t.after(() => {
      subprocess.mock.restore();
      syncBuiltinESMExports();
    });
    // Act / Assert
    assert.throws(
      () => publishRelease(VERSION, { root, run, env }),
      /Publishing requires/,
    );
    assert.throws(() => main(['publish', VERSION], env), /Publishing requires/);
    assert.equal(calls.length, 0);
    assert.equal(subprocess.mock.callCount(), 0);
  });
}

for (const command of ['validate', 'pack']) {
  for (const [key, value, message] of [
    [
      'GITHUB_REPOSITORY',
      `fork/${REPOSITORY.split('/')[1]}`,
      /upstream repository/,
    ],
    ['GITHUB_REF', 'refs/heads/feature', /must select main/],
  ]) {
    test(`bootstrap main ${command} preserves publish-request restriction ${key}`, t => {
      // Arrange
      const env = {
        ...context,
        BOOTSTRAP_FRONTEND: 'true',
        PUBLISH_REQUESTED: 'true',
        [key]: value,
      };
      const subprocess = t.mock.method(childProcess, 'execFileSync', () =>
        assert.fail('No child process permitted'),
      );
      syncBuiltinESMExports();
      t.after(() => {
        subprocess.mock.restore();
        syncBuiltinESMExports();
      });
      // Act / Assert
      assert.throws(() => main([command, VERSION], env), message);
      assert.equal(subprocess.mock.callCount(), 0);
    });
  }
}

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
