// Hash-reuse publish of the platform packages, then pin of the wrapper (D29). Run by CI only (needs NODE_AUTH_TOKEN and the registry).
// Usage: node ci/scripts/publish-platform-packages.mjs --dir <generated dir> --build-version <CalVer> [--publish]
// Without --publish: queries the registry and prints the plan; publishes nothing and writes nothing.
// It does NOT publish the wrapper: run `npm publish` in <dir>/machine-cli-dist after this succeeded.
import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const usage = 'usage: node ci/scripts/publish-platform-packages.mjs --dir <generated dir> --build-version <CalVer> [--publish]';

function fail(message) {
  process.stderr.write(`[fail] ${message}\n`);
  process.exit(1);
}

let dir;
let buildVersion;
let publish = false;
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
  const value = () => {
    const v = args[++i];
    if (v === undefined || v.startsWith('--')) fail(`${args[i - 1]} needs a value. ${usage}`);
    return v;
  };
  if (args[i] === '--dir') dir = resolve(value());
  else if (args[i] === '--build-version') buildVersion = value();
  else if (args[i] === '--publish') publish = true;
  else fail(`unknown argument "${args[i]}". ${usage}`);
}
if (dir === undefined || buildVersion === undefined) fail(usage);

// shell: true because npm is npm.cmd on Windows; every argument is a fixed string or a validated package name / folder.
const npm = (npmArgs, cwd) => execFileSync('npm', npmArgs, { cwd, encoding: 'utf8', shell: true, stdio: ['ignore', 'pipe', 'pipe'] });

const client = {
  versions(name) {
    try {
      const out = npm(['view', name, 'versions', '--json']).trim();
      if (out === '') return [];
      const parsed = JSON.parse(out);
      return Array.isArray(parsed) ? parsed : [parsed];
    } catch (e) {
      const text = `${e.stderr ?? ''}${e.stdout ?? ''}`;
      // npm exits 1 with E404 for a package that was never published: that is a normal first publish, any other error is not.
      if (/E404|404 Not Found/.test(text)) return [];
      throw new Error(`npm view ${name} failed: ${text.trim() || e.message}. Check the registry and NODE_AUTH_TOKEN (read:packages)`);
    }
  },
  publish(folder) {
    try {
      npm(['publish'], folder);
    } catch (e) {
      throw new Error(`npm publish in ${folder} failed: ${`${e.stderr ?? ''}`.trim() || e.message}. Check NODE_AUTH_TOKEN (write:packages) and that the version is not already published`);
    }
  },
};

try {
  const { publishPlatformPackages } = await import(pathToFileURL(resolve(packageDir, 'src', 'packaging', 'publishFlow.ts')).href);
  const plan = publishPlatformPackages({ dir, buildVersion, npm: client, publish });
  const verb = publish ? (plan.action === 'reuse' ? 'reused' : 'published') : `plan: ${plan.action}`;
  process.stdout.write(`[ok] platform packages ${verb} at ${plan.version}${publish ? '; wrapper pinned' : ''}\n`);
} catch (e) {
  fail(e.message);
}
