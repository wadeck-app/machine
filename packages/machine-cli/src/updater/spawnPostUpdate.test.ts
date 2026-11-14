import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { spawnPostUpdate } from './spawnPostUpdate.js';

// Runs `node <npm root>/@wadeck-app/machine-cli/bin/machine.js cli post-update` of the NEW install. The "install" here is a
// 3-line script in a temp folder: it only proves what is run, with which arguments and environment.

const roots: string[] = [];
afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop() as string, { recursive: true, force: true });
});

function fakeInstall(script: string, binRel = 'bin/machine.js'): string {
  const root = mkdtempSync(join(tmpdir(), 'machine-post-'));
  roots.push(root);
  const pkg = join(root, '@wadeck-app', 'machine-cli');
  mkdirSync(join(pkg, dirname(binRel)), { recursive: true });
  writeFileSync(join(pkg, 'package.json'), JSON.stringify({ bin: { machine: binRel } }));
  writeFileSync(join(pkg, binRel), script);
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
    expect(r.output).toContain(join(root, '@wadeck-app', 'machine-cli', 'package.json'));
  });

  it('runs the entry declared by bin.machine of the new install (the same source as the self-check), not a hardcoded path', async () => {
    const root = fakeInstall('console.log("from dist");', 'dist/m.js');
    const r = await spawnPostUpdate({ nodeExe: process.execPath, npmRoot: root, configDir: '/c', env: { ...process.env } });
    expect(r).toMatchObject({ code: 0 });
    expect(r.output).toContain('from dist');
  });

  it('kills a post-update that does not finish in time and says so (exit code 1), instead of hanging the updater forever', async () => {
    const root = fakeInstall('console.log("started"); setTimeout(() => {}, 60000);');
    const r = await spawnPostUpdate({ nodeExe: process.execPath, npmRoot: root, configDir: '/c', env: { ...process.env }, timeoutMs: 1000 });
    expect(r.code).toBe(1);
    expect(r.output).toContain('started');
    expect(r.output).toMatch(/\[fail\] post-update did not finish within 1s.*machine cli post-update/s);
  });

  it('logs that it started and that it is done, with the exit code', async () => {
    const root = fakeInstall('process.exit(3);');
    const lines: string[] = [];
    await spawnPostUpdate({ nodeExe: process.execPath, npmRoot: root, configDir: '/c', env: { ...process.env }, log: (level, m) => lines.push(`${level}: ${m}`) });
    expect(lines[0]).toMatch(/^info: post-update started/);
    expect(lines[1]).toMatch(/^(warn|error): post-update done.*exit 3/);
  });
});
