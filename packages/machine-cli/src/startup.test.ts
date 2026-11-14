import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cli } from './testing.js';
import { makeOrchStub, type OrchStub } from './orchStub.js';
import { buildShellLine, daemonCommand, disableStartup, enableStartup, findOnPath, quoteArg, startupStatus, StartupError, type DaemonSource } from './startup.js';

let root: string;
let configDir: string;
let stub: OrchStub;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'machine-startup-'));
  configDir = join(root, 'config');
  mkdirSync(configDir);
  stub = makeOrchStub();
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(stub.dir, { recursive: true, force: true });
});

const WIN_BUNDLE: DaemonSource = { platform: 'win32', execPath: 'C:\\Program Files\\nodejs\\node.exe', scriptPath: 'C:\\tools\\my app\\machine.cjs', native: false };
const UNIX_BUNDLE: DaemonSource = { platform: 'linux', execPath: '/usr/bin/node', scriptPath: "/opt/it's here/machine.cjs", native: false };
const UNIX_COMMAND = "'/usr/bin/node' '/opt/it'\\''s here/machine.cjs' daemon";
const expectedPortFile = () => join(configDir, 'daemon.port.json');
const currentCommand = () => `${UNIX_COMMAND} --config-dir '${configDir}'`;
const ensureArgs = (command: string) => ['ensure', 'startup', 'machine', '--command', command, '--restart-on-exit', '--timeout', '0', '--restart-if-changed', '--liveness-strategy', 'portFile', '--liveness-port-file', expectedPortFile(), '--json'];
const missingOrch = () => ({ file: join(root, 'no-such-orch') });

describe('quoteArg', () => {
  it('uses double quotes on Windows and single quotes with the quote escape elsewhere', () => {
    expect(quoteArg('C:\\path with space\\x', 'win32')).toBe('"C:\\path with space\\x"');
    expect(quoteArg('/path with space/x', 'linux')).toBe("'/path with space/x'");
    expect(quoteArg("/it's/x", 'linux')).toBe("'/it'\\''s/x'");
  });

  it('refuses on Windows what cannot be quoted safely for cmd.exe, naming the character', () => {
    expect(() => quoteArg('C:\\a"b\\x', 'win32')).toThrow(/"/);
    expect(() => quoteArg('C:\\%PATH%\\x', 'win32')).toThrow(/%/);
  });
});

describe('daemonCommand', () => {
  it('node + bundle: "<node>" "<bundle>" daemon, with the paths as they are (spaces, quotes)', () => {
    expect(daemonCommand(WIN_BUNDLE)).toBe('"C:\\Program Files\\nodejs\\node.exe" "C:\\tools\\my app\\machine.cjs" daemon');
    expect(daemonCommand(UNIX_BUNDLE)).toBe(UNIX_COMMAND);
  });

  it('a native binary: "<exe>" daemon', () => {
    expect(daemonCommand({ platform: 'win32', execPath: 'C:\\my tools\\machine.exe', native: true })).toBe('"C:\\my tools\\machine.exe" daemon');
    expect(daemonCommand({ platform: 'linux', execPath: '/opt/m m/machine', native: true })).toBe("'/opt/m m/machine' daemon");
  });

  it('adds --config-dir when a configuration directory other than the default is in use', () => {
    expect(daemonCommand(WIN_BUNDLE, 'D:\\my config')).toBe('"C:\\Program Files\\nodejs\\node.exe" "C:\\tools\\my app\\machine.cjs" daemon --config-dir "D:\\my config"');
  });

  it('refuses a script that is not a bundle (sources run by a TypeScript runner) and says how to get one', () => {
    expect(() => daemonCommand({ platform: 'linux', execPath: '/usr/bin/node', scriptPath: '/repo/src/bin.ts', native: false })).toThrow(/npm run bundle/);
    expect(() => daemonCommand({ platform: 'linux', execPath: '/usr/bin/node', native: false })).toThrow(/npm run bundle/);
  });
});

describe('buildShellLine and findOnPath (Windows runs orch.cmd through cmd.exe)', () => {
  it('quotes the program and every argument, quotes inside an argument are escaped', () => {
    expect(buildShellLine('C:\\npm\\orch.cmd', ['ensure', '--command', '"C:\\a b\\n.exe" daemon'])).toBe('"C:\\npm\\orch.cmd" "ensure" "--command" "\\"C:\\a b\\n.exe\\" daemon"');
  });

  it('refuses cmd.exe metacharacters it cannot protect, naming the character', () => {
    expect(() => buildShellLine('orch.cmd', ['--command', 'a & b'])).toThrow(/&/);
  });

  it('finds orch with the extensions of PATHEXT, and returns nothing when it is absent', () => {
    const bin = join(root, 'bin');
    mkdirSync(bin);
    writeFileSync(join(bin, 'orch.cmd'), '');
    expect(findOnPath('orch', { PATH: `${join(root, 'nope')};${bin}`, PATHEXT: '.EXE;.CMD' }, 'win32')).toBe(join(bin, 'orch.cmd'));
    expect(findOnPath('orch', { PATH: join(root, 'nope'), PATHEXT: '.EXE;.CMD' }, 'win32')).toBeUndefined();
  });
});

describe('enableStartup', () => {
  const ctx = () => ({ configDir, orch: stub.orch, daemon: UNIX_BUNDLE, platform: 'linux' as const });

  it('runs exactly the agreed orch ensure with the quoted daemon command and the port file', async () => {
    stub.script({ ensure: { stdout: 'added machine\n' } });
    const r = await enableStartup(ctx());
    expect(stub.calls()).toEqual([ensureArgs(currentCommand())]);
    expect(r).toMatchObject({ action: 'added', id: 'machine', portFile: expectedPortFile() });
  });

  it.each([
    ['plain text', 'updated machine\n', 'updated'],
    ['JSON with an action field', '{"action":"unchanged","id":"machine"}', 'unchanged'],
    ['JSON with another field name', '{"id":"machine","result":"added"}', 'added'],
    ['a JSON string', '"updated"', 'updated'],
  ])('reads the outcome from %s', async (_name, stdout, action) => {
    stub.script({ ensure: { stdout } });
    expect((await enableStartup(ctx())).action).toBe(action);
  });

  it("fails loudly with orch's own output when it cannot be understood", async () => {
    stub.script({ ensure: { stdout: 'something else\n' } });
    await expect(enableStartup(ctx())).rejects.toThrow(/did not say added, updated or unchanged.*something else/s);
  });

  it('orch not installed (program not found): says how to install it', async () => {
    const e = await enableStartup({ ...ctx(), orch: missingOrch() }).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(StartupError);
    expect((e as Error).message).toBe('orch is not installed: npm i -g @wadeck-app/orchestrator-cli');
  });

  it('orch exit 2: the orch daemon could not start', async () => {
    stub.script({ ensure: { code: 2, stderr: 'boom' } });
    await expect(enableStartup(ctx())).rejects.toThrow(/the orch daemon could not be started: run `orch status`/);
  });

  it('orch exit 4: an internal usage bug, with the arguments', async () => {
    stub.script({ ensure: { code: 4, stderr: 'unknown option' } });
    const e = (await enableStartup(ctx()).catch((x: unknown) => x)) as Error;
    expect(e.message).toMatch(/internal error: orch refused its arguments \(usage error, exit 4\)/);
    expect(e.message).toContain('--liveness-port-file');
    expect(e.message).toContain('unknown option');
  });

  it('orch exit 1: stderr verbatim plus a hint', async () => {
    stub.script({ ensure: { code: 1, stderr: 'job file is locked\n' } });
    const e = (await enableStartup(ctx()).catch((x: unknown) => x)) as Error;
    expect(e.message).toContain('job file is locked');
    expect(e.message).toMatch(/orch failed \(exit 1\)/);
    expect(e.message).toMatch(/fix what orch reports, then run `machine startup enable` again/);
  });

  it('any other exit code is reported with its number and output, never swallowed', async () => {
    stub.script({ ensure: { code: 7, stderr: 'odd' } });
    await expect(enableStartup(ctx())).rejects.toThrow(/exit 7.*odd/s);
  });
});

describe('disableStartup', () => {
  const ctx = () => ({ configDir, orch: stub.orch, daemon: UNIX_BUNDLE, platform: 'linux' as const });

  it.each([
    ['removed machine\n', 'removed'],
    ['absent machine\n', 'absent'],
    ['{"result":"absent","id":"machine"}', 'absent'],
  ])('reports %j as %s', async (stdout, outcome) => {
    stub.script({ remove: { stdout } });
    expect(await disableStartup(ctx())).toEqual({ outcome, id: 'machine' });
    expect(stub.calls()).toEqual([['remove', 'machine', '--if-exists']]);
  });

  it('maps the failures like enable does (not installed, exit 2, exit 1)', async () => {
    await expect(disableStartup({ ...ctx(), orch: missingOrch() })).rejects.toThrow(/orch is not installed/);
    stub.script({ remove: { code: 2 } });
    await expect(disableStartup(ctx())).rejects.toThrow(/run `orch status`/);
    stub.script({ remove: { code: 1, stderr: 'nope' } });
    await expect(disableStartup(ctx())).rejects.toThrow(/nope/);
  });
});

describe('startupStatus', () => {
  const ctx = () => ({ configDir, orch: stub.orch, daemon: UNIX_BUNDLE, platform: 'linux' as const });

  it('exit 3 of orch show: the job does not exist', async () => {
    stub.script({ show: { code: 3, stderr: 'no such job' } });
    const r = await startupStatus(ctx());
    expect(r).toMatchObject({ exists: false, expected: currentCommand() });
    expect(stub.calls()).toEqual([['show', 'machine', '--json']]);
  });

  it('same command as enable would write now: up to date', async () => {
    stub.script({ show: { stdout: JSON.stringify({ id: 'machine', command: currentCommand() }) } });
    expect(await startupStatus(ctx())).toMatchObject({ exists: true, command: currentCommand(), upToDate: true });
  });

  it('another command (moved bundle): outdated, and the command is still shown', async () => {
    stub.script({ show: { stdout: JSON.stringify({ job: { id: 'machine', command: "'/old/node' '/old/machine.cjs' daemon" } }) } });
    expect(await startupStatus(ctx())).toMatchObject({ exists: true, command: "'/old/node' '/old/machine.cjs' daemon", upToDate: false });
  });

  it('an answer without a command, exit 1 or a missing orch fail loudly', async () => {
    stub.script({ show: { stdout: '{"id":"machine"}' } });
    await expect(startupStatus(ctx())).rejects.toThrow(/no command.*\{"id":"machine"\}/s);
    stub.script({ show: { code: 1, stderr: 'broken' } });
    await expect(startupStatus(ctx())).rejects.toThrow(/broken/);
    await expect(startupStatus({ ...ctx(), orch: missingOrch() })).rejects.toThrow(/orch is not installed/);
  });
});

describe('machine startup (CLI)', () => {
  const run = (args: string[]) => cli(configDir, args, undefined, { startup: { orch: stub.orch, daemon: UNIX_BUNDLE, platform: 'linux' } });

  it('enable prints the result, the command and the orch install line', async () => {
    stub.script({ ensure: { stdout: 'added machine\n' } });
    const r = await run(['startup', 'enable']);
    expect(r.code, r.err).toBe(0);
    expect(r.out).toContain('[ok] startup job "machine" added');
    expect(r.out).toContain('daemon.port.json');
    expect(r.out.trimEnd().split('\n').at(-1)).toBe('if orch does not start at login, run: orch install');
  });

  it('enable --json: one JSON document on stdout, the orch install line on stderr', async () => {
    stub.script({ ensure: { stdout: 'unchanged machine\n' } });
    const r = await run(['startup', 'enable', '--json']);
    expect(JSON.parse(r.out)).toMatchObject({ action: 'unchanged', id: 'machine' });
    expect(r.err).toContain('orch install');
  });

  it('enable failure: exit 1 with the message on stderr', async () => {
    const r = await cli(configDir, ['startup', 'enable'], undefined, { startup: { orch: missingOrch(), daemon: UNIX_BUNDLE, platform: 'linux' } });
    expect(r.code).toBe(1);
    expect(r.err).toContain('orch is not installed: npm i -g @wadeck-app/orchestrator-cli');
  });

  it('disable prints removed or absent', async () => {
    stub.script({ remove: { stdout: 'absent machine\n' } });
    const r = await run(['startup', 'disable']);
    expect(r.code).toBe(0);
    expect(r.out).toContain('absent');
  });

  it('status exits 0 whether the job exists or not, and tells what to do when outdated', async () => {
    stub.script({ show: { code: 3 } });
    const absent = await run(['startup', 'status']);
    expect(absent.code).toBe(0);
    expect(absent.out).toMatch(/absent.*machine startup enable/);
    stub.script({ show: { stdout: '{"command":"old"}' } });
    const outdated = await run(['startup', 'status']);
    expect(outdated.code).toBe(0);
    expect(outdated.out).toContain('command: old');
    expect(outdated.out).toContain('outdated: run machine startup enable');
  });

  it('a missing or unknown subcommand, or an extra word, is a usage error and orch is not called', async () => {
    for (const args of [['startup'], ['startup', 'start'], ['startup', 'enable', 'now']]) {
      const r = await run(args);
      expect(r.code, args.join(' ')).toBe(2);
      expect(r.err).toMatch(/machine startup enable \| disable \| status/);
    }
    expect(stub.calls()).toEqual([]);
  });

  it('there is no --orch option', async () => {
    const r = await run(['startup', 'enable', '--orch', 'x']);
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/unknown option "--orch"/);
  });
});
