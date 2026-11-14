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

const WIN_BUNDLE: DaemonSource = { platform: 'win32', execPath: 'C:\\Program Files\\nodejs\\node.exe', scriptPath: 'C:\\tools\\my app\\machine.cjs' };
const UNIX_BUNDLE: DaemonSource = { platform: 'linux', execPath: '/usr/bin/node', scriptPath: "/opt/it's here/machine.cjs" };
const UNIX_COMMAND = "'/usr/bin/node' '/opt/it'\\''s here/machine.cjs' daemon";
const expectedPortFile = () => join(configDir, 'daemon.port.json');
const currentCommand = () => `${UNIX_COMMAND} --config-dir '${configDir}'`;
const ensureArgs = (command: string) => ['ensure', 'startup', 'machine', '--command', command, '--restart-on-exit', '--timeout', '0', '--restart-if-changed', '--liveness-strategy', 'portFile', '--liveness-port-file', expectedPortFile(), '--json'];
const missingOrch = () => ({ file: join(root, 'no-such-orch') });
/** What `orch show --json` answers for a job that `machine startup enable` registered. */
const ownedJob = (id = 'machine', command = currentCommand()) => JSON.stringify({ id, command, liveness: { strategy: 'portFile', portFile: expectedPortFile() } });

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

  const WIN_LAUNCHER: DaemonSource = { platform: 'win32', execPath: 'C:\\node.exe', scriptPath: 'C:\\nm\\machine.cjs', launcher: { exe: 'C:\\my cfg\\bin\\1.0.0\\machine.exe' } };
  const UNIX_LAUNCHER: DaemonSource = { platform: 'linux', execPath: '/usr/bin/node', scriptPath: '/opt/lib/machine.cjs', launcher: { exe: '/home/u/.config/machine/bin/1.0.0/machine', bundleOverride: '/opt/lib/machine.cjs' } };

  it('staged launcher on Windows: "<staged exe>" daemon, no override when the launcher finds the bundle by itself', () => {
    expect(daemonCommand(WIN_LAUNCHER)).toBe('"C:\\my cfg\\bin\\1.0.0\\machine.exe" daemon');
    expect(daemonCommand(WIN_LAUNCHER, 'D:\\cfg dir')).toBe('"C:\\my cfg\\bin\\1.0.0\\machine.exe" daemon --config-dir "D:\\cfg dir"');
  });

  it('staged launcher on Unix: LAUNCHER_BUNDLE_OVERRIDE=<bundle> in front of the quoted exe', () => {
    expect(daemonCommand(UNIX_LAUNCHER)).toBe("LAUNCHER_BUNDLE_OVERRIDE='/opt/lib/machine.cjs' '/home/u/.config/machine/bin/1.0.0/machine' daemon");
    expect(daemonCommand(UNIX_LAUNCHER, '/data/my cfg')).toBe("LAUNCHER_BUNDLE_OVERRIDE='/opt/lib/machine.cjs' '/home/u/.config/machine/bin/1.0.0/machine' daemon --config-dir '/data/my cfg'");
  });

  it('staged launcher on Unix without override: just the quoted exe', () => {
    const source: DaemonSource = { ...UNIX_LAUNCHER, launcher: { exe: '/a b/machine' } };
    expect(daemonCommand(source)).toBe("'/a b/machine' daemon");
  });

  it('a single quote in a path of the launcher form is refused on Unix, naming the path and the fix', () => {
    const inBundle: DaemonSource = { ...UNIX_LAUNCHER, launcher: { exe: '/x/machine', bundleOverride: "/o'k/machine.cjs" } };
    expect(() => daemonCommand(inBundle)).toThrow(/o'k.*single quote.*move/s);
    const inExe: DaemonSource = { ...UNIX_LAUNCHER, launcher: { exe: "/it's/machine" } };
    expect(() => daemonCommand(inExe)).toThrow(/single quote/);
    expect(() => daemonCommand(UNIX_LAUNCHER, "/it's/cfg")).toThrow(/single quote/);
  });

  it('a double quote or percent in a path of the launcher form is refused on Windows', () => {
    expect(() => daemonCommand({ ...WIN_LAUNCHER, launcher: { exe: 'C:\\a"b\\machine.exe' } })).toThrow(/"/);
    expect(() => daemonCommand({ ...WIN_LAUNCHER, launcher: { exe: 'C:\\%X%\\machine.exe' } })).toThrow(/%/);
  });

  it('Windows needs the override (node is not where the global modules are) but orch cannot carry it: refused with the fix', () => {
    const source: DaemonSource = { ...WIN_LAUNCHER, launcher: { exe: 'C:\\cfg\\bin\\1\\machine.exe', bundleOverride: 'C:\\nm\\machine.cjs' } };
    expect(() => daemonCommand(source)).toThrow(/cannot find the bundle.*LAUNCHER_BUNDLE_OVERRIDE.*npm/s);
  });

  it('the launcher form with a script that is not a bundle is refused like the node form', () => {
    expect(() => daemonCommand({ ...UNIX_LAUNCHER, scriptPath: '/repo/src/bin.ts' })).toThrow(/npm run bundle/);
  });

  it('adds --config-dir when a configuration directory other than the default is in use', () => {
    expect(daemonCommand(WIN_BUNDLE, 'D:\\my config')).toBe('"C:\\Program Files\\nodejs\\node.exe" "C:\\tools\\my app\\machine.cjs" daemon --config-dir "D:\\my config"');
  });

  it('refuses a script that is not a bundle (sources run by a TypeScript runner) and says how to get one', () => {
    expect(() => daemonCommand({ platform: 'linux', execPath: '/usr/bin/node', scriptPath: '/repo/src/bin.ts' })).toThrow(/npm run bundle/);
    expect(() => daemonCommand({ platform: 'linux', execPath: '/usr/bin/node' })).toThrow(/npm run bundle/);
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

  it('library-only options: another job id, and no restart-on-exit (used by a safety check against the real orch, no CLI flag)', async () => {
    stub.script({ ensure: { stdout: 'added zz-other\n' }, remove: { stdout: 'removed zz-other\n' }, show: { stdout: ownedJob('zz-other') }, list: { stdout: '[]' } });
    const r = await enableStartup({ ...ctx(), id: 'zz-other', restartOnExit: false });
    expect(r.id).toBe('zz-other');
    const expected = ensureArgs(currentCommand());
    expected[2] = 'zz-other';
    expected.splice(expected.indexOf('--restart-on-exit'), 1);
    await disableStartup({ ...ctx(), id: 'zz-other' });
    expect((await startupStatus({ ...ctx(), id: 'zz-other' })).id).toBe('zz-other');
    expect(stub.calls()).toEqual([expected, ['show', 'zz-other', '--json'], ['remove', 'zz-other', '--if-exists'], ['show', 'zz-other', '--json'], ['list', '--json']]);
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
  ])('reports %j as %s (the job is shown first, then removed)', async (stdout, outcome) => {
    stub.script({ show: { stdout: ownedJob() }, remove: { stdout } });
    expect(await disableStartup(ctx())).toEqual({ outcome, id: 'machine' });
    expect(stub.calls()).toEqual([['show', 'machine', '--json'], ['remove', 'machine', '--if-exists']]);
  });

  it('no such job (orch show exit 3): absent, nothing removed', async () => {
    stub.script({ show: { code: 3 } });
    expect(await disableStartup(ctx())).toEqual({ outcome: 'absent', id: 'machine' });
    expect(stub.calls()).toEqual([['show', 'machine', '--json']]);
  });

  it('maps the failures like enable does (not installed, exit 2, exit 1)', async () => {
    await expect(disableStartup({ ...ctx(), orch: missingOrch() })).rejects.toThrow(/orch is not installed/);
    stub.script({ show: { stdout: ownedJob() }, remove: { code: 2 } });
    await expect(disableStartup(ctx())).rejects.toThrow(/run `orch status`/);
    stub.script({ show: { stdout: ownedJob() }, remove: { code: 1, stderr: 'nope' } });
    await expect(disableStartup(ctx())).rejects.toThrow(/nope/);
    stub.script({ show: { code: 1, stderr: 'broken' } });
    await expect(disableStartup(ctx())).rejects.toThrow(/broken/);
  });

  it('a job with this id that machine did not create is NOT removed: the message names the job, the cause and the manual fix', async () => {
    stub.script({ show: { stdout: JSON.stringify({ id: 'machine', command: 'node C:\\other\\thing.js', liveness: { strategy: 'portFile', portFile: 'C:\\other\\x.json' } }) }, remove: { stdout: 'removed machine\n' } });
    const e = (await disableStartup(ctx()).catch((x: unknown) => x)) as Error;
    expect(e).toBeInstanceOf(StartupError);
    expect(e.message).toMatch(/not created by machine/);
    expect(e.message).toContain('node C:\\other\\thing.js');
    expect(e.message).toMatch(/orch remove machine/);
    expect(stub.calls().map((c) => c[0])).toEqual(['show']);
  });

  it('a machine-looking command but another port file is foreign too; so is a missing liveness', async () => {
    for (const liveness of [{ strategy: 'portFile', portFile: join(root, 'elsewhere', 'daemon.port.json') }, undefined]) {
      stub.script({ show: { stdout: JSON.stringify({ id: 'machine', command: currentCommand(), liveness }) }, remove: { stdout: 'removed machine\n' } });
      await expect(disableStartup(ctx())).rejects.toThrow(/not created by machine/);
    }
  });

  it('an older machine job (wscript wrapper with a hash, or without) and the development form are owned', async () => {
    const wrapper = '"C:\\Windows\\System32\\wscript.exe" //B //Nologo "C:\\c\\bin\\1\\machine-daemon.vbs" 0123456789ab';
    stub.script({ show: { stdout: ownedJob('machine', wrapper) }, remove: { stdout: 'removed machine\n' } });
    expect((await disableStartup(ctx())).outcome).toBe('removed');
    stub.script({ show: { stdout: ownedJob('machine', "'/usr/bin/node' '/x/machine.cjs' daemon") }, remove: { stdout: 'removed machine\n' } });
    expect((await disableStartup(ctx())).outcome).toBe('removed');
  });
});

describe('startupStatus', () => {
  const ctx = () => ({ configDir, orch: stub.orch, daemon: UNIX_BUNDLE, platform: 'linux' as const });

  it('exit 3 of orch show: the job does not exist', async () => {
    stub.script({ show: { code: 3, stderr: 'no such job' }, list: { stdout: '[]' } });
    const r = await startupStatus(ctx());
    expect(r).toMatchObject({ exists: false, expected: currentCommand(), conflicts: [] });
    expect(stub.calls()).toEqual([['show', 'machine', '--json'], ['list', '--json']]);
  });

  it('same command as enable would write now: up to date', async () => {
    stub.script({ show: { stdout: JSON.stringify({ id: 'machine', command: currentCommand() }) }, list: { stdout: '[]' } });
    expect(await startupStatus(ctx())).toMatchObject({ exists: true, command: currentCommand(), upToDate: true, conflicts: [] });
  });

  it('another command (moved bundle): outdated, and the command is still shown', async () => {
    stub.script({ show: { stdout: JSON.stringify({ job: { id: 'machine', command: "'/old/node' '/old/machine.cjs' daemon" } }) }, list: { stdout: '[]' } });
    expect(await startupStatus(ctx())).toMatchObject({ exists: true, command: "'/old/node' '/old/machine.cjs' daemon", upToDate: false });
  });

  it('an answer without a command, exit 1 or a missing orch fail loudly', async () => {
    stub.script({ show: { stdout: '{"id":"machine"}' } });
    await expect(startupStatus(ctx())).rejects.toThrow(/no command.*\{"id":"machine"\}/s);
    stub.script({ show: { code: 1, stderr: 'broken' } });
    await expect(startupStatus(ctx())).rejects.toThrow(/broken/);
    await expect(startupStatus({ ...ctx(), orch: missingOrch() })).rejects.toThrow(/orch is not installed/);
  });

  const listOf = (jobs: unknown[]) => ({ stdout: JSON.stringify(jobs) });
  const portJob = (id: string, portFile: string | undefined, command = 'node other.js') => ({ id, command, ...(portFile === undefined ? {} : { liveness: { strategy: 'portFile', portFile } }) });

  it('a second orch job on the same daemon.port.json is reported as a conflict (id and command), ours and unrelated jobs are not', async () => {
    stub.script({
      show: { stdout: ownedJob() },
      list: listOf([portJob('machine', expectedPortFile(), currentCommand()), portJob('copy', expectedPortFile(), 'machine daemon'), portJob('unrelated', join(root, 'x', 'daemon.port.json')), portJob('nolive', undefined)]),
    });
    const r = await startupStatus(ctx());
    expect(r.conflicts).toEqual([{ id: 'copy', command: 'machine daemon' }]);
  });

  it('the conflict is reported even when the machine job itself is absent, and the list may be wrapped in {jobs:[...]}', async () => {
    stub.script({ show: { code: 3 }, list: { stdout: JSON.stringify({ jobs: [portJob('rogue', expectedPortFile())] }) } });
    expect((await startupStatus(ctx())).conflicts).toEqual([{ id: 'rogue', command: 'node other.js' }]);
  });

  it('a list that cannot be read, or an orch list failure, fails loudly (no silent "no conflict")', async () => {
    stub.script({ show: { stdout: ownedJob() }, list: { stdout: 'not json' } });
    await expect(startupStatus(ctx())).rejects.toThrow(/orch list.*not json/s);
    stub.script({ show: { stdout: ownedJob() }, list: { code: 1, stderr: 'broken list' } });
    await expect(startupStatus(ctx())).rejects.toThrow(/broken list/);
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
    stub.script({ show: { code: 3 } });
    const r = await run(['startup', 'disable']);
    expect(r.code).toBe(0);
    expect(r.out).toContain('absent');
  });

  it('disable of a foreign job: exit 1, stderr says why and how to remove it by hand', async () => {
    stub.script({ show: { stdout: JSON.stringify({ id: 'machine', command: 'node mine.js' }) } });
    const r = await run(['startup', 'disable']);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/not created by machine.*orch remove machine/s);
  });

  it('status warns loudly on stderr (and lists the conflicts in --json) when a second job uses the same port file', async () => {
    stub.script({ show: { stdout: ownedJob() }, list: { stdout: JSON.stringify([{ id: 'copy', command: 'machine daemon', liveness: { strategy: 'portFile', portFile: expectedPortFile() } }]) } });
    const r = await run(['startup', 'status']);
    expect(r.code).toBe(0);
    expect(r.err).toMatch(/[warning].*"copy".*daemon.port.json.*orch remove copy/s);
    const j = await run(['startup', 'status', '--json']);
    expect(JSON.parse(j.out).conflicts).toEqual([{ id: 'copy', command: 'machine daemon' }]);
  });

  it('status exits 0 whether the job exists or not, and tells what to do when outdated', async () => {
    stub.script({ show: { code: 3 }, list: { stdout: '[]' } });
    const absent = await run(['startup', 'status']);
    expect(absent.code).toBe(0);
    expect(absent.out).toMatch(/absent.*machine startup enable/);
    stub.script({ show: { stdout: '{"command":"old"}' }, list: { stdout: '[]' } });
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
