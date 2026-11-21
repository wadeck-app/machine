import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { PLATFORM_TARGETS, platformKey } from '../platformBinary.ts';

interface ShimDeps {
  platform: string;
  arch: string;
  argv: string[];
  execPath: string;
  bundlePath: string;
  exists: (p: string) => boolean;
  spawnSync: (cmd: string, args: string[], opts: { stdio: string }) => { status: number | null; signal?: string; error?: Error };
  stderr: (t: string) => void;
}
const shim = createRequire(import.meta.url)('../../ci/templates/bin-machine.cjs') as { run: (d: ShimDeps) => number; SUPPORTED: string[]; platformKey: (p: string, a: string) => string };

function deps(over: Partial<ShimDeps> = {}): { d: ShimDeps; err: string[]; calls: Array<{ cmd: string; args: string[]; stdio: string }> } {
  const err: string[] = [];
  const calls: Array<{ cmd: string; args: string[]; stdio: string }> = [];
  const d: ShimDeps = {
    platform: 'linux',
    arch: 'x64',
    argv: ['list', '--json'],
    execPath: '/usr/bin/node',
    bundlePath: '/pkg/machine.cjs',
    exists: () => true,
    spawnSync: (cmd, args, opts) => {
      calls.push({ cmd, args, stdio: opts.stdio });
      return { status: 0 };
    },
    stderr: (t) => err.push(t),
    ...over,
  };
  return { d, err, calls };
}

describe('shim', () => {
  it('supports exactly the platform table', () => {
    expect([...shim.SUPPORTED].sort()).toEqual(Object.keys(PLATFORM_TARGETS).sort());
    for (const [p, a] of [['win32', 'x64'], ['darwin', 'arm64'], ['linux', 'x64'], ['darwin', 'x64'], ['linux', 'arm64']] as const) {
      expect(shim.platformKey(p, a)).toBe(platformKey(p, a));
    }
  });

  it('runs node <bundle> <args> with inherited stdio and returns the exit code', () => {
    const { d, calls } = deps({ spawnSync: (cmd, args, opts) => { calls.push({ cmd, args, stdio: opts.stdio }); return { status: 7 }; } });
    expect(shim.run(d)).toBe(7);
    expect(calls).toEqual([{ cmd: '/usr/bin/node', args: ['/pkg/machine.cjs', 'list', '--json'], stdio: 'inherit' }]);
  });

  it('unsupported platform: exit 1 first, names the key and the supported list, runs nothing', () => {
    const { d, err, calls } = deps({ platform: 'darwin', arch: 'x64' });
    expect(shim.run(d)).toBe(1);
    expect(err.join('')).toMatch(/does not support darwin-x64 \(supported: win32-x64, darwin-arm64, linux-x64\)/);
    expect(calls).toHaveLength(0);
  });

  it('missing bundle: names the path and the reinstall command', () => {
    const { d, err, calls } = deps({ exists: () => false });
    expect(shim.run(d)).toBe(1);
    expect(err.join('')).toMatch(/\/pkg\/machine\.cjs is missing.*npm i -g @wadeck-app\/machine-cli/);
    expect(calls).toHaveLength(0);
  });

  it('node cannot start: cause and fix', () => {
    const { d, err } = deps({ spawnSync: () => ({ status: null, error: new Error('ENOENT') }) });
    expect(shim.run(d)).toBe(1);
    expect(err.join('')).toMatch(/ENOENT.*Node\.js 24/);
  });

  it('killed by a signal: exit 1 naming the signal', () => {
    const { d, err } = deps({ spawnSync: () => ({ status: null, signal: 'SIGKILL' }) });
    expect(shim.run(d)).toBe(1);
    expect(err.join('')).toMatch(/SIGKILL/);
  });
});
