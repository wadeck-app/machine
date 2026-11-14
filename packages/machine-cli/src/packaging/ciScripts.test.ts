import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
// @ts-expect-error plain ESM script used by the CI, no declaration file
import { previousVersion } from '../../ci/scripts/previous-version.mjs';

// The scripts of the verify-install, verify-update and packed-smoke jobs (publish.yml, packaging.md 3.8): the logic that can run
// without a registry. The jobs themselves run in CI only.
const scripts = resolve(import.meta.dirname, '..', '..', 'ci', 'scripts');
const posix = (p: string): string => p.replace(/\\/g, '/');
const lines = (text: string): string[] => text.trim().split(/\r?\n/);

/** On a Windows machine `bash` can be the WSL launcher found before Git's bash: the scripts need Git's (cygpath, MSYS paths). */
function bashCommand(): string {
  if (process.platform !== 'win32') return 'bash';
  for (const root of [process.env['ProgramFiles'], process.env['ProgramW6432'], process.env['ProgramFiles(x86)']]) {
    if (root === undefined || root === '') continue;
    for (const rel of [['Git', 'bin', 'bash.exe'], ['Git', 'usr', 'bin', 'bash.exe']]) {
      const candidate = join(root, ...rel);
      if (existsSync(candidate)) return candidate;
    }
  }
  return 'bash';
}

let work: string;
beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), 'machine-ciscripts-'));
});
afterEach(() => rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }));

describe('previous-version.mjs', () => {
  const versions = ['2026.10.24-004-aaaaaaaa', '2026.10.25-019-bbbbbbbb', '2026.10.9-100-cccccccc', '2026.10.25-020-dddddddd', '2026.11.1-001-eeeeeeee'];

  it('is the published version just before the given one, in date then build order, not in array order', () => {
    expect(previousVersion(versions, '2026.10.25-020-dddddddd')).toBe('2026.10.25-019-bbbbbbbb');
    expect(previousVersion(versions, '2026.11.1-001-eeeeeeee')).toBe('2026.10.25-020-dddddddd');
    expect(previousVersion(versions, '2026.10.24-004-aaaaaaaa')).toBe('2026.10.9-100-cccccccc');
  });

  it('is undefined when there is none before it (first publication)', () => {
    expect(previousVersion(['2026.10.25-019-bbbbbbbb'], '2026.10.25-019-bbbbbbbb')).toBeUndefined();
  });

  it('ignores versions that are not CalVer (0.1.0, other schemes)', () => {
    expect(previousVersion(['0.1.0', '1.2.3', '2026.10.24-004-aaaaaaaa', '2026.10.25-019-bbbbbbbb'], '2026.10.25-019-bbbbbbbb')).toBe('2026.10.24-004-aaaaaaaa');
  });

  it('accepts what npm view --json returns for a single version (a string, not an array)', () => {
    expect(previousVersion('2026.10.25-019-bbbbbbbb', '2026.10.25-019-bbbbbbbb')).toBeUndefined();
  });

  it('refuses a given version that is not CalVer: the caller made a mistake', () => {
    expect(() => previousVersion(versions, 'latest')).toThrow(/not a CalVer version/);
  });

  it('the command line reads the versions on stdin and prints the previous one, nothing when there is none', () => {
    const run = (version: string, input: string) => spawnSync(process.execPath, [join(scripts, 'previous-version.mjs'), version], { encoding: 'utf8', input });
    expect(run('2026.10.25-019-bbbbbbbb', JSON.stringify(versions)).stdout.trim()).toBe('2026.10.24-004-aaaaaaaa');
    expect(run('2026.10.24-004-aaaaaaaa', JSON.stringify(['2026.10.24-004-aaaaaaaa'])).stdout).toBe('');
    const noArg = spawnSync(process.execPath, [join(scripts, 'previous-version.mjs')], { encoding: 'utf8', input: '[]' });
    expect(noArg.status).toBe(2);
    expect(noArg.stderr).toContain('usage: node previous-version.mjs <version>');
  });
});

describe('annotate-failure.mjs', () => {
  const run = (title: string, file: string) => spawnSync(process.execPath, [join(scripts, 'annotate-failure.mjs'), title, file], { encoding: 'utf8' });
  const log = (text: string): string => {
    const file = join(work, 'out.log');
    writeFileSync(file, text);
    return file;
  };

  it('prints one GitHub error annotation with the title and the end of the log, on one line, exit 0', () => {
    const r = run('tests', log('line one\nline two\n'));
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe('::error title=tests::line one%0Aline two');
  });

  it('escapes percent, carriage return and newline, and the colon and comma of the title', () => {
    expect(run('t', log('100% done\r\nnext\n')).stdout.trim()).toBe('::error title=t::100%25 done%0D%0Anext');
    expect(run('verify: install, linux', log('x\n')).stdout).toContain('::error title=verify%3A install%2C linux::x');
  });

  it('keeps the end of a long log and says it was truncated', () => {
    const out = run('t', log(Array.from({ length: 60 }, (_, i) => `${'x'.repeat(80)} end${i}`).join('\n'))).stdout.trim();
    expect(out.length).toBeLessThan(1700);
    expect(out).toContain('end59');
    expect(out).toContain('(truncated)');
  });

  it('annotates the FIRST failing lines (colored vitest output included) before the tail, when the failure is not at the end', () => {
    const body = [
      ' \u001b[41m\u001b[1m FAIL \u001b[22m\u001b[49m src/run.test.ts > real PowerShell > first',
      '\u001b[31m\u001b[1mAssertionError\u001b[22m: timed out after 30094 ms, exitCode null',
      ...Array.from({ length: 80 }, (_, i) => `later package passing ${i}`),
    ].join('\n');
    const out = run('tests', log(body)).stdout.trim();
    expect(out).toContain('first failing lines');
    expect(out).toContain('FAIL  src/run.test.ts > real PowerShell > first');
    expect(out).toContain('AssertionError: timed out after 30094 ms, exitCode null');
    expect(out).not.toContain('\u001b');
    expect(out).toContain('later package passing 79');
    expect(out).not.toContain('later package passing 5%0A');
  });

  it('says clearly when there is no log, or an empty one, and with no argument prints the usage (exit 2)', () => {
    expect(run('t', join(work, 'missing.log')).stdout).toContain('no log file');
    expect(run('t', log('')).stdout).toContain('the log is empty');
    const none = spawnSync(process.execPath, [join(scripts, 'annotate-failure.mjs')], { encoding: 'utf8' });
    expect(none.status).toBe(2);
    expect(none.stderr).toContain('usage: annotate-failure.mjs <title> <log file>');
  });
});

describe('free-port.mjs', () => {
  it('prints a port nothing listens on', async () => {
    const r = spawnSync(process.execPath, [join(scripts, 'free-port.mjs')], { encoding: 'utf8' });
    expect(r.status).toBe(0);
    const port = Number(r.stdout.trim());
    expect(Number.isInteger(port) && port > 0 && port < 65536).toBe(true);
    // Nothing listens: the port can be bound right now.
    await new Promise<void>((done, reject) => {
      const server = createServer();
      server.once('error', reject);
      server.listen(port, '127.0.0.1', () => server.close(() => done()));
    });
  });
});

describe('verify-lib.sh', () => {
  const bash = (script: string, env: Record<string, string> = {}) =>
    spawnSync(bashCommand(), ['-c', `source ${posix(scripts)}/verify-lib.sh; ${script}`], { encoding: 'utf8', env: { ...process.env, VERIFY_ROOT: posix(work), ...env } });

  it('isolates npm, the machine config folder, app-core and the home in the temp root, and switches the automatic update off', () => {
    const r = bash('isolate_env; echo "$npm_config_prefix"; echo "$MACHINE_CONFIG_DIR"; echo "$APP_CORE_CONFIG_DIR"; echo "$HOME"; echo "$USERPROFILE"; cat "$MACHINE_CONFIG_DIR/config.yml"');
    expect(r.status, r.stderr).toBe(0);
    const [prefix, machine, appCore, home, profile, config] = lines(r.stdout).slice(-6);
    for (const value of [prefix, machine, appCore, home, profile]) expect(posix(value!).toLowerCase(), value).toContain(posix(work).toLowerCase());
    expect(config).toBe('autoUpdate: false');
  });

  it('does not leave a daemon port or a stale value of the runner in the environment: MACHINE_CONFIG_DIR is overwritten', () => {
    const r = bash('isolate_env; echo "$MACHINE_CONFIG_DIR"', { MACHINE_CONFIG_DIR: '/somewhere/real' });
    expect(r.stdout.trim()).not.toContain('/somewhere/real');
  });

  it('step prints a label; fail stops with the reason on stderr and a non-zero status', () => {
    expect(bash('step "install the package"').stdout).toContain('==> install the package');
    const failed = bash('fail "version mismatch"');
    expect(failed.status).not.toBe(0);
    expect(failed.stderr).toContain('FAIL: version mismatch');
  });

  it('assert_equals passes on equal values and fails naming both otherwise', () => {
    expect(bash('assert_equals "the version" "1" "1"').status).toBe(0);
    const failed = bash('assert_equals "the version" "1" "2"');
    expect(failed.status).not.toBe(0);
    expect(failed.stderr).toContain("the version: expected '1', got '2'");
  });

  it('assert_platform_package_installed passes when npm lists a machine platform package and fails loudly when none was installed', () => {
    const present = bash('npm() { echo /g/node_modules/@wadeck-app/machine-cli; echo /g/node_modules/@wadeck-app/machine-cli-linux-x64; }; export -f npm; assert_platform_package_installed');
    expect(present.status, present.stderr).toBe(0);
    const absent = bash('npm() { echo /g/node_modules/@wadeck-app/machine-cli; }; export -f npm; assert_platform_package_installed');
    expect(absent.status).not.toBe(0);
    expect(absent.stderr).toContain('no platform package');
    expect(absent.stderr).toContain('optionalDependencies');
  });

  it('the scripts have a header saying how to run them locally', () => {
    for (const script of ['verify-install.sh', 'verify-update.sh', 'verify-lib.sh']) {
      const header = readFileSync(join(scripts, script), 'utf8').split('\n').slice(0, 12).join('\n');
      expect(header, script).toMatch(/Run locally/);
    }
  });

  it('the scripts name the machine package and binary, never a sibling one', () => {
    for (const script of ['verify-install.sh', 'verify-update.sh', 'verify-lib.sh', 'smoke-packed.sh']) {
      const text = readFileSync(join(scripts, script), 'utf8');
      expect(text, script).not.toMatch(/project-cli|run_project/);
    }
    expect(readFileSync(join(scripts, 'verify-update.sh'), 'utf8')).toContain('@wadeck-app/machine-cli');
  });
});

describe('restore-exec-bits.sh', () => {
  const run = (...args: string[]) => spawnSync(bashCommand(), [posix(join(scripts, 'restore-exec-bits.sh')), ...args], { encoding: 'utf8' });

  function tree(): string {
    const dir = join(work, 'packages');
    mkdirSync(join(dir, 'machine-cli-dist', 'bin'), { recursive: true });
    writeFileSync(join(dir, 'machine-cli-dist', 'bin', 'machine.js'), '#!/usr/bin/env node\n');
    for (const p of ['darwin-arm64', 'linux-x64']) {
      mkdirSync(join(dir, `machine-cli-${p}`), { recursive: true });
      writeFileSync(join(dir, `machine-cli-${p}`, 'machine'), 'x');
      chmodSync(join(dir, `machine-cli-${p}`, 'machine'), 0o644);
    }
    mkdirSync(join(dir, 'machine-cli-win32-x64'), { recursive: true });
    writeFileSync(join(dir, 'machine-cli-win32-x64', 'machine.exe'), 'x');
    return dir;
  }

  it('restores the exec bit of the shim and the Unix launchers, skips the win32 one', () => {
    const dir = tree();
    const r = run(posix(dir), 'machine', 'win32-x64,darwin-arm64,linux-x64');
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain('machine-cli-linux-x64/machine');
    expect(r.stdout).not.toContain('machine.exe');
    if (process.platform !== 'win32') {
      for (const f of ['machine-cli-dist/bin/machine.js', 'machine-cli-darwin-arm64/machine', 'machine-cli-linux-x64/machine']) expect(statSync(join(dir, f)).mode & 0o111, f).toBe(0o111);
    }
  });

  it('fails loudly, naming the file, when the artifact is incomplete', () => {
    const dir = tree();
    rmSync(join(dir, 'machine-cli-linux-x64', 'machine'));
    const r = run(posix(dir), 'machine', 'win32-x64,darwin-arm64,linux-x64');
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('machine-cli-linux-x64/machine is missing');
  });

  it('prints the usage without arguments', () => {
    const r = run();
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('usage: restore-exec-bits.sh');
  });
});

describe('smoke-packed.sh', () => {
  const run = (...args: string[]) => spawnSync(bashCommand(), [posix(join(scripts, 'smoke-packed.sh')), ...args], { encoding: 'utf8' });

  it('prints the usage without arguments', () => {
    const r = run();
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('usage: smoke-packed.sh');
  });

  it('refuses a host whose platform is not in the list, naming both', () => {
    const r = run(posix(work), 'machine', '2026.11.14-003-cafebabe', 'freebsd-x64');
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('is not in PLATFORMS');
  });

  it('fails loudly, naming the folder, when a packed package is missing', () => {
    const r = run(posix(work), 'machine', '2026.11.14-003-cafebabe', 'win32-x64,darwin-arm64,linux-x64');
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/machine-cli-dist is missing/);
  });
});
