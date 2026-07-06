// Symlinks this package into its own node_modules so `resolvePackagePath`
// (and any other package-name-based lookup) works during in-repo development
// and tests. Yarn workspaces handle this automatically in monorepos; we
// re-create the same effect for this standalone repo.
//
// Wired in via the `postinstall` script. Must be a no-op when invoked from a
// consumer's `node_modules/<pkg>/scripts/` after `npm install` — in that
// context the package is already in `node_modules` and there is nothing to
// symlink, and we must not throw or attempt fs writes outside our own dir.
const fs = require('node:fs');
const path = require('node:path');

const pkgRoot = path.resolve(__dirname, '..');

// If this script is running from inside a consumer's node_modules, do nothing.
// Detect by walking up from pkgRoot looking for a parent named "node_modules".
function isInsideNodeModules(start) {
  for (let dir = start; ; ) {
    const parent = path.dirname(dir);
    if (parent === dir) return false;
    if (path.basename(parent) === 'node_modules') return true;
    dir = parent;
  }
}

if (isInsideNodeModules(pkgRoot)) {
  process.exit(0);
}

const pkg = JSON.parse(
  fs.readFileSync(path.resolve(pkgRoot, 'package.json'), 'utf8'),
);

const target = path.resolve(pkgRoot, 'node_modules', pkg.name);
fs.mkdirSync(path.dirname(target), { recursive: true });

try {
  fs.symlinkSync('..', target, 'dir');
} catch (err) {
  if (err.code !== 'EEXIST') throw err;
}
