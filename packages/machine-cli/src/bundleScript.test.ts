import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// `npm run bundle` (scripts/bundle.mjs): the single-file CommonJS bundle at <repo>/dist/machine.cjs. The test builds
// into a temp folder (--out) so that it never overwrites the bundle the user installed from.

const run = promisify(execFile);
const script = fileURLToPath(new URL('../scripts/bundle.mjs', import.meta.url));
const packageJson = JSON.parse(readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8')) as { version: string; scripts: Record<string, string> };
const rootPackageJson = JSON.parse(readFileSync(fileURLToPath(new URL('../../../package.json', import.meta.url)), 'utf8')) as { scripts: Record<string, string> };

let root: string;
let bundle: string;
let output: string;

async function machine(...args: string[]): Promise<{ stdout: string; stderr: string }> {
  return run(process.execPath, [bundle, ...args], { windowsHide: true, timeout: 60_000 });
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'machine-bundle-script-'));
  bundle = join(root, 'out', 'machine.cjs');
  output = (await run(process.execPath, [script, '--out', bundle], { windowsHide: true, timeout: 60_000 })).stdout;
}, 90_000);

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('the bundle script', () => {
  it('writes the single file where --out says, and says where and how big', () => {
    expect(existsSync(bundle)).toBe(true);
    expect(output).toContain(bundle);
    expect(output).toContain(`${statSync(bundle).size} bytes`);
  });

  it('inlines the version of package.json', async () => {
    expect(output).toContain(packageJson.version);
    const dir = join(root, 'cfg');
    await machine('init', '--name', 'bundled', '--config-dir', dir);
    expect((await machine('status', '--config-dir', dir)).stdout).toContain(`version: ${packageJson.version}`);
  });

  it('runs --help', async () => {
    const r = await machine('--help');
    expect(r.stdout).toContain('startup enable | disable | status');
  });

  it('has an npm run bundle in the package and at the root', () => {
    expect(packageJson.scripts.bundle).toBeDefined();
    expect(rootPackageJson.scripts.bundle).toMatch(/bundle/);
  });

  it('writes dist/machine.cjs at the repo root by default, and dist/ is git-ignored', () => {
    expect(readFileSync(fileURLToPath(new URL('../scripts/bundle.mjs', import.meta.url)), 'utf8')).toMatch(/dist.*machine\.cjs/s);
    expect(readFileSync(fileURLToPath(new URL('../../../.gitignore', import.meta.url)), 'utf8').split('\n')).toContain('dist/');
  });
});
