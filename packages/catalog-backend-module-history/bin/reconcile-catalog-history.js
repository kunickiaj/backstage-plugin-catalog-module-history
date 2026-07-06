#!/usr/bin/env node
// Thin shim so npm can wire this up via package.json `bin`. The real work
// lives in src/bin/reconcile.ts and is built into
// dist/reconcile-cli.cjs.js by @backstage/cli (declared as an entry point
// in the package.json `exports` field).
const { main } = require('../dist/reconcile-cli.cjs.js');

main().catch(err => {
  process.stderr.write(
    `error ${err instanceof Error ? err.message : String(err)}\n`,
  );
  if (err && err.stack) {
    process.stderr.write(`${err.stack}\n`);
  }
  process.exit(1);
});
