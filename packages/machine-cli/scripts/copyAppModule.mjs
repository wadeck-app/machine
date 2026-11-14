// Puts the packaged app-module next to the daemon bundle: <out>/app-module (what appCoreRegistration.ts looks for).
// Usage: node scripts/copyAppModule.mjs --out <dir> [<dist-module>]
// Without <dist-module>, the module's own package builds it (`npm run bundle` in packages/app-module-machine, which runs
// `app-core-cli package`, BUNDLE_VERSION passed through) and its dist-module/ is copied.
import { execSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const usage = 'usage: node scripts/copyAppModule.mjs --out <dir> [<dist-module>]';
const moduleDir = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'app-module-machine');

function fail(message) {
  process.stderr.write(`[fail] ${message}\n`);
  process.exit(1);
}

let out;
let distModule;
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === '--out') {
    const value = args[++i];
    if (value === undefined || value.startsWith('--')) fail(`--out needs a folder: ${usage}`);
    out = resolve(value);
  } else if (arg.startsWith('--')) {
    fail(`unknown argument "${arg}": ${usage}`);
  } else if (distModule === undefined) {
    distModule = resolve(arg);
  } else {
    fail(`unexpected argument "${arg}": ${usage}`);
  }
}
if (out === undefined) fail(`--out is required: ${usage}`);

if (distModule === undefined) {
  distModule = join(moduleDir, 'dist-module');
  try {
    execSync('npm run bundle', { cwd: moduleDir, env: process.env, stdio: 'inherit', windowsHide: true });
  } catch (err) {
    fail(`"npm run bundle" failed in ${moduleDir} (${err instanceof Error ? err.message : String(err)}): read its output above.`);
  }
}

const manifest = join(distModule, 'manifest.json');
if (!existsSync(manifest)) {
  fail(`no ${manifest}: the app-module was not packaged. Run "npm run bundle" in ${moduleDir} and read its output.`);
}

const target = join(out, 'app-module');
// The target is removed before the copy: when it is the source (or holds it) the module would be deleted before it is read.
const rel = relative(distModule, target);
if (rel === '') fail(`the target ${target} is the source ${distModule}: pass an --out folder that is not the parent of the module`);
if (!rel.startsWith('..') && !isAbsolute(rel)) fail(`the target ${target} is inside the source ${distModule}: pass an --out folder outside of it`);
const back = relative(target, distModule);
if (!back.startsWith('..') && !isAbsolute(back)) fail(`the source ${distModule} is inside the target ${target}, which is removed before the copy: pass another --out folder`);
rmSync(target, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
cpSync(distModule, target, { recursive: true });
process.stdout.write(`Copied ${distModule} to ${target}\n`);
