// Generates the publishable folders: <out>/machine-cli-dist (wrapper) and <out>/machine-cli-<platform> x3.
// Usage: node ci/scripts/generate-platform-packages.mjs --out <dir> --version <CalVer> [--launchers <dir>] [--bundle-dir <dir>] [--no-strict]
// Defaults: --launchers packages/machine-cli/dist-launcher, --bundle-dir <repo>/dist. Strict by default (CI).
// Node 22.18 or newer imports the TypeScript sources directly (as scripts/bundle.mjs does).
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const usage = 'usage: node ci/scripts/generate-platform-packages.mjs --out <dir> --version <CalVer> [--launchers <dir>] [--bundle-dir <dir>] [--no-strict]';

function fail(message) {
  process.stderr.write(`[fail] ${message}\n`);
  process.exit(1);
}

const opts = { launchers: resolve(packageDir, 'dist-launcher'), bundleDir: resolve(packageDir, '..', '..', 'dist'), strict: true };
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  const value = () => {
    const v = args[++i];
    if (v === undefined || v.startsWith('--')) fail(`${a} needs a value. ${usage}`);
    return v;
  };
  if (a === '--out') opts.out = resolve(value());
  else if (a === '--version') opts.version = value();
  else if (a === '--launchers') opts.launchers = resolve(value());
  else if (a === '--bundle-dir') opts.bundleDir = resolve(value());
  else if (a === '--no-strict') opts.strict = false;
  else fail(`unknown argument "${a}". ${usage}`);
}
if (opts.out === undefined) fail(`--out is required. ${usage}`);
if (opts.version === undefined) fail(`--version is required (the CalVer of this build). ${usage}`);

let generatePackages;
try {
  ({ generatePackages } = await import(pathToFileURL(resolve(packageDir, 'src', 'packaging', 'packagesWriter.ts')).href));
} catch (e) {
  fail(`cannot load the packaging sources (${e.message}): this script needs Node 22.18 or newer (running ${process.version})`);
}

try {
  const { warnings } = generatePackages({
    outDir: opts.out,
    version: opts.version,
    launcherDir: opts.launchers,
    bundleDir: opts.bundleDir,
    shimPath: resolve(packageDir, 'ci', 'templates', 'bin-machine.cjs'),
    strict: opts.strict,
  });
  for (const w of warnings) process.stderr.write(`[warn] ${w}\n`);
  process.stdout.write(`[ok] packages generated in ${opts.out} (version ${opts.version})\n`);
} catch (e) {
  fail(e.message);
}
