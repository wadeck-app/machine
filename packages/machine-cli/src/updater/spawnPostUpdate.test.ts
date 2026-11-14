import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { spawnPostUpdate } from './spawnPostUpdate.js';

// Runs `node <npm root>/@wadeck-app/machine-cli/bin/machine.js cli post-update` of the NEW install. The "install" here is a
// 3-line script in a temp folder: it only proves what is run, with which arguments and environment.

const roots: string[] = [];
afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop() as string, { recursive: true, force: true });
});

function fakeInstall(script: string): string {
  const root = mkdtempSync(join(tmpdir(), 'machine-post-'));
  roots.push(root);
  mkdirSync(join(root, '@wadeck-app', 'machine-cli', 'bin'), { recursive: true });
  writeFileSync(join(root, '@wadeck-app', 'machine-cli', 'bin', 'machine.js'), script);
  return root;
}

describe('spawnPostUpdate', () => {
  it('runs the bin of the new install with `cli post-update` and the configuration directory, and returns what it printed', async () => {
    const root = fakeInstall('console.log(process.argv.slice(2).join(" ") + "|" + process.env.MACHINE_CONFIG_DIR); console.error("warned");');
    const r = await spawnPostUpdate({ nodeExe: process.execPath, npmRoot: root, configDir: '/some/cfg', env: { ...process.env } });
    expect(r.code).toBe(0);
    expect(r.output).toContain('cli post-update|/some/cfg');
    expect(r.output).toContain('warned');
  });

  it('returns the exit code of the new install', async () => {
    const root = fakeInstall('console.log("[fail] nope"); process.exit(3);');
    const r = await spawnPostUpdate({ nodeExe: process.execPath, npmRoot: root, configDir: '/c', env: { ...process.env } });
    expect(r).toMatchObject({ code: 3 });
    expect(r.output).toContain('[fail] nope');
  });

  it('a missing bin is a failure that names the path, not a throw', async () => {
    const root = mkdtempSync(join(tmpdir(), 'machine-post-empty-'));
    roots.push(root);
    const r = await spawnPostUpdate({ nodeExe: process.execPath, npmRoot: root, configDir: '/c', env: { ...process.env } });
    expect(r.code).not.toBe(0);
    expect(r.output).toContain(join(root, '@wadeck-app', 'machine-cli', 'bin', 'machine.js'));
  });
});
