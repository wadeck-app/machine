import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runSelfCheck, type SelfCheckDeps } from './selfCheck.js';

// `machine cli self-check`: run by node (never the launcher) from the NEW install, by the updater, before the update is accepted.
// It must not read the identity or ask for a passphrase.

const VERSION = '2026.11.14-592-bbbbbbbb';
const roots: string[] = [];
afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop() as string, { recursive: true, force: true });
});
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'machine-selfcheck-'));
  roots.push(d);
  return d;
}

function deps(over: Partial<SelfCheckDeps> = {}): SelfCheckDeps {
  const configDir = tmp();
  return {
    version: VERSION,
    configDir,
    nodeVersion: 'v24.1.0',
    platform: 'win32',
    arch: 'x64',
    wrapperManifest: () => ({ optionalDependencies: { '@wadeck-app/machine-cli-win32-x64': '2026.11.14-590-bin.abc' } }),
    findLauncher: () => ({ kind: 'found', source: '/x/machine.exe', stamp: '2026.11.14-590-bin.abc', fileName: 'machine.exe' }),
    daemonVersion: async () => undefined,
    ...over,
  };
}

const names = (r: Awaited<ReturnType<typeof runSelfCheck>>) => r.checks.map((c) => `${c.ok ? 'ok' : 'fail'} ${c.name}`);

describe('machine cli self-check', () => {
  it('passes on a sane install and reports every check', async () => {
    const r = await runSelfCheck(deps());
    expect(r.ok).toBe(true);
    expect(r.checks.every((c) => c.ok)).toBe(true);
    expect(names(r).join('\n')).toMatch(/version/);
    expect(names(r).join('\n')).toMatch(/node/);
    expect(names(r).join('\n')).toMatch(/config-dir/);
    expect(names(r).join('\n')).toMatch(/launcher/);
  });

  it('fails on a version that is not a CalVer release (a dev build must never be accepted as an update)', async () => {
    const r = await runSelfCheck(deps({ version: '0.1.0' }));
    expect(r.ok).toBe(false);
    expect(r.checks.find((c) => c.name === 'version')?.detail).toMatch(/0\.1\.0.*not a release/);
  });

  it('fails on node older than 22 and names the requirement', async () => {
    const r = await runSelfCheck(deps({ nodeVersion: 'v20.11.0' }));
    expect(r.ok).toBe(false);
    expect(r.checks.find((c) => c.name === 'node')?.detail).toMatch(/v20\.11\.0.*22/);
  });

  it('fails when the platform package is not installed (npm skips a failing optional dependency in silence)', async () => {
    const r = await runSelfCheck(deps({ findLauncher: () => ({ kind: 'absent', reason: 'the launcher package @wadeck-app/machine-cli-win32-x64 is not installed' }) }));
    expect(r.ok).toBe(false);
    expect(r.checks.find((c) => c.name === 'platform-package')?.detail).toMatch(/not installed/);
  });

  it('fails when the installed platform package is not the version the wrapper pins', async () => {
    const r = await runSelfCheck(deps({ findLauncher: () => ({ kind: 'found', source: '/x/machine.exe', stamp: '2026.11.13-500-bin.zzz', fileName: 'machine.exe' }) }));
    expect(r.ok).toBe(false);
    expect(r.checks.find((c) => c.name === 'platform-package')?.detail).toMatch(/pins .*2026\.11\.14-590-bin\.abc.*2026\.11\.13-500-bin\.zzz/);
  });

  it('fails when the wrapper declares no pin for its platform package', async () => {
    const r = await runSelfCheck(deps({ wrapperManifest: () => ({}) }));
    expect(r.checks.find((c) => c.name === 'platform-package')?.ok).toBe(false);
  });

  it('fails when the wrapper manifest cannot be read, with the reason', async () => {
    const r = await runSelfCheck(
      deps({
        wrapperManifest: () => {
          throw new Error('ENOENT package.json');
        },
      }),
    );
    expect(r.checks.find((c) => c.name === 'platform-package')?.detail).toMatch(/ENOENT package\.json/);
  });

  it('an unsupported platform is a pass that says so in the NAME (nothing to verify), never a silent skip', async () => {
    const r = await runSelfCheck(deps({ platform: 'freebsd', findLauncher: () => ({ kind: 'absent', reason: 'this platform (freebsd-x64) has no launcher package; supported: win32-x64' }) }));
    const c = r.checks.find((x) => x.name.startsWith('platform-package'));
    expect(c?.ok).toBe(true);
    expect(c?.name).toMatch(/skipped.*freebsd-x64/);
  });

  it('fails when the configuration directory cannot be written, naming it', async () => {
    const dir = tmp();
    const file = join(dir, 'not-a-dir');
    writeFileSync(file, 'x');
    const r = await runSelfCheck(deps({ configDir: join(file, 'cfg') }));
    expect(r.ok).toBe(false);
    expect(r.checks.find((c) => c.name === 'config-dir')?.detail).toContain(join(file, 'cfg'));
  });

  it('fails when the staged launcher folder cannot be created', async () => {
    const dir = tmp();
    // <configDir>/bin is a file: the folder of a staged launcher cannot be created.
    writeFileSync(join(dir, 'bin'), 'x');
    const r = await runSelfCheck(deps({ configDir: dir }));
    expect(r.checks.find((c) => c.name === 'staged-launcher')?.ok).toBe(false);
  });

  it('leaves no probe file behind in the configuration directory', async () => {
    const d = deps();
    mkdirSync(join(d.configDir, 'bin'), { recursive: true });
    await runSelfCheck(d);
    const { readdirSync } = await import('node:fs');
    expect(readdirSync(join(d.configDir, 'bin'))).toEqual([]);
    expect(readdirSync(d.configDir).filter((n) => n.includes('self-check'))).toEqual([]);
    chmodSync(d.configDir, 0o700);
  });

  it('reports the running daemon version as information and never fails on it (it still runs the old version before post-update)', async () => {
    const r = await runSelfCheck(deps({ daemonVersion: async () => '2026.11.14-590-aaaaaaaa' }));
    expect(r.ok).toBe(true);
    expect(names(r).join('\n')).toMatch(/daemon.*2026\.11\.14-590-aaaaaaaa/);
  });

  it('a daemon that cannot be queried is information too, not a failure', async () => {
    const r = await runSelfCheck(
      deps({
        daemonVersion: async () => {
          throw new Error('refused');
        },
      }),
    );
    expect(r.ok).toBe(true);
    expect(names(r).join('\n')).toMatch(/daemon.*refused/);
  });
});
