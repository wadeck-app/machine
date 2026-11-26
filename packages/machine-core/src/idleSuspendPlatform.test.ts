import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { InstallError, findInstallable, unsupportedMessage, type InstallFacts } from './install.js';
import { IDLE_SUSPEND_SERVICE_PATH, IDLE_SUSPEND_TIMER_PATH, idleSuspendScript, idleSuspendServiceUnit, idleSuspendTimerUnit, type IdleScriptOptions } from './idleSuspend.js';
import {
  IDLE_DARWIN_LABEL,
  IDLE_DARWIN_MEASUREMENTS,
  IDLE_DARWIN_PLIST_PATH,
  IDLE_DARWIN_UNAVAILABLE,
  IdleDarwinNotImplemented,
  idleDarwinProbe,
  idleSuspendDarwinPlan,
  idleSuspendDarwinPlist,
  idleSuspendDarwinScript,
  type IdleDarwinProbeId,
} from './idleSuspendDarwin.js';
import { idleSuspendSchedulerFor, idleSuspendScriptFor } from './idleSuspendPlatform.js';

const TOOLS = { date: '/usr/bin/date', ss: '/usr/bin/ss', systemdInhibit: '/usr/bin/systemd-inhibit', logger: '/usr/bin/logger', systemctl: '/usr/bin/systemctl', loginctl: '/usr/bin/loginctl', runuser: '/usr/sbin/runuser', xprintidle: '/usr/bin/xprintidle' };
const OPTIONS: IdleScriptOptions = { minutes: 30, rdpMinutes: 20, sshMinutes: 20, wakeGraceMinutes: 5, root: '', configDir: '/home/alice/.config/machine', tools: TOOLS };

const BASE: InstallFacts = {
  platform: 'linux',
  userName: 'alice',
  systemctlPath: '/usr/bin/systemctl',
  sudoPath: '/usr/bin/sudo',
  configDir: '/home/alice/.config/machine',
  tools: { date: '/usr/bin/date', ss: '/usr/bin/ss', systemdInhibit: '/usr/bin/systemd-inhibit', logger: '/usr/bin/logger', journalctl: '/usr/bin/journalctl', xprintidle: '/usr/bin/xprintidle' },
};
const CASES: Record<string, Partial<InstallFacts>> = {
  default: {},
  fast: { minutes: 5, rdpMinutes: 5, sshMinutes: 5, wakeGraceMinutes: 1 },
  slow: { minutes: 90, rdpMinutes: 60, sshMinutes: 45, wakeGraceMinutes: 60 },
  noXprintidle: { tools: { date: '/usr/bin/date', ss: '/usr/bin/ss', systemdInhibit: '/usr/bin/systemd-inhibit', logger: '/usr/bin/logger' } },
  installedCadence: { minutes: 40, installedCadenceSeconds: 60 },
};

describe('linux output is byte-identical to the output before the platform parameter existed', () => {
  // The fixture was generated from the code BEFORE this change (plan, script, units, summary, notes, next and afterRemove texts for five option sets).
  const snapshot = JSON.parse(readFileSync(new URL('./fixtures/idleSuspendLinux.pre-change.json', import.meta.url), 'utf8')) as Record<string, unknown>;

  it('the snapshot holds every case (a missing case is an error, never a skip)', () => {
    expect(Object.keys(snapshot)).toEqual(Object.keys(CASES));
  });

  it.each(Object.keys(CASES))('%s: plan, next and afterRemove are identical', (name) => {
    const def = findInstallable('idle-suspend');
    if (def === undefined) {
      throw new Error('idle-suspend is not registered');
    }
    const plan = def.plan({ ...BASE, ...CASES[name] });
    const now = { plan, next: def.next(plan, 'box'), afterRemove: def.afterRemove(plan, 'box') };
    expect(JSON.parse(JSON.stringify(now))).toEqual(snapshot[name]);
  });

  it('the platform dispatchers return exactly what the linux functions return', () => {
    expect(idleSuspendScriptFor('linux', OPTIONS)).toBe(idleSuspendScript(OPTIONS));
    for (const cadence of [30, 60, 120]) {
      expect(idleSuspendSchedulerFor('linux', { cadenceSeconds: cadence })).toEqual([
        { id: 'service', path: IDLE_SUSPEND_SERVICE_PATH, mode: '0644', content: idleSuspendServiceUnit() },
        { id: 'timer', path: IDLE_SUSPEND_TIMER_PATH, mode: '0644', content: idleSuspendTimerUnit(cadence) },
      ]);
    }
  });
});

describe('platform dispatch', () => {
  it('a platform other than linux and darwin is an internal error naming the platform', () => {
    expect(() => idleSuspendScriptFor('win32', OPTIONS)).toThrow(InstallError);
    expect(() => idleSuspendScriptFor('win32', OPTIONS)).toThrow(/win32/);
    expect(() => idleSuspendSchedulerFor('plan9', { cadenceSeconds: 60 })).toThrow(/plan9/);
  });

  it('darwin: the script is not available and says which Mac measurements it waits for', () => {
    expect(() => idleSuspendScriptFor('darwin', OPTIONS)).toThrow(IdleDarwinNotImplemented);
    expect(() => idleSuspendScriptFor('darwin', OPTIONS)).toThrow(/^not implemented: needs Mac measurement /);
  });

  it('darwin: the scheduler is the launchd plist', () => {
    const files = idleSuspendSchedulerFor('darwin', { cadenceSeconds: 60, scriptPath: '/usr/local/libexec/machine-idle-suspend' });
    expect(files).toHaveLength(1);
    expect(files[0]).toMatchObject({ id: 'plist', path: IDLE_DARWIN_PLIST_PATH, mode: '0644' });
  });

  it('darwin: the scheduler refuses to guess the script path (the folder is an open decision)', () => {
    expect(() => idleSuspendSchedulerFor('darwin', { cadenceSeconds: 60 })).toThrow(/script path/);
  });
});

describe('darwin: the launchd plist', () => {
  const SCRIPT = '/usr/local/libexec/machine-idle-suspend';

  it('is the root LaunchDaemon: label, program, StartInterval = the cadence, no UserName, no RunAtLoad', () => {
    const text = idleSuspendDarwinPlist({ cadenceSeconds: 120, scriptPath: SCRIPT });
    expect(text).toContain(`<key>Label</key>\n  <string>${IDLE_DARWIN_LABEL}</string>`);
    expect(text).toContain(`<key>ProgramArguments</key>\n  <array>\n    <string>${SCRIPT}</string>\n  </array>`);
    expect(text).toContain('<key>StartInterval</key>\n  <integer>120</integer>');
    expect(text).toContain('<key>RunAtLoad</key>\n  <false/>');
    // No UserName: launchd runs a system daemon as root (macos-idle-suspend-wake.md section 3).
    expect(text).not.toContain('UserName');
    expect(text.startsWith('<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC')).toBe(true);
    expect(text).toContain('<!-- managed by machine install idle-suspend, version 1 -->');
    expect(text.endsWith('</plist>\n')).toBe(true);
  });

  it.each([30, 60, 120])('StartInterval %i', (cadence) => {
    expect(idleSuspendDarwinPlist({ cadenceSeconds: cadence, scriptPath: SCRIPT })).toContain(`<integer>${cadence}</integer>`);
  });

  it('the cadence comes from the shared function of the three minutes options', () => {
    expect(idleSuspendDarwinPlan({ minutes: 5, rdpMinutes: 20, sshMinutes: 20, wakeGraceMinutes: 5 }).cadenceSeconds).toBe(30);
    expect(idleSuspendDarwinPlan({ minutes: 30, rdpMinutes: 20, sshMinutes: 20, wakeGraceMinutes: 5 }).cadenceSeconds).toBe(60);
    expect(idleSuspendDarwinPlan({ minutes: 90, rdpMinutes: 60, sshMinutes: 45, wakeGraceMinutes: 5 }).cadenceSeconds).toBe(120);
  });

  it('refuses a cadence that is not 30, 60 or 120 and a script path that cannot be written into a root-run file', () => {
    expect(() => idleSuspendDarwinPlist({ cadenceSeconds: 45, scriptPath: SCRIPT })).toThrow(/30, 60 or 120/);
    for (const bad of ['relative/script', '/usr/local/a b', '/usr/local/<x>', '/usr/../etc/x', '']) {
      expect(() => idleSuspendDarwinPlist({ cadenceSeconds: 60, scriptPath: bad }), bad).toThrow(InstallError);
    }
  });
});

describe('darwin: the options are validated like linux', () => {
  it.each([
    [{ minutes: 0, rdpMinutes: 20, sshMinutes: 20, wakeGraceMinutes: 5 }, /minutes must be a whole number from 1 to 1440/],
    [{ minutes: 30, rdpMinutes: 1441, sshMinutes: 20, wakeGraceMinutes: 5 }, /minutes must be a whole number from 1 to 1440/],
    [{ minutes: 30, rdpMinutes: 20, sshMinutes: 1.5, wakeGraceMinutes: 5 }, /minutes must be a whole number from 1 to 1440/],
    [{ minutes: 30, rdpMinutes: 20, sshMinutes: 20, wakeGraceMinutes: 0 }, /wake grace must be a whole number of minutes from 1 to 60/],
    [{ minutes: 30, rdpMinutes: 20, sshMinutes: 20, wakeGraceMinutes: 61 }, /wake grace must be a whole number of minutes from 1 to 60/],
  ])('%j', (options, message) => {
    expect(() => idleSuspendDarwinPlan(options)).toThrow(message);
  });
});

describe('darwin: every unvalidated probe fails loudly, naming its Mac measurement', () => {
  const IDS = Object.keys(IDLE_DARWIN_MEASUREMENTS) as IdleDarwinProbeId[];

  it('the probes the task names are all in the table', () => {
    expect(IDS).toEqual(expect.arrayContaining(['resume-detection', 'ssh-classification', 'input-idle', 'power-assertions']));
  });

  it.each(IDS)('%s throws `not implemented: needs Mac measurement <id>` with the test of macos-idle-suspend-wake.md', (id) => {
    let thrown: unknown;
    try {
      idleDarwinProbe(id);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(IdleDarwinNotImplemented);
    expect((thrown as Error).message).toContain(`not implemented: needs Mac measurement ${id}`);
    expect((thrown as Error).message).toContain('macos-idle-suspend-wake.md');
    expect((thrown as Error).message).toContain(IDLE_DARWIN_MEASUREMENTS[id].test);
    expect((thrown as IdleDarwinNotImplemented).probes).toEqual([id]);
  });

  it('the measurements named by the table are tests of section 2 of the spec (or say that none exists yet)', () => {
    const spec = readFileSync(new URL('../../../.claude/specs/2026-11-13_machine-network/macos-idle-suspend-wake.md', import.meta.url), 'utf8');
    for (const id of IDS) {
      const m = /^test (\d+)\b/.exec(IDLE_DARWIN_MEASUREMENTS[id].test);
      if (m !== null) {
        expect(spec, id).toMatch(new RegExp(`^\\| ${m[1]} \\|`, 'm'));
      } else {
        expect(IDLE_DARWIN_MEASUREMENTS[id].test, id).toMatch(/^no test yet/);
      }
    }
  });

  it('the script generator throws once, listing EVERY probe that is not validated', () => {
    let thrown: unknown;
    try {
      idleSuspendDarwinScript(OPTIONS);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(IdleDarwinNotImplemented);
    expect((thrown as IdleDarwinNotImplemented).probes).toEqual(IDS);
    for (const id of IDS) {
      expect((thrown as Error).message).toContain(`needs Mac measurement ${id}`);
    }
  });

  it('the script generator validates the options first (a bad option is the error, not the missing probes)', () => {
    expect(() => idleSuspendDarwinScript({ ...OPTIONS, minutes: 0 })).toThrow(/minutes must be a whole number/);
  });
});

describe('darwin: `machine install idle-suspend` is not available yet', () => {
  const def = (): NonNullable<ReturnType<typeof findInstallable>> => {
    const d = findInstallable('idle-suspend');
    if (d === undefined) {
      throw new Error('idle-suspend is not registered');
    }
    return d;
  };

  it('stays linux only, and the unsupported message on macos says why and what to do', () => {
    expect(def().platforms).toEqual(['linux']);
    const message = unsupportedMessage(def(), 'darwin');
    expect(message.startsWith('not supported on macos yet (supported: linux): ')).toBe(true);
    expect(message).toContain(IDLE_DARWIN_UNAVAILABLE);
    expect(IDLE_DARWIN_UNAVAILABLE).toMatch(/not validated on a real Mac/);
    expect(IDLE_DARWIN_UNAVAILABLE).toContain('macos-idle-suspend-wake.md');
    expect(IDLE_DARWIN_UNAVAILABLE).toMatch(/Nothing was changed/);
  });

  it('the plan of a darwin host refuses with that message', () => {
    expect(() => def().plan({ ...BASE, platform: 'darwin' })).toThrow(new InstallError(unsupportedMessage(def(), 'darwin')));
  });

  it('windows keeps the generic message, and so does the other item on macos', () => {
    expect(unsupportedMessage(def(), 'win32')).toBe('not supported on windows yet (supported: linux)');
    const suspend = findInstallable('suspend');
    expect(suspend && unsupportedMessage(suspend, 'darwin')).toBe('not supported on macos yet (supported: linux)');
  });
});
