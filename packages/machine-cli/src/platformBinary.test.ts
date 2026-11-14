import * as realFs from 'node:fs';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  findLauncher,
  platformKey,
  platformPackageName,
  PLATFORM_TARGETS,
  pruneStaged,
  stageBinary,
  stagedBinaryPath,
  stagedLauncher,
  unsupportedPlatformMessage,
  type BinaryDeps,
} from './platformBinary.js';

// The pure part of the launcher staging (spec: packaging.md section 3.4): platform table, the staged copy outside
// node_modules, the prune. Real temp folders, injected platform, resolver and fs.

let root: string;
let configDir: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'machine-platformbinary-'));
  configDir = join(root, 'config');
  mkdirSync(configDir);
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** A fake installed platform package: <root>/nm/<pkg>/{package.json, <file>}. Returns a resolver like require.resolve. */
function installPackage(key: string, version: string | undefined, bytes = 'LAUNCHER-BYTES'): (spec: string) => string {
  const pkg = platformPackageName(key);
  const dir = join(root, 'nm', ...pkg.split('/'));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, PLATFORM_TARGETS[key]!.fileName), bytes);
  writeFileSync(join(dir, 'package.json'), JSON.stringify(version === undefined ? { name: pkg } : { name: pkg, version }));
  return (spec) => {
    const target = join(root, 'nm', ...spec.split('/'));
    if (!existsSync(target)) throw Object.assign(new Error(`Cannot find module '${spec}'`), { code: 'MODULE_NOT_FOUND' });
    return target;
  };
}

describe('the platform table', () => {
  it('has exactly win32-x64, darwin-arm64 and linux-x64, with the exe names of the packaging design', () => {
    expect(Object.keys(PLATFORM_TARGETS).sort()).toEqual(['darwin-arm64', 'linux-x64', 'win32-x64']);
    expect(PLATFORM_TARGETS['win32-x64']!.fileName).toBe('machine.exe');
    expect(PLATFORM_TARGETS['darwin-arm64']!.fileName).toBe('machine');
    expect(PLATFORM_TARGETS['linux-x64']!.fileName).toBe('machine');
  });

  it('maps process.platform and arch to a key: arm64 stays arm64, any other arch counts as x64', () => {
    expect(platformKey('win32', 'x64')).toBe('win32-x64');
    expect(platformKey('darwin', 'arm64')).toBe('darwin-arm64');
    expect(platformKey('linux', 'x64')).toBe('linux-x64');
    expect(platformKey('linux', 'ia32')).toBe('linux-x64');
    expect(platformKey('linux', 'arm64')).toBe('linux-arm64');
  });

  it('names the package @wadeck-app/machine-cli-<key>', () => {
    expect(platformPackageName('win32-x64')).toBe('@wadeck-app/machine-cli-win32-x64');
  });

  it('says which platforms are supported when the host is not one of them', () => {
    const text = unsupportedPlatformMessage('linux-arm64');
    expect(text).toContain('linux-arm64');
    expect(text).toContain('win32-x64, darwin-arm64, linux-x64');
  });
});

describe('findLauncher', () => {
  it('finds the exe and the version (the stamp) of the platform package', () => {
    const resolve = installPackage('win32-x64', '2026.11.14-592-bin.abc');
    const found = findLauncher({ platform: 'win32', arch: 'x64', resolve });
    expect(found).toEqual({
      kind: 'found',
      source: join(root, 'nm', '@wadeck-app', 'machine-cli-win32-x64', 'machine.exe'),
      stamp: '2026.11.14-592-bin.abc',
      fileName: 'machine.exe',
    });
  });

  it('package not installed (a checkout, optionalDependencies skipped): absent, with the reason', () => {
    const found = findLauncher({ platform: 'linux', arch: 'x64', resolve: () => { throw Object.assign(new Error('nope'), { code: 'MODULE_NOT_FOUND' }); } });
    expect(found.kind).toBe('absent');
    expect((found as { reason: string }).reason).toContain('@wadeck-app/machine-cli-linux-x64');
    expect((found as { reason: string }).reason).toMatch(/not installed/);
  });

  it('unsupported platform: absent with the supported list, the resolver is not called', () => {
    const found = findLauncher({ platform: 'freebsd', arch: 'x64', resolve: () => { throw new Error('must not be called'); } });
    expect(found.kind).toBe('absent');
    expect((found as { reason: string }).reason).toContain('win32-x64, darwin-arm64, linux-x64');
  });

  it('a package whose version cannot be read is an error, never a made-up stamp', () => {
    const resolve = installPackage('linux-x64', undefined);
    expect(() => findLauncher({ platform: 'linux', arch: 'x64', resolve })).toThrow(/no "version".*npm i -g @wadeck-app\/machine-cli/s);
  });

  it('a version that cannot be a folder name is refused', () => {
    const resolve = installPackage('linux-x64', '../evil');
    expect(() => findLauncher({ platform: 'linux', arch: 'x64', resolve })).toThrow(/version "..\/evil"/);
  });

  it('a resolver error other than "not found" is raised, not read as absent', () => {
    expect(() => findLauncher({ platform: 'linux', arch: 'x64', resolve: () => { throw new Error('disk on fire'); } })).toThrow(/disk on fire/);
  });
});

describe('stageBinary', () => {
  const source = () => join(root, 'src-machine');
  beforeEach(() => writeFileSync(source(), 'LAUNCHER-BYTES'));

  it('copies once per stamp to <configDir>/bin/<stamp>/<name>', () => {
    const target = stageBinary(source(), configDir, '1.0.0');
    expect(target).toBe(stagedBinaryPath(configDir, '1.0.0', 'src-machine'));
    expect(target).toBe(join(configDir, 'bin', '1.0.0', 'src-machine'));
    expect(readFileSync(target, 'utf8')).toBe('LAUNCHER-BYTES');
    expect(readdirSync(join(configDir, 'bin', '1.0.0'))).toEqual(['src-machine']);
  });

  it('does not copy again when the staged file has the same size (the file is left as it is)', () => {
    const target = stageBinary(source(), configDir, '1.0.0');
    const before = statSync(target).mtimeMs;
    expect(stageBinary(source(), configDir, '1.0.0')).toBe(target);
    expect(statSync(target).mtimeMs).toBe(before);
  });

  it('replaces a short copy (an interrupted one)', () => {
    const target = stagedBinaryPath(configDir, '1.0.0', 'src-machine');
    mkdirSync(join(configDir, 'bin', '1.0.0'), { recursive: true });
    writeFileSync(target, 'SHORT');
    stageBinary(source(), configDir, '1.0.0');
    expect(readFileSync(target, 'utf8')).toBe('LAUNCHER-BYTES');
  });

  it('copies beside the target as .partial, then renames: no .partial is left, and the target never holds a short file', () => {
    const calls: string[] = [];
    const fs = {
      ...realFs,
      copyFileSync: (from: realFs.PathLike, to: realFs.PathLike) => {
        calls.push(`copy ${String(to).endsWith('.partial') ? 'partial' : 'direct'}`);
        realFs.copyFileSync(from, to);
      },
      renameSync: (from: realFs.PathLike, to: realFs.PathLike) => {
        calls.push('rename');
        realFs.renameSync(from, to);
      },
    };
    const target = stageBinary(source(), configDir, '1.0.0', fs);
    expect(calls).toEqual(['copy partial', 'rename']);
    expect(existsSync(`${target}.partial`)).toBe(false);
  });

  it('throws when the source is unreadable, naming it, and falls back to nothing', () => {
    expect(() => stageBinary(join(root, 'missing'), configDir, '1.0.0')).toThrow(/Cannot stage the launcher: .*missing is not readable/);
    expect(existsSync(join(configDir, 'bin'))).toBe(false);
  });

  it('throws when the copy fails, with the target, the cause and why it is staged', () => {
    const fs = { ...realFs, copyFileSync: () => { throw new Error('EBUSY: resource busy'); } };
    const e = (() => { try { stageBinary(source(), configDir, '1.0.0', fs); } catch (x) { return x as Error; } })();
    expect(e?.message).toContain('EBUSY: resource busy');
    expect(e?.message).toContain(join(configDir, 'bin', '1.0.0'));
    expect(e?.message).toMatch(/outside node_modules|out of node_modules/);
  });
});

describe('pruneStaged', () => {
  const stage = (stamp: string) => {
    mkdirSync(join(configDir, 'bin', stamp), { recursive: true });
    writeFileSync(join(configDir, 'bin', stamp, 'machine'), 'x');
  };

  it('removes every stamp but the kept one and counts them', () => {
    stage('1'); stage('2'); stage('3');
    expect(pruneStaged(configDir, '2')).toEqual({ removed: ['1', '3'], skipped: [] });
    expect(readdirSync(join(configDir, 'bin'))).toEqual(['2']);
  });

  it('a stamp that cannot be removed (a running image on Windows) is skipped and reported, never raised', () => {
    stage('1'); stage('2');
    const fs = { ...realFs, rmSync: () => { throw new Error('EBUSY'); } };
    expect(pruneStaged(configDir, '2', fs)).toEqual({ removed: [], skipped: ['1'] });
    expect(readdirSync(join(configDir, 'bin')).sort()).toEqual(['1', '2']);
  });

  it('no bin folder: nothing to do', () => {
    expect(pruneStaged(configDir, '1')).toEqual({ removed: [], skipped: [] });
  });
});

describe('stagedLauncher', () => {
  it('stage=true copies the launcher out of the package and returns the staged exe, the stamp and the source', () => {
    const resolve = installPackage('win32-x64', '7.7.7');
    const deps: BinaryDeps = { platform: 'win32', arch: 'x64', resolve };
    const r = stagedLauncher(configDir, deps, true);
    expect(r).toMatchObject({ kind: 'staged', stamp: '7.7.7', exe: join(configDir, 'bin', '7.7.7', 'machine.exe') });
    expect(readFileSync(join(configDir, 'bin', '7.7.7', 'machine.exe'), 'utf8')).toBe('LAUNCHER-BYTES');
  });

  it('stage=false only computes the path (status never copies)', () => {
    const resolve = installPackage('linux-x64', '7.7.7');
    const r = stagedLauncher(configDir, { platform: 'linux', arch: 'x64', resolve }, false);
    expect(r).toMatchObject({ kind: 'staged', exe: join(configDir, 'bin', '7.7.7', 'machine') });
    expect(existsSync(join(configDir, 'bin'))).toBe(false);
  });

  it('absent is passed through', () => {
    expect(stagedLauncher(configDir, { platform: 'linux', arch: 'x64', resolve: () => { throw Object.assign(new Error('x'), { code: 'MODULE_NOT_FOUND' }); } }, true).kind).toBe('absent');
  });
});
