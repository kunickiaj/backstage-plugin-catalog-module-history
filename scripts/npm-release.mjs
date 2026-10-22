import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
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
];

export function validateRelease(version, root = process.cwd()) {
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version ?? '')) {
    throw new Error('Supply an explicit stable version such as 0.1.0');
  }
  const names = new Set(PACKAGES.map(([name]) => name));
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
    for (const [dependency, range] of Object.entries(
      manifest.dependencies ?? {},
    )) {
      if (names.has(dependency) && ![version, `^${version}`].includes(range)) {
        throw new Error(
          `${name}: update ${dependency} to ${version} or ^${version}`,
        );
      }
    }
    return {
      name,
      version,
      archive: resolve(root, '.tmp/npm-release', `${directory}-${version}.tgz`),
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
  const files = new Set(
    run('tar', ['-tzf', pkg.archive], { encoding: 'utf8' }).trim().split('\n'),
  );
  for (const target of [
    manifest.main,
    manifest.types,
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
  if (
    manifest.files?.includes('migrations') &&
    ![...files].some(file => file.startsWith('package/migrations/'))
  ) {
    throw new Error(`${pkg.name}: missing migrations`);
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
  const packages = validateRelease(version, root);
  // Check all archives and registry versions before publishing any package.
  const plan = packages.map(pkg => {
    const integrity = inspectArchive(pkg, run);
    const existing = registryIntegrity(pkg, run);
    if (existing && existing !== integrity) {
      throw new Error(
        `${pkg.name}@${version} already exists with different bytes; do not overwrite it`,
      );
    }
    return { ...pkg, published: existing === integrity };
  });
  for (const pkg of plan) {
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
