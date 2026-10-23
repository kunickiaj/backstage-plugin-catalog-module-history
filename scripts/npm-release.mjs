import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const REGISTRY = 'https://registry.npmjs.org';
export const REPOSITORY = 'kunickiaj/backstage-plugin-catalog-module-history';
export const PACKAGES = [
  [
    '@kunickiaj/backstage-plugin-catalog-history-common',
    'catalog-history-common',
  ],
  ['@kunickiaj/backstage-plugin-catalog-history-node', 'catalog-history-node'],
  [
    '@kunickiaj/backstage-plugin-catalog-history-storage-node',
    'catalog-history-backend',
  ],
  [
    '@kunickiaj/backstage-plugin-catalog-backend-module-history',
    'catalog-backend-module-history',
  ],
  ['@kunickiaj/backstage-plugin-catalog-history', 'catalog-history'],
];

function validateInternalDependencies(
  manifest,
  version,
  { allowWorkspace = false } = {},
) {
  const names = new Set(PACKAGES.map(([name]) => name));
  for (const field of [
    'dependencies',
    'optionalDependencies',
    'peerDependencies',
  ]) {
    for (const [dependency, range] of Object.entries(manifest[field] ?? {})) {
      if (typeof range === 'string' && range.startsWith('workspace:')) {
        if (
          allowWorkspace &&
          names.has(dependency) &&
          range === 'workspace:^'
        ) {
          continue;
        }
        throw new Error(
          `${manifest.name}: unresolved or unsupported workspace dependency ${dependency}`,
        );
      }
      if (names.has(dependency) && ![version, `^${version}`].includes(range)) {
        throw new Error(
          `${manifest.name}: update ${dependency} to ${version} or ^${version}`,
        );
      }
    }
  }
}

function requiredMigrationFiles(manifest, root, directory) {
  if (!manifest.files?.includes('migrations')) {
    if (
      manifest.name ===
      '@kunickiaj/backstage-plugin-catalog-history-storage-node'
    ) {
      throw new Error(`${manifest.name}: must declare migration files`);
    }
    return [];
  }
  const files = readdirSync(
    resolve(root, 'packages', directory, 'migrations'),
    {
      withFileTypes: true,
    },
  )
    .filter(file => file.isFile() && file.name.endsWith('.js'))
    .map(file => `package/migrations/${file.name}`)
    .sort();
  if (!files.length) throw new Error(`${manifest.name}: missing migrations`);
  return files;
}

export function validateRelease(version, root = process.cwd()) {
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version ?? '')) {
    throw new Error('Supply an explicit stable version such as 0.1.0');
  }
  return PACKAGES.map(([name, directory]) => {
    const manifest = JSON.parse(
      readFileSync(
        resolve(root, 'packages', directory, 'package.json'),
        'utf8',
      ),
    );
    if (manifest.name !== name || manifest.version !== version) {
      throw new Error(`${name} must have version ${version}`);
    }
    if (manifest.private || manifest.publishConfig?.access !== 'public') {
      throw new Error(`${name} must explicitly permit public publication`);
    }
    validateInternalDependencies(manifest, version, { allowWorkspace: true });
    return {
      name,
      version,
      archive: resolve(root, '.tmp/npm-release', `${directory}-${version}.tgz`),
      requiredFiles: requiredMigrationFiles(manifest, root, directory),
    };
  });
}

function exportFiles(exports) {
  if (typeof exports === 'string')
    return exports.startsWith('./') ? [exports] : [];
  if (!exports || typeof exports !== 'object') return [];
  return Object.values(exports).flatMap(exportFiles);
}

export function inspectArchive(pkg, run = execFileSync) {
  const manifest = JSON.parse(
    run('tar', ['-xOf', pkg.archive, 'package/package.json'], {
      encoding: 'utf8',
    }),
  );
  if (
    manifest.name !== pkg.name ||
    manifest.version !== pkg.version ||
    manifest.private
  ) {
    throw new Error(
      `Archive identity does not match ${pkg.name}@${pkg.version}`,
    );
  }
  validateInternalDependencies(manifest, pkg.version);
  const files = new Set(
    run('tar', ['-tzf', pkg.archive], { encoding: 'utf8' }).trim().split('\n'),
  );
  const frontend = pkg.name === '@kunickiaj/backstage-plugin-catalog-history';
  if (
    frontend &&
    (typeof manifest.module !== 'string' ||
      !/^(?:\.\/)?dist\/.+\.(?:js|mjs)$/.test(manifest.module))
  ) {
    throw new Error(`${pkg.name}: missing compiled ESM module entry point`);
  }
  for (const target of [
    manifest.main,
    manifest.types,
    ...(manifest.module === undefined ? [] : [manifest.module]),
    ...exportFiles(manifest.exports),
  ]) {
    if (
      typeof target !== 'string' ||
      !files.has(`package/${target.replace(/^\.\//, '')}`)
    ) {
      throw new Error(`${pkg.name}: missing packed entry point ${target}`);
    }
    if (target.includes('src/'))
      throw new Error(`${pkg.name}: source entry point ${target}`);
  }
  if (!files.has('package/LICENSE'))
    throw new Error(`${pkg.name}: missing LICENSE`);
  for (const file of files) {
    if (
      /^package\/(?:[^/]+\/)*(?:src|dev|fixture|fixtures|__fixtures__)\//.test(
        file,
      )
    ) {
      throw new Error(
        `${pkg.name}: forbidden packed source or fixture ${file}`,
      );
    }
  }
  for (const file of pkg.requiredFiles) {
    if (!files.has(file)) throw new Error(`${pkg.name}: missing ${file}`);
  }
  if (
    frontend &&
    ![...files].some(file =>
      /^package\/dist\/.+\.css(?:\.esm\.js)?$/.test(file),
    )
  ) {
    throw new Error(`${pkg.name}: missing compiled CSS asset`);
  }
  return `sha512-${createHash('sha512').update(readFileSync(pkg.archive)).digest('base64')}`;
}

export function registryIntegrity(pkg, run = execFileSync) {
  let output;
  try {
    output = run(
      'npm',
      [
        'view',
        `${pkg.name}@${pkg.version}`,
        'dist.integrity',
        '--json',
        '--registry',
        REGISTRY,
      ],
      {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
  } catch (error) {
    let code;
    try {
      code = JSON.parse(String(error.stdout)).error?.code;
    } catch {
      // An unrecognized error is not proof that a version is absent.
    }
    if (code === 'E404') return undefined;
    throw new Error(
      `Registry lookup failed for ${pkg.name}@${pkg.version}${code ? ` (${code})` : ''}`,
    );
  }
  const integrity = JSON.parse(output);
  if (
    typeof integrity !== 'string' ||
    !/^sha512-[A-Za-z0-9+/]{86}==$/.test(integrity) ||
    Buffer.from(integrity.slice(7), 'base64').toString('base64') !==
      integrity.slice(7)
  ) {
    throw new Error(
      `Registry returned invalid integrity for ${pkg.name}@${pkg.version}`,
    );
  }
  return integrity;
}

export function registryPackageExists(name, run = execFileSync) {
  let output;
  try {
    output = run(
      'npm',
      ['view', name, 'name', '--json', '--registry', REGISTRY],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
  } catch (error) {
    let code;
    try {
      code = JSON.parse(String(error.stdout)).error?.code;
    } catch {
      // Only a structured registry E404 proves that the name is absent.
    }
    if (code === 'E404') return false;
    throw new Error(
      `Registry package lookup failed for ${name}${code ? ` (${code})` : ''}`,
    );
  }
  if (JSON.parse(output) !== name) {
    throw new Error(`Registry returned an invalid package name for ${name}`);
  }
  return true;
}

function bootstrapFrontendRequested(env) {
  if (
    env.BOOTSTRAP_FRONTEND !== undefined &&
    !['true', 'false'].includes(env.BOOTSTRAP_FRONTEND)
  ) {
    throw new Error('BOOTSTRAP_FRONTEND must be true or false');
  }
  return env.BOOTSTRAP_FRONTEND === 'true';
}

function validateFrontendPublicationMode({ bootstrapFrontend, run }) {
  const name = PACKAGES[4][0];
  const exists = registryPackageExists(name, run);
  if (bootstrapFrontend && exists) {
    throw new Error(`${name} already exists; disable frontend bootstrap`);
  }
  if (!bootstrapFrontend && !exists) {
    throw new Error(
      `${name} is unpublished; an explicitly approved frontend bootstrap is required`,
    );
  }
}

export function packRelease(
  version,
  { root = process.cwd(), run = execFileSync } = {},
) {
  const packages = validateRelease(version, root);
  mkdirSync(resolve(root, '.tmp/npm-release'), { recursive: true });
  for (const pkg of packages) {
    run('yarn', ['workspace', pkg.name, 'pack', '--out', pkg.archive], {
      cwd: root,
      stdio: 'inherit',
    });
    inspectArchive(pkg, run);
  }
  return packages;
}

export function assertPublishingContext(env) {
  if (
    env.GITHUB_ACTIONS !== 'true' ||
    env.GITHUB_EVENT_NAME !== 'workflow_dispatch' ||
    env.GITHUB_REF !== 'refs/heads/main' ||
    env.GITHUB_REPOSITORY !== REPOSITORY
  ) {
    throw new Error(
      "Publishing requires a manual run from this repository's main branch",
    );
  }
  if (
    !env.ACTIONS_ID_TOKEN_REQUEST_URL ||
    !env.ACTIONS_ID_TOKEN_REQUEST_TOKEN
  ) {
    throw new Error('Publishing requires GitHub Actions OIDC permission');
  }
}

export function publishRelease(
  version,
  { root = process.cwd(), run = execFileSync, env = process.env } = {},
) {
  assertPublishingContext(env);
  const bootstrapFrontend = bootstrapFrontendRequested(env);
  const packages = validateRelease(version, root);
  validateFrontendPublicationMode({ bootstrapFrontend, run });
  // Check all archives and registry versions before publishing any package.
  const plan = packages.map(pkg => {
    const integrity = inspectArchive(pkg, run);
    const existing = registryIntegrity(pkg, run);
    if (existing && existing !== integrity) {
      throw new Error(
        `${pkg.name}@${version} already exists with different bytes; do not overwrite it`,
      );
    }
    return {
      ...pkg,
      published: existing === integrity,
      deferred: bootstrapFrontend && pkg.name === PACKAGES[4][0],
      integrity,
    };
  });
  if (bootstrapFrontend && plan[4].published) {
    throw new Error(
      'Frontend version already exists; disable frontend bootstrap',
    );
  }
  for (const pkg of plan) {
    if (pkg.deferred) {
      console.log(
        `Manual frontend publication pending: ${pkg.name}@${version}; use validated archive ${pkg.archive}`,
      );
      console.log(`Validated frontend integrity: ${pkg.integrity}`);
      continue;
    }
    if (pkg.published) {
      console.log(
        `Already published with matching integrity: ${pkg.name}@${version}`,
      );
      continue;
    }
    run(
      'npm',
      [
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
      ],
      {
        cwd: root,
        stdio: 'inherit',
      },
    );
  }
  return plan;
}

export function main([command, version], env = process.env) {
  bootstrapFrontendRequested(env);
  if (
    env.PUBLISH_REQUESTED === 'true' &&
    env.GITHUB_REPOSITORY !== REPOSITORY
  ) {
    throw new Error('A publish request must use the upstream repository');
  }
  if (
    env.PUBLISH_REQUESTED === 'true' &&
    env.GITHUB_REF !== 'refs/heads/main'
  ) {
    throw new Error('A publish request must select main');
  }
  if (command === 'validate') return validateRelease(version);
  if (command === 'pack') return packRelease(version);
  if (command === 'publish') return publishRelease(version, { env });
  throw new Error(
    'Usage: node scripts/npm-release.mjs <validate|pack|publish> <version>',
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
