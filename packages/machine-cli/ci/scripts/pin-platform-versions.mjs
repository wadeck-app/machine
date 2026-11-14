// Pins the optionalDependencies of a generated wrapper to exact platform versions.
// Usage: node ci/scripts/pin-platform-versions.mjs --wrapper <dir> --version <exact platform version>
// All three platform packages get the same version (hash-reuse publishing, D29). publish-platform-packages.mjs does this itself;
// this script is the manual form.
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const usage = 'usage: node ci/scripts/pin-platform-versions.mjs --wrapper <dir> --version <exact version>';

function fail(message) {
  process.stderr.write(`[fail] ${message}\n`);
  process.exit(1);
}

let wrapperDir;
let version;
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
  const value = () => {
    const v = args[++i];
    if (v === undefined || v.startsWith('--')) fail(`${args[i - 1]} needs a value. ${usage}`);
    return v;
  };
  if (args[i] === '--wrapper') wrapperDir = resolve(value());
  else if (args[i] === '--version') version = value();
  else fail(`unknown argument "${args[i]}". ${usage}`);
}
if (wrapperDir === undefined || version === undefined) fail(usage);

try {
  const { pinPlatformVersions } = await import(pathToFileURL(resolve(packageDir, 'src', 'packaging', 'platformPackages.ts')).href);
  const { writeJson } = await import(pathToFileURL(resolve(packageDir, 'src', 'packaging', 'packagesWriter.ts')).href);
  const path = join(wrapperDir, 'package.json');
  const wrapper = JSON.parse(readFileSync(path, 'utf8'));
  const versions = Object.fromEntries(Object.keys(wrapper.optionalDependencies ?? {}).map((name) => [name, version]));
  writeJson(path, pinPlatformVersions(wrapper, versions));
  process.stdout.write(`[ok] ${path}: optionalDependencies pinned to ${version}\n`);
} catch (e) {
  fail(e.code === 'ENOENT' ? `${e.path} not found: run generate-platform-packages first` : e.message);
}
