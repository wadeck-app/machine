import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// scripts/copyAppModule.mjs <dist-module> --out <dir>: copies a packaged app-module to <dir>/app-module. The test
// feeds it a fake dist-module in a temp folder, so `app-core-cli package` never runs here.

const run = promisify(execFile);
const script = fileURLToPath(new URL('../scripts/copyAppModule.mjs', import.meta.url));

let root: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'machine-copy-module-'));
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

function fakeModule(name: string, withManifest = true): string {
  const dir = join(root, name);
  mkdirSync(join(dir, 'views'), { recursive: true });
  writeFileSync(join(dir, 'views', 'a.json'), '{}');
  if (withManifest) writeFileSync(join(dir, 'manifest.json'), '{"version":"1"}');
  return dir;
}

async function copy(...args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await run(process.execPath, [script, ...args], { windowsHide: true, timeout: 30_000 });
    return { code: 0, stdout, stderr };
  } catch (err) {
    const e = err as { code: number; stdout: string; stderr: string };
    return { code: e.code, stdout: e.stdout, stderr: e.stderr };
  }
}

describe('copyAppModule script', () => {
  it('copies the dist-module to <out>/app-module', async () => {
    const out = join(root, 'out1');
    const result = await copy(fakeModule('ok'), '--out', out);
    expect(result.code).toBe(0);
    expect(readFileSync(join(out, 'app-module', 'manifest.json'), 'utf8')).toBe('{"version":"1"}');
    expect(existsSync(join(out, 'app-module', 'views', 'a.json'))).toBe(true);
    expect(result.stdout).toContain(join(out, 'app-module'));
  });

  it('refuses a target that is the source or inside it: removing the target would delete the module it is about to copy', async () => {
    const out = join(root, 'out-same');
    const source = join(out, 'app-module');
    mkdirSync(join(source, 'views'), { recursive: true });
    writeFileSync(join(source, 'manifest.json'), '{"version":"1"}');
    const r = await copy(source, '--out', out);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/\[fail\].*is the source/);
    expect(readFileSync(join(source, 'manifest.json'), 'utf8')).toBe('{"version":"1"}');

    // The source holds the target: <source>/app-module would be removed with its parent.
    const parent = fakeModule('holds-target');
    const r2 = await copy(parent, '--out', parent);
    expect(r2.code).toBe(1);
    expect(r2.stderr).toMatch(/\[fail\].*inside the source/);
  });

  it('replaces a previous copy instead of merging into it', async () => {
    const out = join(root, 'out2');
    mkdirSync(join(out, 'app-module'), { recursive: true });
    writeFileSync(join(out, 'app-module', 'stale.json'), '{}');
    expect((await copy(fakeModule('ok2'), '--out', out)).code).toBe(0);
    expect(existsSync(join(out, 'app-module', 'stale.json'))).toBe(false);
  });

  it('fails loudly, naming the folder and the fix, when manifest.json is missing', async () => {
    const out = join(root, 'out3');
    const dir = fakeModule('nomanifest', false);
    const result = await copy(dir, '--out', out);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain('[fail]');
    expect(result.stderr).toContain(join(dir, 'manifest.json'));
    expect(result.stderr).toContain('npm run bundle');
    expect(existsSync(join(out, 'app-module'))).toBe(false);
  });

  it('fails when the dist-module folder does not exist', async () => {
    const result = await copy(join(root, 'nope'), '--out', join(root, 'out4'));
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain('manifest.json');
  });

  it('fails without --out, saying how to call it', async () => {
    const result = await copy(fakeModule('ok5'));
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain('--out');
    expect(result.stderr).toContain('usage');
  });

  it('fails on an unknown argument', async () => {
    const result = await copy(fakeModule('ok6'), '--out', join(root, 'out6'), '--bogus');
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain('--bogus');
  });
});
