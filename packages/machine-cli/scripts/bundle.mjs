// Builds the single-file CommonJS bundle of machine: <repo>/dist/machine.cjs (or --out <file>), version from BUNDLE_VERSION, else package.json.
// The esbuild options live in src/bundle.ts (shared with the tests); Node strips the types when it imports that file
// (Node 22.18 or newer, and the Node 24 used here).
import { readFileSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
let outfile = resolve(packageDir, '..', '..', 'dist', 'machine.cjs');
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--out') {
    const value = args[++i];
    if (value === undefined || value.startsWith('--')) fail('--out needs a file path');
    outfile = resolve(value);
  } else {
    fail(`unknown argument "${args[i]}": usage: node scripts/bundle.mjs [--out <file>]`);
  }
}

function fail(message) {
  process.stderr.write(`[fail] ${message}\n`);
  process.exit(1);
}

// BUNDLE_VERSION (CI: the CalVer of the release) wins; without it the package.json version stays, and a version that is not CalVer makes the updater refuse to run (a dev build).
let version;
if (process.env.BUNDLE_VERSION !== undefined) {
  version = process.env.BUNDLE_VERSION.trim();
  if (version.length === 0) fail('BUNDLE_VERSION is set but empty: unset it to use the version of package.json, or give the version to inline');
} else {
  version = JSON.parse(readFileSync(resolve(packageDir, 'package.json'), 'utf8')).version;
  if (typeof version !== 'string' || version.length === 0) fail(`no "version" in ${resolve(packageDir, 'package.json')}`);
}

let bundleMachine;
try {
  ({ bundleMachine } = await import(pathToFileURL(resolve(packageDir, 'src', 'bundle.ts')).href));
} catch (e) {
  fail(`cannot load src/bundle.ts (${e.message}): this script needs Node 22.18 or newer, which runs TypeScript files directly (running ${process.version})`);
}

try {
  await bundleMachine({ outfile, version });
} catch (e) {
  fail(`the bundle failed: ${e.message}`);
}
process.stdout.write(`[ok] ${outfile} (${statSync(outfile).size} bytes, version ${version})\n`);
