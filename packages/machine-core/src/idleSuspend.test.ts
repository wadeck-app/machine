import { describe, expect, it } from 'vitest';
import {
  IDLE_DEFAULT_MINUTES,
  IDLE_GAP_SECONDS,
  IDLE_WAKE_GRACE_DEFAULT_MINUTES,
  IDLE_WAKE_GRACE_MAX_MINUTES,
  IDLE_WAKE_GRACE_MIN_MINUTES,
  IDLE_RESUME_COUNTER_FILE,
  idleCadenceSeconds,
  idleGapSeconds,
  idleResume,
  idleSuspendDelaySeconds,
  idleSuspendInstalledCadenceSeconds,
  idleSuspendInstalledWakeGraceMinutes,
  idleSuspendServiceUnit,
  idleSuspendTimerUnit,
  parseIdleWakeGraceMinutes,
  IDLE_MAX_MINUTES,
  IDLE_MIN_MINUTES,
  IDLE_RDP_DEFAULT_MINUTES,
  IDLE_SSH_DEFAULT_MINUTES,
  IDLE_SSH_NOTTY_BYTES_PER_SECOND,
  idleDecision,
  idleSuspendInstalledMinutes,
  idleSuspendInstalledRdpMinutes,
  idleSuspendInstalledSshMinutes,
  idleSuspendScript,
  parseIdleMinutes,
  parseIdleRdpMinutes,
  parseIdleSshMinutes,
  parseLoadHundredths,
  type IdleFacts,
  type IdleResumeFacts,
  type IdleSshConnection,
} from './idleSuspend.js';
import { InstallError } from './install.js';

const NOW = 1_800_000_000;
const MIN = 30;

/** No resume to protect: the kernel counter did not move for 3 hours (decision 113). */
const QUIET_RESUME: IdleResumeFacts = { counter: 40, stored: { kind: 'counter', counter: 40, seenAt: NOW - 3 * 3600 } };

/** Everything idle, a timer that started `elapsedMin` minutes ago and was checked 2 minutes ago. */
const idle = (over: Partial<IdleFacts> = {}, elapsedMin = 12): IdleFacts => ({
  keepAwake: [{ present: false }, { present: false }],
  connections: { rdp: 0, ssh: 0, peer: 0 },
  // Decision 111: read only with an ssh connection; no ssh session with a tty is no activity.
  sshConnections: [],
  audit: { lastActivityEpoch: NOW - 3 * 3600, openHolds: 0 },
  load5Hundredths: 5,
  inhibitors: 0,
  state: { since: NOW - elapsedMin * 60, last: NOW - 120 },
  // A long quiet keyboard: the input check passes (decision 103); the tests of the input rules set it.
  inputIdleSeconds: 99999,
  ignoredDisplays: [],
  resume: QUIET_RESUME,
  ...over,
});

describe('idleDecision: not idle (each reason, the state is cleared)', () => {
  const notIdle: Array<[string, Partial<IdleFacts>, string]> = [
    ['an indefinite keep-awake file', { keepAwake: [{ present: true, untilEpoch: null }, { present: false }] }, 'not idle: keep-awake requested'],
    ['the second keep-awake file', { keepAwake: [{ present: false }, { present: true, untilEpoch: null }] }, 'not idle: keep-awake requested'],
    ['a keep-awake file until the future', { keepAwake: [{ present: true, untilEpoch: NOW + 1 }, { present: false }] }, 'not idle: keep-awake requested'],
    ['unreadable keep-awake files', { keepAwake: null }, 'not idle: cannot read the keep-awake files'],
    ['an SSH session with a tty and recent input', { connections: { rdp: 0, ssh: 2, peer: 0 }, sshConnections: [{ peer: 'p:1', kind: 'pts', tty: 'pts/1', idleSeconds: 180 }] }, 'not idle: ssh session pts/1 active (input 3 min ago, needs 20)'],
    ['a machine peer connection', { connections: { rdp: 0, ssh: 0, peer: 1 } }, 'not idle: machine peer connected'],
    ['rdp and ssh together: rdp is named first', { connections: { rdp: 1, ssh: 1, peer: 1 }, inputIdleSeconds: 60 }, 'not idle: rdp connected (input 1 min ago, needs 20)'],
    ['unreadable connections', { connections: null }, 'not idle: cannot read the connections (ss or the daemon port file)'],
    ['a request in the last N minutes', { audit: { lastActivityEpoch: NOW - 29 * 60, openHolds: 0 } }, 'not idle: machine request in the last 30 min'],
    ['a request 1 s inside the window', { audit: { lastActivityEpoch: NOW - 30 * 60 + 1, openHolds: 0 } }, 'not idle: machine request in the last 30 min'],
    ['a request stamped in the future (clock error)', { audit: { lastActivityEpoch: NOW + 500, openHolds: 0 } }, 'not idle: machine request in the last 30 min'],
    ['an open hold', { audit: { lastActivityEpoch: null, openHolds: 1 } }, 'not idle: machine request on hold'],
    ['an unreadable audit log', { audit: null }, 'not idle: cannot read the machine audit log'],
    ['a load of 0.30', { load5Hundredths: 30 }, 'not idle: load 0.30 (limit 0.30)'],
    ['a load of 12.07', { load5Hundredths: 1207 }, 'not idle: load 12.07 (limit 0.30)'],
    ['an unreadable load', { load5Hundredths: null }, 'not idle: cannot read the load average'],
    ['a sleep inhibitor', { inhibitors: 1 }, 'not idle: sleep inhibitor held (block)'],
    ['an unreadable inhibitor list', { inhibitors: null }, 'not idle: cannot list the sleep inhibitors'],
  ];
  it.each(notIdle)('%s', (_name, over, reason) => {
    expect(idleDecision(idle(over, 40), NOW, MIN)).toEqual({ suspend: false, reason, state: null });
  });

  it('a request exactly N minutes ago no longer counts', () => {
    expect(idleDecision(idle({ audit: { lastActivityEpoch: NOW - 30 * 60, openHolds: 0 } }, 40), NOW, MIN).reason).toBe('suspending: idle 40 min');
  });

  it('an expired "until" keep-awake file (and a missing audit activity) does not hold the box', () => {
    const d = idleDecision(idle({ keepAwake: [{ present: true, untilEpoch: NOW }, { present: false }], audit: { lastActivityEpoch: null, openHolds: 0 } }, 31), NOW, MIN);
    expect(d.suspend).toBe(true);
  });

  it('the checks run in a fixed order: the first failing one is the reason', () => {
    const everything = idle({ keepAwake: null, connections: null, audit: null, load5Hundredths: null, inhibitors: null, state: null }, 99);
    expect(idleDecision(everything, NOW, MIN).reason).toBe('not idle: cannot read the keep-awake files');
    expect(idleDecision({ ...everything, keepAwake: [] }, NOW, MIN).reason).toBe('not idle: cannot read the connections (ss or the daemon port file)');
    expect(idleDecision({ ...everything, keepAwake: [], connections: { rdp: 0, ssh: 0, peer: 0 } }, NOW, MIN).reason).toBe('not idle: cannot read the machine audit log');
  });
});

describe('idleDecision: idle (the timer)', () => {
  it('no state yet: starts the timer at 0', () => {
    expect(idleDecision(idle({ state: 'absent' }), NOW, MIN)).toEqual({ suspend: false, reason: 'idle 0/30 min', state: { since: NOW, last: NOW } });
  });

  it('counts the whole minutes: 12/30 and keeps the start', () => {
    expect(idleDecision(idle({}, 12), NOW, MIN)).toEqual({ suspend: false, reason: 'idle 12/30 min', state: { since: NOW - 720, last: NOW } });
    expect(idleDecision(idle({}, 12), NOW + 0, MIN).state?.since).toBe(NOW - 720);
  });

  it('59 seconds short of N minutes: still waiting', () => {
    const f = idle({ state: { since: NOW - 30 * 60 + 1, last: NOW - 120 } });
    expect(idleDecision(f, NOW, MIN)).toMatchObject({ suspend: false, reason: 'idle 29/30 min' });
  });

  it('exactly N minutes: suspends and clears the state (a resume starts from zero)', () => {
    expect(idleDecision(idle({}, 30), NOW, MIN)).toEqual({ suspend: true, reason: 'suspending: idle 30 min', state: null });
  });

  it('later than N minutes: the elapsed whole minutes are named', () => {
    expect(idleDecision(idle({}, 47), NOW, MIN)).toEqual({ suspend: true, reason: 'suspending: idle 47 min', state: null });
  });

  it('works with the smallest and the largest N', () => {
    expect(idleDecision(idle({}, 5), NOW, 5).suspend).toBe(true);
    expect(idleDecision(idle({}, 4), NOW, 5).reason).toBe('idle 4/5 min');
    const quiet = { audit: { lastActivityEpoch: NOW - 2 * 86400, openHolds: 0 } };
    expect(idleDecision(idle({ ...quiet }, 1439), NOW, IDLE_MAX_MINUTES).reason).toBe('idle 1439/1440 min');
    expect(idleDecision(idle({ ...quiet, state: { since: NOW - 1440 * 60, last: NOW - 120 } }), NOW, IDLE_MAX_MINUTES).suspend).toBe(true);
  });

  it('the last check older than the gap: the box slept or was off, the timer restarts (never suspends)', () => {
    const gap = idleGapSeconds(idleCadenceSeconds(MIN, 20, 20));
    const f = idle({ state: { since: NOW - 3 * 3600, last: NOW - gap - 1 } });
    expect(idleDecision(f, NOW, MIN)).toEqual({ suspend: false, reason: 'idle 0/30 min (timer restarted: no check for more than 10 min, the box slept or was off)', state: { since: NOW, last: NOW } });
  });

  it('a gap of exactly the limit is still the same run', () => {
    const f = idle({ state: { since: NOW - 31 * 60, last: NOW - idleGapSeconds(60) } });
    expect(idleDecision(f, NOW, MIN).suspend).toBe(true);
  });

  it('the clock went backwards: restarts instead of computing a negative or huge delay', () => {
    for (const state of [{ since: NOW + 10, last: NOW + 10 }, { since: NOW - 3600, last: NOW + 1 }]) {
      expect(idleDecision(idle({ state }), NOW, MIN)).toEqual({ suspend: false, reason: 'idle 0/30 min (timer restarted: the clock went back)', state: { since: NOW, last: NOW } });
    }
  });

  it('an unreadable or inconsistent state file restarts the timer, never suspends', () => {
    const restarted = { suspend: false, reason: 'idle 0/30 min (timer restarted: the state file is unreadable)', state: { since: NOW, last: NOW } };
    expect(idleDecision(idle({ state: null }), NOW, MIN)).toEqual(restarted);
    expect(idleDecision(idle({ state: { since: NOW - 10, last: NOW - 3600 } }), NOW, MIN)).toEqual(restarted);
  });

  it('suspends ONLY when every check passed: any single failure of a long-idle box does not suspend', () => {
    const long = idle({}, 600);
    expect(idleDecision(long, NOW, MIN).suspend).toBe(true);
    for (const over of [{ keepAwake: null }, { connections: null }, { audit: null }, { load5Hundredths: null }, { inhibitors: null }, { load5Hundredths: 30 }, { inhibitors: 3 }] as Array<Partial<IdleFacts>>) {
      expect(idleDecision({ ...long, ...over }, NOW, MIN).suspend, JSON.stringify(over)).toBe(false);
    }
  });

  it('refuses a non-integer, out-of-range or non-finite N and a bad clock, loudly', () => {
    for (const bad of [1441, 0, -30, 30.5, NaN, Infinity, 1e21]) {
      expect(() => idleDecision(idle(), NOW, bad), String(bad)).toThrow(/minutes/);
    }
    for (const bad of [NaN, -1, 1.5, Infinity]) {
      expect(() => idleDecision(idle(), bad, MIN), String(bad)).toThrow(/clock/);
    }
  });
});

describe('parseIdleMinutes', () => {
  it('accepts whole numbers 1 to 1440 only', () => {
    expect(parseIdleMinutes('30')).toBe(30);
    expect(parseIdleMinutes('1')).toBe(1);
    expect(parseIdleMinutes('3')).toBe(3);
    expect(parseIdleMinutes('1440')).toBe(1440);
    for (const bad of ['0', '1441', '', ' 30', '30 ', '3e1', '0x1e', '30.0', '-30', '+30', '030', 'abc', '30; reboot']) {
      expect(() => parseIdleMinutes(bad), bad).toThrow(/--minutes/);
    }
  });
  it('the error names the range and the default', () => {
    expect(() => parseIdleMinutes('0')).toThrow(/from 1 to 1440/);
    expect(IDLE_DEFAULT_MINUTES).toBe(30);
  });
});

describe('parseLoadHundredths', () => {
  it('reads the 5-minute figure of /proc/loadavg as hundredths', () => {
    expect(parseLoadHundredths('0.05 0.08 0.01 1/200 1234\n')).toBe(8);
    expect(parseLoadHundredths('1.00 0.29 0.01 1/200 1234')).toBe(29);
    expect(parseLoadHundredths('1.00 12.07 0.01 1/200 1234')).toBe(1207);
  });
  it('anything else is unreadable (null)', () => {
    for (const bad of ['', '\n', '0.05', '0.05 abc 0.01', '0.05 0.8 0.01', '0.05 -0.08 0.01', '0.05 00.08 0.01', '0.05 0.080 0.01', '0.05 1e-1 0.01']) {
      expect(parseLoadHundredths(bad), JSON.stringify(bad)).toBeNull();
    }
  });
});

describe('idleSuspendScript (the generated shell)', () => {
  const opts = {
    minutes: 30,
    rdpMinutes: 20,
    sshMinutes: 20,
    wakeGraceMinutes: 5,
    root: '',
    configDir: '/home/alice/.config/machine',
    tools: { date: '/usr/bin/date', ss: '/usr/bin/ss', systemdInhibit: '/usr/bin/systemd-inhibit', logger: '/usr/bin/logger', systemctl: '/usr/bin/systemctl', loginctl: '/usr/bin/loginctl', runuser: '/usr/sbin/runuser', xprintidle: '/usr/bin/xprintidle' },
  };
  const script = (o: Partial<typeof opts> = {}): string => idleSuspendScript({ ...opts, ...o });

  it('starts with the shebang, carries the marker and the minutes, ends with a newline', () => {
    const s = script();
    expect(s.split('\n')[0]).toBe('#!/bin/sh');
    expect(s.split('\n')).toContain('# managed by machine install idle-suspend, version 8');
    expect(s).toMatch(/^MINUTES=30$/m);
    expect(s.endsWith('\n')).toBe(true);
    expect(idleSuspendInstalledMinutes(s)).toBe(30);
  });

  it('names every tool by its absolute path and suspends with --no-block', () => {
    const s = script();
    for (const t of Object.values(opts.tools)) expect(s, t).toContain(t);
    expect(s).toContain('--no-block suspend');
  });

  it('is deterministic and changes with the minutes only where expected', () => {
    expect(script()).toBe(script());
    expect(script({ minutes: 45 })).toBe(script().replace('MINUTES=30', 'MINUTES=45'));
  });

  it('refuses a minutes value outside 1..1440 or not an integer', () => {
    for (const minutes of [0, 1441, 30.5, NaN]) expect(() => script({ minutes })).toThrow(InstallError);
  });

  it('refuses every unsafe path (quote, space, newline, dollar, backtick, relative, dot dot)', () => {
    for (const bad of ["/home/a'b/m", '/home/a b/m', '/home/a\nb', '/home/$HOME/m', '/home/`id`/m', 'relative/m', '/home/../etc', '', '/home/a;b/m', '/home//m', '/home/m/']) {
      expect(() => script({ configDir: bad }), JSON.stringify(bad)).toThrow(InstallError);
    }
    for (const bad of ["/usr/bin/d'ate", '/usr/bin/da te', 'date', '/usr/bin/$x']) {
      expect(() => script({ tools: { ...opts.tools, date: bad } }), bad).toThrow(InstallError);
    }
  });

  it('refuses an unsafe test root', () => {
    for (const bad of ["a'b", 'a b', '$x', 'a;b', '../x', '/']) expect(() => script({ root: bad }), bad).toThrow(InstallError);
  });

  it('the shipped script has no environment-variable override and reads no argument', () => {
    const s = script();
    expect(s).not.toMatch(/\$[@*]|\$\{[0-9@*]/);
    expect(s).not.toMatch(/\$\{?(MACHINE|IDLE|ROOT_|TEST)/);
    expect(s).toMatch(/^ROOT=''$/m);
  });

  it('idleSuspendInstalledMinutes: undefined for anything that is not this script', () => {
    expect(idleSuspendInstalledMinutes('#!/bin/sh\necho hi\n')).toBeUndefined();
    expect(idleSuspendInstalledMinutes('MINUTES=9999\n')).toBeUndefined();
    expect(idleSuspendInstalledMinutes('MINUTES=abc\n')).toBeUndefined();
  });

  it('decision 102: the three tools of the input check are written as absolute paths, and the unsafe ones are refused', () => {
    const s = script();
    expect(s).toMatch(/^XPRINTIDLE='\/usr\/bin\/xprintidle'$/m);
    expect(s).toMatch(/^RUNUSER='\/usr\/sbin\/runuser'$/m);
    expect(s).toMatch(/^LOGINCTL='\/usr\/bin\/loginctl'$/m);
    for (const key of ['loginctl', 'runuser', 'xprintidle'] as const) {
      expect(() => script({ tools: { ...opts.tools, [key]: "/usr/bin/x'y" } }), key).toThrow(InstallError);
    }
  });

  it('decision 105: no user text is spliced into the command run as the session user (the name comes from loginctl and is whitelisted first)', () => {
    const s = script();
    expect(s).toMatch(/"\$ROOT\$RUNUSER" -u "\$s_name" -- "\$ROOT\$XPRINTIDLE"/);
    expect(s).toMatch(/show-session "\$sid" -p Name -p Type -p Display -p Class -p State/);
    // Decision 111: stat reads only a tty name that matched ^pts/N$ first (never a user-controlled path).
    expect(s).not.toMatch(/\$STAT\b/);
    expect(s.indexOf("'^pts/[0-9]{1,6}$'")).toBeGreaterThan(-1);
    expect(s.indexOf("'^pts/[0-9]{1,6}$'")).toBeLessThan(s.indexOf('stat -c %X'));
    // The session user is checked against the same pattern as the installing user before it is used.
    expect(s).toContain('^[a-z_][a-z0-9_-]{0,31}$');
  });

  it('decision 103: the RDP minutes are in the script (RDP_MINUTES=<n>), read back by idleSuspendInstalledRdpMinutes, refused out of 1..1440', () => {
    expect(script()).toMatch(/^RDP_MINUTES=20$/m);
    expect(script({ rdpMinutes: 45 })).toBe(script().replace('RDP_MINUTES=20', 'RDP_MINUTES=45'));
    expect(idleSuspendInstalledRdpMinutes(script({ rdpMinutes: 45 }))).toBe(45);
    expect(idleSuspendInstalledRdpMinutes('#!/bin/sh\nMINUTES=30\n')).toBeUndefined();
    expect(idleSuspendInstalledRdpMinutes('RDP_MINUTES=9999\n')).toBeUndefined();
    for (const rdpMinutes of [0, 1441, 20.5, NaN]) expect(() => script({ rdpMinutes }), String(rdpMinutes)).toThrow(InstallError);
  });
});

describe('parseIdleRdpMinutes (--rdp-minutes)', () => {
  it('accepts whole minutes 1..1440 and names the flag in the refusal', () => {
    expect(parseIdleRdpMinutes('1')).toBe(1);
    expect(parseIdleRdpMinutes('3')).toBe(3);
    expect(parseIdleRdpMinutes('1440')).toBe(1440);
    for (const bad of ['0', '1441', '20m', '', '-5', '1e2', '2.5', ' 20']) {
      expect(() => parseIdleRdpMinutes(bad), bad).toThrow(/--rdp-minutes must be a whole number of minutes from 1 to 1440 \(default 20\)/);
    }
  });
});

// Decision 103: two input-idle thresholds. N (--minutes) without an RDP connection, R (--rdp-minutes, default 20) with one.
describe('idleDecision: RDP connected (decision 103): the input idle time against R, no extra timer', () => {
  const R = 20;
  const rdp = { rdp: 1, ssh: 0, peer: 0 };
  const withRdp = (inputIdleSeconds: IdleFacts['inputIdleSeconds'], over: Partial<IdleFacts> = {}, elapsedMin = 12): IdleFacts => idle({ connections: rdp, inputIdleSeconds, ...over }, elapsedMin);
  const notIdle = (reason: string): { suspend: boolean; reason: string; state: null } => ({ suspend: false, reason, state: null });
  const decide = (f: IdleFacts, minutes = MIN): ReturnType<typeof idleDecision> => idleDecision(f, NOW, minutes, R);

  it('xprintidle is not installed: counts as activity and says how to fix it', () => {
    expect(decide(withRdp('missing'))).toEqual(notIdle('not idle: rdp connected (xprintidle is not installed: sudo apt install xprintidle)'));
  });
  it('the input idle time cannot be read: counts as activity, with the cause', () => {
    expect(decide(withRdp({ unreadable: 'xprintidle failed on :10 as alice' }))).toEqual(notIdle('not idle: rdp connected (input idle unreadable: xprintidle failed on :10 as alice)'));
  });
  it('input 0 s, 3 min, R*60-1 s ago: activity (whole minutes and the threshold shown)', () => {
    expect(decide(withRdp(0)).reason).toBe('not idle: rdp connected (input 0 min ago, needs 20)');
    expect(decide(withRdp(180)).reason).toBe('not idle: rdp connected (input 3 min ago, needs 20)');
    expect(decide(withRdp(R * 60 - 1)).reason).toBe('not idle: rdp connected (input 19 min ago, needs 20)');
  });
  it('the threshold is R, not N: input 25 min ago with N = 30 and R = 20 is not activity', () => {
    expect(decide(withRdp(25 * 60)).reason).toBe('suspending: rdp connected but no input for 25 min (needs 20)');
  });
  it('input exactly R min ago, the state is fresh (checks passed before): suspends at once, NO N-minute timer', () => {
    expect(decide(withRdp(R * 60, { state: { since: NOW - 120, last: NOW - 120 } }))).toEqual({ suspend: true, reason: 'suspending: rdp connected but no input for 20 min (needs 20)', state: null });
  });
  it('the elapsed time of the state does not matter in this mode (a 2-minute-old state suspends as a 40-minute-old one)', () => {
    expect(decide(withRdp(R * 60 + 5 * 60, { state: { since: NOW - 120, last: NOW - 120 } })).reason).toBe('suspending: rdp connected but no input for 25 min (needs 20)');
    expect(decide(withRdp(R * 60 + 5 * 60, { state: { since: NOW - 40 * 60, last: NOW - 120 } })).reason).toBe('suspending: rdp connected but no input for 25 min (needs 20)');
  });
  it('after a wake or a first pass the other checks must pass ONCE before the suspend: no state, unusable, clock back, gap > the gap limit all restart', () => {
    const base = 'idle: rdp connected but no input for 30 min (needs 20), confirming at the next check';
    const r = (state: IdleFacts['state']): ReturnType<typeof idleDecision> => decide(withRdp(30 * 60, { state }));
    expect(r('absent')).toEqual({ suspend: false, reason: base, state: { since: NOW, last: NOW } });
    expect(r(null).reason).toBe(`${base} (timer restarted: the state file is unreadable)`);
    expect(r({ since: NOW + 10, last: NOW + 10 }).reason).toBe(`${base} (timer restarted: the clock went back)`);
    expect(r({ since: NOW - 3600, last: NOW - 601 }).reason).toBe(`${base} (timer restarted: no check for more than 10 min, the box slept or was off)`);
    expect(r({ since: NOW - 3600, last: NOW - 600 }).suspend).toBe(true);
  });
  it('the other checks still gate it: load, request in the last N min, inhibitor, keep-awake', () => {
    expect(decide(withRdp(3600, { load5Hundredths: 99 })).reason).toBe('not idle: load 0.99 (limit 0.30)');
    expect(decide(withRdp(3600, { audit: { lastActivityEpoch: NOW - 29 * 60, openHolds: 0 } })).reason).toBe('not idle: machine request in the last 30 min');
    expect(decide(withRdp(3600, { inhibitors: 1 })).reason).toBe('not idle: sleep inhibitor held (block)');
    expect(decide(withRdp(3600, { keepAwake: [{ present: true, untilEpoch: null }, { present: false }] })).reason).toBe('not idle: keep-awake requested');
  });
  it('a fresh ssh tty session and a peer connection stay activity whatever the X input idle time', () => {
    expect(decide(idle({ connections: { rdp: 1, ssh: 1, peer: 0 }, inputIdleSeconds: 99999, sshConnections: [{ peer: 'p:1', kind: 'pts', tty: 'pts/0', idleSeconds: 5 }] })).reason).toBe('not idle: ssh session pts/0 active (input 0 min ago, needs 20)');
    expect(decide(idle({ connections: { rdp: 1, ssh: 0, peer: 1 }, inputIdleSeconds: 99999 })).reason).toBe('not idle: machine peer connected');
  });
  it('R follows the parameter (5 min boundary, and 1440)', () => {
    const f = (s: number): IdleFacts => withRdp(s, { state: { since: NOW - 120, last: NOW - 120 } });
    expect(idleDecision(f(299), NOW, MIN, 5).reason).toBe('not idle: rdp connected (input 4 min ago, needs 5)');
    expect(idleDecision(f(300), NOW, MIN, 5).suspend).toBe(true);
    expect(idleDecision(f(1440 * 60 - 1), NOW, MIN, 1440).suspend).toBe(false);
    expect(idleDecision(f(1440 * 60), NOW, MIN, 1440).suspend).toBe(true);
  });
  it('R is independent of N (N = 5 does not shorten the RDP wait)', () => {
    expect(decide(withRdp(10 * 60), 5).reason).toBe('not idle: rdp connected (input 10 min ago, needs 20)');
  });
  it('a negative or fractional input idle time, or an R out of range, is refused as a programming error', () => {
    expect(() => decide(withRdp(-1))).toThrow(InstallError);
    expect(() => decide(withRdp(1.5))).toThrow(InstallError);
    for (const rdpMinutes of [0, 1441, 2.5]) expect(() => idleDecision(withRdp(3600), NOW, MIN, rdpMinutes)).toThrow(InstallError);
  });
  it('the default R is 20', () => {
    expect(idleDecision(withRdp(19 * 60), NOW, MIN).reason).toContain('needs 20');
    expect(IDLE_RDP_DEFAULT_MINUTES).toBe(20);
  });
});

describe('idleDecision: NO RDP connection (decision 103): input idle >= N and the N-minute timer', () => {
  const N = 5;
  const noRdp = (inputIdleSeconds: IdleFacts['inputIdleSeconds'], over: Partial<IdleFacts> = {}, elapsedMin = 12): IdleFacts => idle({ inputIdleSeconds, ...over }, elapsedMin);
  const decide = (f: IdleFacts, minutes = N): ReturnType<typeof idleDecision> => idleDecision(f, NOW, minutes, 20);

  it('input N*60-1 s ago: not idle, with the minutes and the threshold', () => {
    expect(decide(noRdp(N * 60 - 1))).toEqual({ suspend: false, reason: 'not idle: input 4 min ago (needs 5)', state: null });
    expect(decide(noRdp(0)).reason).toBe('not idle: input 0 min ago (needs 5)');
    expect(decide(noRdp(120)).reason).toBe('not idle: input 2 min ago (needs 5)');
  });
  it('input exactly N*60 s ago: the check passes and the existing timer runs', () => {
    expect(decide(noRdp(N * 60))).toEqual({ suspend: true, reason: 'suspending: idle 12 min', state: null });
    expect(decide(noRdp(N * 60, { state: { since: NOW - 4 * 60, last: NOW - 120 } })).reason).toBe('idle 4/5 min');
  });
  it('the timer rule is unchanged: a fresh start is 0/N, N-1 min waits, N min suspends', () => {
    expect(decide(noRdp(3600, { state: 'absent' })).reason).toBe('idle 0/5 min');
    expect(decide(noRdp(3600, { state: { since: NOW - 4 * 60 - 59, last: NOW - 120 } })).reason).toBe('idle 4/5 min');
    expect(decide(noRdp(3600, { state: { since: NOW - 5 * 60, last: NOW - 120 } })).suspend).toBe(true);
  });
  it('xprintidle missing: the timer-only rule, said on every timer line, never silent', () => {
    const note = ' (input idleness not checked: xprintidle is not installed)';
    expect(decide(noRdp('missing', { state: 'absent' })).reason).toBe(`idle 0/5 min${note}`);
    expect(decide(noRdp('missing', { state: { since: NOW - 3 * 60, last: NOW - 120 } })).reason).toBe(`idle 3/5 min${note}`);
    expect(decide(noRdp('missing'))).toEqual({ suspend: true, reason: `suspending: idle 12 min${note}`, state: null });
    expect(decide(noRdp('missing', { state: null })).reason).toBe(`idle 0/5 min (timer restarted: the state file is unreadable)${note}`);
  });
  it('input unreadable: the same, with the cause', () => {
    const note = ' (input idleness not checked: no X display in /tmp/.X11-unix)';
    expect(decide(noRdp({ unreadable: 'no X display in /tmp/.X11-unix' }))).toEqual({ suspend: true, reason: `suspending: idle 12 min${note}`, state: null });
  });
  it('the note is on timer lines only, never on a not-idle line', () => {
    expect(decide(noRdp('missing', { load5Hundredths: 99 })).reason).toBe('not idle: load 0.99 (limit 0.30)');
  });
  it('the input check comes after the connections and before the audit log (order of the reasons)', () => {
    const everything = noRdp(0, { connections: { rdp: 0, ssh: 1, peer: 0 }, sshConnections: [{ peer: 'p:1', kind: 'pts', tty: 'pts/0', idleSeconds: 5 }], audit: null });
    expect(decide(everything).reason).toBe('not idle: ssh session pts/0 active (input 0 min ago, needs 20)');
    expect(decide({ ...everything, connections: { rdp: 0, ssh: 0, peer: 0 } }).reason).toBe('not idle: input 0 min ago (needs 5)');
    expect(decide({ ...everything, connections: { rdp: 0, ssh: 0, peer: 0 }, inputIdleSeconds: 99999 }).reason).toBe('not idle: cannot read the machine audit log');
  });
  it('N = 30: input 29 min 59 s is not idle, 30 min passes', () => {
    expect(idleDecision(noRdp(30 * 60 - 1), NOW, 30, 20).reason).toBe('not idle: input 29 min ago (needs 30)');
    expect(idleDecision(noRdp(30 * 60), NOW, 30, 20).reason).toBe('idle 12/30 min');
  });
});

// Decision 105: the input idle time is measured per user SESSION (loginctl), not per X socket: a display without a user session (the greeter) is ignored, said once.
describe('idleDecision: sessions (decision 105)', () => {
  const R = 20;
  const decide = (f: IdleFacts, minutes = MIN): ReturnType<typeof idleDecision> => idleDecision(f, NOW, minutes, R);
  const rdp = { rdp: 1, ssh: 0, peer: 0 };
  const GREETER = ' (ignored display :0: no user session)';

  it('RDP, no user session at all: counts as activity, the line says so', () => {
    expect(decide(idle({ connections: rdp, inputIdleSeconds: 'no-session' }))).toEqual({ suspend: false, reason: 'not idle: rdp connected but no user session found', state: null });
  });
  it('no RDP, no user session: the timer alone, said on the timer lines', () => {
    expect(decide(idle({ inputIdleSeconds: 'no-session' }, 40)).reason).toBe('suspending: idle 40 min (input idleness not checked: no user session found)');
  });
  it('an ignored display is said on the lines that state the input idle time, once', () => {
    const over = (o: Partial<IdleFacts>): IdleFacts => idle({ ignoredDisplays: [0], ...o }, 40);
    expect(decide(over({ connections: rdp, inputIdleSeconds: 180 })).reason).toBe(`not idle: rdp connected (input 3 min ago, needs 20)${GREETER}`);
    expect(decide(over({ connections: rdp, inputIdleSeconds: 3600 })).reason).toBe(`suspending: rdp connected but no input for 60 min (needs 20)${GREETER}`);
    expect(decide(over({ connections: rdp, inputIdleSeconds: 3600, state: 'absent' })).reason).toBe(`idle: rdp connected but no input for 60 min (needs 20), confirming at the next check${GREETER}`);
    expect(decide(over({ inputIdleSeconds: 60 })).reason).toBe(`not idle: input 1 min ago (needs 30)${GREETER}`);
    expect(decide(over({ inputIdleSeconds: 3600, state: 'absent' })).reason).toBe(`idle 0/30 min${GREETER}`);
    expect(decide(over({ inputIdleSeconds: 3600 })).reason).toBe(`suspending: idle 40 min${GREETER}`);
  });
  it('several ignored displays are listed in one phrase', () => {
    expect(decide(idle({ ignoredDisplays: [0, 1], inputIdleSeconds: 60 })).reason).toBe('not idle: input 1 min ago (needs 30) (ignored displays :0, :1: no user session)');
  });
  it('no ignored display: no suffix; the suffix is never on an unreadable or other not-idle line', () => {
    expect(decide(idle({ inputIdleSeconds: 60 })).reason).toBe('not idle: input 1 min ago (needs 30)');
    expect(decide(idle({ ignoredDisplays: [0], connections: rdp, inputIdleSeconds: { unreadable: 'xprintidle failed on :10 as wadeck' } })).reason).toBe('not idle: rdp connected (input idle unreadable: xprintidle failed on :10 as wadeck)');
    expect(decide(idle({ ignoredDisplays: [0], inputIdleSeconds: 3600, load5Hundredths: 99 })).reason).toBe('not idle: load 0.99 (limit 0.30)');
    expect(decide(idle({ ignoredDisplays: [0], inputIdleSeconds: 'missing' }, 40)).reason).toBe('suspending: idle 40 min (input idleness not checked: xprintidle is not installed)');
  });
});

// Decision 106: the lower bound of --minutes and --rdp-minutes is 1.
describe('minimum of 1 minute (decision 106)', () => {
  const rdp = { rdp: 1, ssh: 0, peer: 0 };
  it('one constant: the bounds are 1 and 1440, the defaults stay 30 and 20', () => {
    expect(IDLE_MIN_MINUTES).toBe(1);
    expect(IDLE_MAX_MINUTES).toBe(1440);
    expect(IDLE_DEFAULT_MINUTES).toBe(30);
    expect(IDLE_RDP_DEFAULT_MINUTES).toBe(20);
  });
  it('the error text of both flags says from 1 to 1440', () => {
    expect(() => parseIdleMinutes('0')).toThrow('--minutes must be a whole number of minutes from 1 to 1440 (default 30), got "0": for example `machine install idle-suspend --minutes 30`');
    expect(() => parseIdleRdpMinutes('0')).toThrow('--rdp-minutes must be a whole number of minutes from 1 to 1440 (default 20), got "0": for example `machine install idle-suspend --rdp-minutes 20`');
  });
  it('N = 1 without RDP: input 59 s is not idle, 60 s passes; the timer suspends at 1 whole minute', () => {
    expect(idleDecision(idle({ inputIdleSeconds: 59 }), NOW, 1, 1).reason).toBe('not idle: input 0 min ago (needs 1)');
    expect(idleDecision(idle({ inputIdleSeconds: 60, state: { since: NOW - 60, last: NOW - 30 } }), NOW, 1, 1)).toEqual({ suspend: true, reason: 'suspending: idle 1 min', state: null });
    expect(idleDecision(idle({ inputIdleSeconds: 60, state: { since: NOW - 30, last: NOW - 30 } }), NOW, 1, 1).reason).toBe('idle 0/1 min');
  });
  it('R = 3 with RDP: input 179 s is activity, 180 s suspends at the next check', () => {
    const f = (s: number): IdleFacts => idle({ connections: rdp, inputIdleSeconds: s });
    expect(idleDecision(f(179), NOW, 9, 3).reason).toBe('not idle: rdp connected (input 2 min ago, needs 3)');
    expect(idleDecision(f(180), NOW, 9, 3).reason).toBe('suspending: rdp connected but no input for 3 min (needs 3)');
  });
  it('the installed values 1 are read back from the script', () => {
    const s = idleSuspendScript({ minutes: 1, rdpMinutes: 1, sshMinutes: 1, wakeGraceMinutes: 5, root: '', configDir: '/home/alice/.config/machine', tools: { date: '/usr/bin/date', ss: '/usr/bin/ss', systemdInhibit: '/usr/bin/systemd-inhibit', logger: '/usr/bin/logger', systemctl: '/usr/bin/systemctl', loginctl: '/usr/bin/loginctl', runuser: '/usr/sbin/runuser', xprintidle: '/usr/bin/xprintidle' } });
    expect(idleSuspendInstalledMinutes(s)).toBe(1);
    expect(idleSuspendInstalledRdpMinutes(s)).toBe(1);
  });
});

// Decision 111 (corrected 2026-11-24): EVERY ssh connection is tested. A pts login is activity while the input idle time of its tty is below S (--ssh-minutes,
// default 20), its traffic is ignored. A notty login (scp, rsync, `ssh host cmd`, the Herdr stream) is activity when the average rate of its TCP connection
// between two checks is at or above IDLE_SSH_NOTTY_BYTES_PER_SECOND; an unknown rate is activity (fail closed). The machine peer port stays unconditional.
describe('idleDecision: ssh connected (decision 111): pts input idle time against S, notty rate against the threshold', () => {
  const ssh = { rdp: 0, ssh: 1, peer: 0 };
  const P = '[::ffff:10.0.0.9]:40000';
  const Q = '[::ffff:10.0.0.10]:40001';
  const tty = (t: string, idleSeconds: number, peer = P): IdleSshConnection => ({ peer, kind: 'pts', tty: t, idleSeconds });
  const notty = (rate: number | { unknown: string }, peer = P): IdleSshConnection => ({ peer, kind: 'notty', rate });
  const withSsh = (sshConnections: IdleFacts['sshConnections'], over: Partial<IdleFacts> = {}, elapsedMin = 40): IdleFacts => idle({ connections: ssh, sshConnections, ...over }, elapsedMin);
  const decide = (f: IdleFacts, s = 20): ReturnType<typeof idleDecision> => idleDecision(f, NOW, MIN, 20, s);
  const quiet = (peer: string, rate: number): string => ` (ssh connection ${peer} quiet: ${rate} B/s, under 2048)`;

  it('the threshold is 2048 B/s, one named constant', () => {
    expect(IDLE_SSH_NOTTY_BYTES_PER_SECOND).toBe(2048);
  });
  it('the default is 20 min', () => {
    expect(IDLE_SSH_DEFAULT_MINUTES).toBe(20);
    expect(idleDecision(withSsh([tty('pts/1', 20 * 60 - 1)]), NOW, MIN).reason).toBe('not idle: ssh session pts/1 active (input 19 min ago, needs 20)');
    expect(idleDecision(withSsh([tty('pts/1', 20 * 60)]), NOW, MIN).suspend).toBe(true);
  });
  it.each([1, 20, 1440])('S = %i: pts input S*60-1 s ago is activity, S*60 s ago is not (boundary)', (s) => {
    expect(decide(withSsh([tty('pts/1', s * 60 - 1)]), s)).toEqual({ suspend: false, reason: `not idle: ssh session pts/1 active (input ${s - 1} min ago, needs ${s})`, state: null });
    expect(decide(withSsh([tty('pts/1', s * 60)]), s)).toEqual({ suspend: true, reason: `suspending: idle 40 min (ssh session pts/1 idle for ${s} min, needs ${s})`, state: null });
  });
  it('input 0 s and 3 min ago: whole minutes shown', () => {
    expect(decide(withSsh([tty('pts/0', 0)])).reason).toBe('not idle: ssh session pts/0 active (input 0 min ago, needs 20)');
    expect(decide(withSsh([tty('pts/0', 180)])).reason).toBe('not idle: ssh session pts/0 active (input 3 min ago, needs 20)');
  });
  it('a pts session carries no rate: a terminal printing output is not input', () => {
    expect(decide(withSsh([tty('pts/1', 7200)]))).toEqual({ suspend: true, reason: 'suspending: idle 40 min (ssh session pts/1 idle for 120 min, needs 20)', state: null });
  });
  it('a notty connection at or above the threshold is activity, named with its peer and rate', () => {
    expect(decide(withSsh([notty(2048)]))).toEqual({ suspend: false, reason: `not idle: ssh connection ${P} active (2048 B/s, needs 2048)`, state: null });
    expect(decide(withSsh([notty(5_000_000)])).reason).toBe(`not idle: ssh connection ${P} active (5000000 B/s, needs 2048)`);
  });
  it('a notty connection under the threshold (the Herdr baseline) is quiet: the box can suspend, the line says so', () => {
    expect(decide(withSsh([notty(2047)]))).toEqual({ suspend: true, reason: `suspending: idle 40 min${quiet(P, 2047)}`, state: null });
    expect(decide(withSsh([notty(200)], {}, 12)).reason).toBe(`idle 12/30 min${quiet(P, 200)}`);
    expect(decide(withSsh([notty(0)], { state: 'absent' })).reason).toBe(`idle 0/30 min${quiet(P, 0)}`);
  });
  it('an unknown rate (first sight, stale or unusable sample, counter reset) is activity with the cause (fail closed)', () => {
    for (const cause of ['first check of this connection (no previous sample)', 'previous sample older than 300 s', 'byte counter went down (a new connection on the same address)', 'bytes_acked or bytes_received missing or not a number in ss -tin']) {
      expect(decide(withSsh([notty({ unknown: cause })]))).toEqual({ suspend: false, reason: `not idle: ssh connection ${P} rate unknown (${cause})`, state: null });
    }
  });
  it('a notty connection above the threshold plus an idle pts session: the notty connection blocks', () => {
    expect(decide(withSsh([tty('pts/3', 7200, Q), notty(9000)])).reason).toBe(`not idle: ssh connection ${P} active (9000 B/s, needs 2048)`);
  });
  it('a fresh pts session wins over a notty connection (pts first), whatever the order', () => {
    expect(decide(withSsh([notty(9000), tty('pts/3', 60, Q)])).reason).toBe('not idle: ssh session pts/3 active (input 1 min ago, needs 20)');
  });
  it('two notty connections, one quiet one busy: the busy one blocks', () => {
    expect(decide(withSsh([notty(200), notty(4096, Q)])).reason).toBe(`not idle: ssh connection ${Q} active (4096 B/s, needs 2048)`);
    expect(decide(withSsh([notty(4096), notty(200, Q)])).reason).toBe(`not idle: ssh connection ${P} active (4096 B/s, needs 2048)`);
  });
  it('a quiet connection and an unknown one: the unknown one blocks', () => {
    expect(decide(withSsh([notty(200), notty({ unknown: 'x' }, Q)])).reason).toBe(`not idle: ssh connection ${Q} rate unknown (x)`);
  });
  it('several pts sessions: the most recent input counts and names its tty (the first on a tie)', () => {
    expect(decide(withSsh([tty('pts/0', 7200), tty('pts/2', 90), tty('pts/4', 3600)])).reason).toBe('not idle: ssh session pts/2 active (input 1 min ago, needs 20)');
    expect(decide(withSsh([tty('pts/5', 90), tty('pts/2', 90)])).reason).toBe('not idle: ssh session pts/5 active (input 1 min ago, needs 20)');
    expect(decide(withSsh([tty('pts/0', 7200), tty('pts/2', 2400)])).reason).toBe('suspending: idle 40 min (ssh session pts/2 idle for 40 min, needs 20)');
  });
  it('unreadable (mapping failure, stat failure, ss failure): activity with the cause (fail closed)', () => {
    expect(decide(withSsh({ unreadable: 'cannot read the idle time of pts/1' }))).toEqual({ suspend: false, reason: 'not idle: ssh connected (cannot read the ssh state: cannot read the idle time of pts/1)', state: null });
  });
  it('the notes are on the timer lines: pts first, then every quiet connection, after the input note and the ignored displays', () => {
    const note = ' (ssh session pts/1 idle for 25 min, needs 20)';
    const t = [tty('pts/1', 25 * 60)];
    expect(decide(withSsh(t, { state: 'absent' })).reason).toBe(`idle 0/30 min${note}`);
    expect(decide(withSsh(t, {}, 12)).reason).toBe(`idle 12/30 min${note}`);
    expect(decide(withSsh(t, { connections: { rdp: 1, ssh: 1, peer: 0 }, inputIdleSeconds: 3600 })).reason).toBe(`suspending: rdp connected but no input for 60 min (needs 20)${note}`);
    expect(decide(withSsh(t, { connections: { rdp: 1, ssh: 1, peer: 0 }, inputIdleSeconds: 3600, state: 'absent' })).reason).toBe(`idle: rdp connected but no input for 60 min (needs 20), confirming at the next check${note}`);
    expect(decide(withSsh(t, { inputIdleSeconds: 'missing' }, 12)).reason).toBe(`idle 12/30 min (input idleness not checked: xprintidle is not installed)${note}`);
    expect(decide(withSsh(t, { ignoredDisplays: [0], inputIdleSeconds: 99999 }, 12)).reason).toBe(`idle 12/30 min (ignored display :0: no user session)${note}`);
    expect(decide(withSsh([...t, notty(190, Q), notty(230)], {}, 12)).reason).toBe(`idle 12/30 min${note}${quiet(Q, 190)}${quiet(P, 230)}`);
  });
  it('no ssh connection: the fact is not read (unreadable or busy, no note)', () => {
    expect(idleDecision(idle({ sshConnections: { unreadable: 'x' } }, 12), NOW, MIN).reason).toBe('idle 12/30 min');
    expect(idleDecision(idle({ sshConnections: [notty(99999)] }, 12), NOW, MIN).reason).toBe('idle 12/30 min');
  });
  it('a peer connection stays unconditional even with a quiet or idle ssh connection', () => {
    expect(decide(withSsh([tty('pts/1', 99999)], { connections: { rdp: 0, ssh: 1, peer: 1 } })).reason).toBe('not idle: machine peer connected');
    expect(decide(withSsh([notty(1)], { connections: { rdp: 0, ssh: 1, peer: 1 } })).reason).toBe('not idle: machine peer connected');
  });
  it('the machine request rule stays unconditional: a request in the last N min blocks despite a quiet ssh connection', () => {
    expect(decide(withSsh([notty(1)], { audit: { lastActivityEpoch: NOW - 60, openHolds: 0 } })).reason).toBe('not idle: machine request in the last 30 min');
  });
  it('a quiet ssh connection does not bypass the other checks (load, inhibitor): the limit of a slow notty job is the load and the inhibitors', () => {
    expect(decide(withSsh([notty(1)], { load5Hundredths: 99 })).reason).toBe('not idle: load 0.99 (limit 0.30)');
    expect(decide(withSsh([notty(1)], { inhibitors: 1 })).reason).toBe('not idle: sleep inhibitor held (block)');
  });
  it('a non-integer or negative idle time or rate and an out-of-range S are refused loudly', () => {
    for (const bad of [-1, 1.5, NaN]) expect(() => decide(withSsh([tty('pts/1', bad)])), String(bad)).toThrow(InstallError);
    for (const bad of [-1, 1.5, NaN]) expect(() => decide(withSsh([notty(bad)])), String(bad)).toThrow(InstallError);
    for (const s of [0, 1441, 2.5, NaN]) expect(() => decide(withSsh([tty('pts/1', 60)]), s), String(s)).toThrow(/minutes/);
  });
  it('the script reads the per-connection counters of ss, the process titles and the file of samples (not the traffic fields of decision 109)', () => {
    const tools = { date: '/usr/bin/date', ss: '/usr/bin/ss', systemdInhibit: '/usr/bin/systemd-inhibit', logger: '/usr/bin/logger', systemctl: '/usr/bin/systemctl', loginctl: '/usr/bin/loginctl', runuser: '/usr/sbin/runuser', xprintidle: '/usr/bin/xprintidle' };
    const s = idleSuspendScript({ minutes: 30, rdpMinutes: 20, sshMinutes: 20, wakeGraceMinutes: 5, root: '', configDir: '/home/alice/.config/machine', tools });
    expect(s).not.toMatch(/lastsnd|lastrcv/);
    expect(s).toContain('-Htinp state established');
    expect(s).toContain('bytes_acked');
    expect(s).toContain('bytes_received');
    expect(s).toContain('THRESHOLD=2048');
    expect(s).toContain('/run/machine-idle-suspend/ssh-samples');
    expect(s).toContain('stat -c %X');
    // The title of each pid of the Process column of ss; /dev/pts is never listed (a stale pts has no sshd process).
    expect(s).toContain('/proc/$c_pid/cmdline');
    expect(s).not.toMatch(/\/dev\/pts\/\*|ls[^\n]*\/dev\/pts/);
  });
});

describe('parseIdleSshMinutes (--ssh-minutes) and the script (decision 111)', () => {
  it('accepts whole numbers 1 to 1440 only, the error names the flag, range and default', () => {
    expect(parseIdleSshMinutes('1')).toBe(1);
    expect(parseIdleSshMinutes('1440')).toBe(1440);
    for (const bad of ['0', '1441', '', ' 20', '20m', '2e1', '-5']) expect(() => parseIdleSshMinutes(bad), bad).toThrow(/--ssh-minutes must be a whole number of minutes from 1 to 1440 \(default 20\)/);
    expect(() => parseIdleSshMinutes('0')).toThrow('for example `machine install idle-suspend --ssh-minutes 20`');
  });
  it('SSH_MINUTES=<n> is in the script, read back, undefined for an older script', () => {
    const tools = { date: '/usr/bin/date', ss: '/usr/bin/ss', systemdInhibit: '/usr/bin/systemd-inhibit', logger: '/usr/bin/logger', systemctl: '/usr/bin/systemctl', loginctl: '/usr/bin/loginctl', runuser: '/usr/sbin/runuser', xprintidle: '/usr/bin/xprintidle' };
    const mk = (sshMinutes: number): string => idleSuspendScript({ minutes: 30, rdpMinutes: 20, sshMinutes, wakeGraceMinutes: 5, root: '', configDir: '/home/alice/.config/machine', tools });
    expect(mk(20)).toMatch(/^SSH_MINUTES=20$/m);
    expect(idleSuspendInstalledSshMinutes(mk(45))).toBe(45);
    expect(idleSuspendInstalledSshMinutes('#!/bin/sh\nMINUTES=30\n')).toBeUndefined();
    expect(idleSuspendInstalledSshMinutes('SSH_MINUTES=9999\n')).toBeUndefined();
    for (const bad of [0, 1441, 20.5, NaN]) expect(() => mk(bad), String(bad)).toThrow(InstallError);
  });
});

// ---------------------------------------------------------------- decision 113: cadence, grace after a resume

const TOOLS = { date: '/usr/bin/date', ss: '/usr/bin/ss', systemdInhibit: '/usr/bin/systemd-inhibit', logger: '/usr/bin/logger', systemctl: '/usr/bin/systemctl', loginctl: '/usr/bin/loginctl', runuser: '/usr/sbin/runuser', xprintidle: '/usr/bin/xprintidle' };

describe('idleCadenceSeconds (decision 113): from the SMALLEST of --minutes, --rdp-minutes, --ssh-minutes', () => {
  // [minutes, rdp, ssh, seconds]: below 10 min: 30 s; 10 to 30 inclusive: 1 min; above 30: 2 min.
  const table: Array<[number, number, number, number]> = [
    [1, 1, 1, 30],
    [9, 9, 9, 30],
    [10, 10, 10, 60],
    [30, 30, 30, 60],
    [31, 31, 31, 120],
    [1440, 1440, 1440, 120],
    [30, 20, 20, 60],
    [9, 7, 20, 30],
    [45, 20, 20, 60],
    [60, 45, 40, 120],
    [9, 45, 45, 30],
    [45, 9, 45, 30],
    [45, 45, 9, 30],
    [31, 30, 45, 60],
    [31, 31, 30, 60],
    [31, 45, 31, 120],
  ];
  it.each(table)('minutes %i, rdp %i, ssh %i: every %i s', (minutes, rdp, ssh, seconds) => {
    expect(idleCadenceSeconds(minutes, rdp, ssh)).toBe(seconds);
  });
  it('the boundaries 9, 10, 30 and 31: the smallest one decides', () => {
    expect(idleCadenceSeconds(9, 60, 60)).toBe(30);
    expect(idleCadenceSeconds(10, 60, 60)).toBe(60);
    expect(idleCadenceSeconds(30, 60, 60)).toBe(60);
    expect(idleCadenceSeconds(31, 60, 60)).toBe(120);
  });
  it('refuses a value out of range or not whole, loudly', () => {
    for (const bad of [0, 1441, 2.5, NaN, -1]) {
      expect(() => idleCadenceSeconds(bad, 20, 20), String(bad)).toThrow(InstallError);
      expect(() => idleCadenceSeconds(20, bad, 20), String(bad)).toThrow(InstallError);
      expect(() => idleCadenceSeconds(20, 20, bad), String(bad)).toThrow(InstallError);
    }
  });
});

describe('idleGapSeconds (decision 113): a gap above max(300 s, 10 x cadence) restarts the confirmation', () => {
  it('300 s at 30 s, 600 s at 1 min, 1200 s at 2 min; the floor stays IDLE_GAP_SECONDS', () => {
    expect(IDLE_GAP_SECONDS).toBe(300);
    expect(idleGapSeconds(30)).toBe(300);
    expect(idleGapSeconds(60)).toBe(600);
    expect(idleGapSeconds(120)).toBe(1200);
  });
  it('refuses a cadence that is not one of the three', () => {
    for (const bad of [0, 29, 45, 121, NaN]) expect(() => idleGapSeconds(bad), String(bad)).toThrow(InstallError);
  });
});

describe('parseIdleWakeGraceMinutes (--wake-grace-minutes)', () => {
  it('accepts whole numbers 1 to 60 only, the error names the flag, the range, the default and the fix', () => {
    expect([IDLE_WAKE_GRACE_MIN_MINUTES, IDLE_WAKE_GRACE_MAX_MINUTES, IDLE_WAKE_GRACE_DEFAULT_MINUTES]).toEqual([1, 60, 5]);
    expect(parseIdleWakeGraceMinutes('1')).toBe(1);
    expect(parseIdleWakeGraceMinutes('5')).toBe(5);
    expect(parseIdleWakeGraceMinutes('60')).toBe(60);
    for (const bad of ['0', '61', '', ' 5', '5m', '2.5', '2e1', '-5', 'abc', '007']) {
      expect(() => parseIdleWakeGraceMinutes(bad), bad).toThrow(/--wake-grace-minutes must be a whole number of minutes from 1 to 60 \(default 5\)/);
    }
    expect(() => parseIdleWakeGraceMinutes('0')).toThrow('for example `machine install idle-suspend --wake-grace-minutes 5`');
  });
});

describe('idleResume (decision 113): the kernel counter of /sys/power/suspend_stats/success tells a resume', () => {
  const G = 5;
  const counter = (c: number, seenAt: number): IdleResumeFacts['stored'] => ({ kind: 'counter', counter: c, seenAt });
  const unreadableRecord = (seenAt: number): IdleResumeFacts['stored'] => ({ kind: 'unreadable', seenAt });
  const CAUSE = 'cannot read /sys/power/suspend_stats/success (missing or unreadable)';

  it('the counter did not move: the record is kept and the grace is over', () => {
    expect(idleResume({ counter: 40, stored: counter(40, NOW - 3600) }, NOW, G)).toEqual({ record: counter(40, NOW - 3600), graceLeftSeconds: 0, note: '' });
  });
  it('a counter greater than the stored one is a resume NOW: the grace starts at this pass', () => {
    expect(idleResume({ counter: 41, stored: counter(40, NOW - 3600) }, NOW, G)).toEqual({ record: counter(41, NOW), graceLeftSeconds: 300, note: '' });
  });
  it('two suspends between two passes (37 to 39): one grace, from this pass', () => {
    expect(idleResume({ counter: 39, stored: counter(37, NOW - 3600) }, NOW, G)).toEqual({ record: counter(39, NOW), graceLeftSeconds: 300, note: '' });
  });
  it('no stored record (first pass, or a reboot cleared /run): a resume now', () => {
    expect(idleResume({ counter: 40, stored: 'absent' }, NOW, G)).toEqual({ record: counter(40, NOW), graceLeftSeconds: 300, note: '' });
  });
  it('an unusable stored record: a resume now', () => {
    expect(idleResume({ counter: 40, stored: null }, NOW, G)).toEqual({ record: counter(40, NOW), graceLeftSeconds: 300, note: '' });
  });
  it('a counter LOWER than the stored one (reset, replaced file): treated as a resume, never ignored', () => {
    expect(idleResume({ counter: 3, stored: counter(40, NOW - 3600) }, NOW, G)).toEqual({ record: counter(3, NOW), graceLeftSeconds: 300, note: '' });
  });
  it('the grace counts from the first pass that saw the new value, whole seconds, ends exactly at G minutes', () => {
    const left = (ago: number): number => idleResume({ counter: 41, stored: counter(41, NOW - ago) }, NOW, G).graceLeftSeconds;
    expect(left(0)).toBe(300);
    expect(left(100)).toBe(200);
    expect(left(299)).toBe(1);
    expect(left(300)).toBe(0);
    expect(left(301)).toBe(0);
  });
  it('G follows the parameter (1 and 60)', () => {
    expect(idleResume({ counter: 41, stored: counter(40, NOW - 3600) }, NOW, 1).graceLeftSeconds).toBe(60);
    expect(idleResume({ counter: 41, stored: counter(40, NOW - 3600) }, NOW, 60).graceLeftSeconds).toBe(3600);
  });
  it('a record from the future (the clock went back): the grace restarts from now, bounded by G', () => {
    expect(idleResume({ counter: 41, stored: counter(41, NOW + 7200) }, NOW, G)).toEqual({ record: counter(41, NOW), graceLeftSeconds: 300, note: '' });
    expect(idleResume({ counter: { unreadable: CAUSE }, stored: unreadableRecord(NOW + 7200) }, NOW, G).record).toEqual(unreadableRecord(NOW));
  });
  it('an unreadable counter with no usable record: a resume now (fail closed), the cause is said on the line', () => {
    const r = idleResume({ counter: { unreadable: CAUSE }, stored: 'absent' }, NOW, G);
    expect(r).toEqual({ record: unreadableRecord(NOW), graceLeftSeconds: 300, note: ` (resume detection off: ${CAUSE})` });
  });
  it('an unreadable counter that stays unreadable does NOT restart the grace on every pass: the first pass starts it, the next ones keep its start', () => {
    const r = (ago: number): ReturnType<typeof idleResume> => idleResume({ counter: { unreadable: CAUSE }, stored: unreadableRecord(NOW - ago) }, NOW, G);
    expect(r(30).record).toEqual(unreadableRecord(NOW - 30));
    expect(r(30).graceLeftSeconds).toBe(270);
    expect(r(299).graceLeftSeconds).toBe(1);
  });
  it('after G minutes a permanently unreadable counter no longer blocks, and the cause is still on EVERY pass', () => {
    const r = idleResume({ counter: { unreadable: CAUSE }, stored: unreadableRecord(NOW - 300) }, NOW, G);
    expect(r.graceLeftSeconds).toBe(0);
    expect(r.note).toBe(` (resume detection off: ${CAUSE})`);
    expect(idleResume({ counter: { unreadable: CAUSE }, stored: unreadableRecord(NOW - 86400) }, NOW, G).graceLeftSeconds).toBe(0);
  });
  it('a counter that was readable and no longer is: one new grace (a resume cannot be excluded), then the same bound', () => {
    expect(idleResume({ counter: { unreadable: CAUSE }, stored: counter(40, NOW - 3600) }, NOW, G)).toEqual({ record: unreadableRecord(NOW), graceLeftSeconds: 300, note: ` (resume detection off: ${CAUSE})` });
  });
  it('a counter readable again after an unreadable record: adopted as the baseline, NO new grace (the window of the unreadable record is kept)', () => {
    expect(idleResume({ counter: 40, stored: unreadableRecord(NOW - 400) }, NOW, G)).toEqual({ record: counter(40, NOW - 400), graceLeftSeconds: 0, note: '' });
    expect(idleResume({ counter: 40, stored: unreadableRecord(NOW - 100) }, NOW, G)).toEqual({ record: counter(40, NOW - 100), graceLeftSeconds: 200, note: '' });
  });
  it('refuses a counter that is not a whole number, and a grace out of range, as a programming error', () => {
    for (const bad of [-1, 1.5, NaN]) expect(() => idleResume({ counter: bad, stored: 'absent' }, NOW, G), String(bad)).toThrow(InstallError);
    for (const bad of [0, 61, 2.5, NaN]) expect(() => idleResume({ counter: 1, stored: 'absent' }, NOW, bad), String(bad)).toThrow(/wake grace/);
  });
  it('the counter file is the one of the kernel', () => {
    expect(IDLE_RESUME_COUNTER_FILE).toBe('/sys/power/suspend_stats/success');
  });
});

describe('idleDecision (decision 113): no automatic suspend during the wake grace', () => {
  const resumedNow: IdleResumeFacts = { counter: 41, stored: { kind: 'counter', counter: 40, seenAt: NOW - 3600 } };
  const inGrace = (ago: number): IdleResumeFacts => ({ counter: 41, stored: { kind: 'counter', counter: 41, seenAt: NOW - ago } });
  const longIdle = (over: Partial<IdleFacts> = {}): IdleFacts => idle(over, 600);

  it('a resume detected at this pass: not idle, wake grace (5 min left), the timer state is cleared, even when every reading says idle for hours', () => {
    expect(idleDecision(longIdle({ resume: resumedNow }), NOW, MIN)).toEqual({ suspend: false, reason: 'not idle: wake grace (5 min left)', state: null });
  });
  it('the minutes left are rounded UP: 299 s left is 5 min, 60 s left is 1 min', () => {
    const left = (ago: number): string => idleDecision(longIdle({ resume: inGrace(ago) }), NOW, MIN).reason;
    expect(left(1)).toBe('not idle: wake grace (5 min left)');
    expect(left(60)).toBe('not idle: wake grace (4 min left)');
    expect(left(240)).toBe('not idle: wake grace (1 min left)');
    expect(left(299)).toBe('not idle: wake grace (1 min left)');
  });
  it('the grace ends at exactly G minutes; the pass after it only restarts the confirmation (the grace cleared the state)', () => {
    const over = longIdle({ resume: inGrace(300), state: 'absent' });
    expect(idleDecision(over, NOW, MIN)).toEqual({ suspend: false, reason: 'idle 0/30 min', state: { since: NOW, last: NOW } });
  });
  it('in RDP mode: input idle for hours, a fresh state, still no suspend inside the grace; right after it the confirmation restarts, then it suspends', () => {
    const rdpFacts = (resume: IdleResumeFacts, state: IdleFacts['state']): IdleFacts => idle({ connections: { rdp: 1, ssh: 0, peer: 0 }, inputIdleSeconds: 3 * 3600, resume, state });
    const fresh = { since: NOW - 30, last: NOW - 30 };
    expect(idleDecision(rdpFacts(inGrace(100), fresh), NOW, MIN)).toEqual({ suspend: false, reason: 'not idle: wake grace (4 min left)', state: null });
    const first = idleDecision(rdpFacts(inGrace(300), 'absent'), NOW, MIN);
    expect(first.reason).toBe('idle: rdp connected but no input for 180 min (needs 20), confirming at the next check');
    expect(first.suspend).toBe(false);
    expect(idleDecision(rdpFacts(inGrace(330), first.state), NOW + 30, MIN).suspend).toBe(true);
  });
  it('the grace only restricts: an earlier failing check keeps its own reason (load, input, inhibitor, keep-awake)', () => {
    expect(idleDecision(longIdle({ resume: resumedNow, load5Hundredths: 99 }), NOW, MIN).reason).toBe('not idle: load 0.99 (limit 0.30)');
    expect(idleDecision(longIdle({ resume: resumedNow, inhibitors: 1 }), NOW, MIN).reason).toBe('not idle: sleep inhibitor held (block)');
    expect(idleDecision(longIdle({ resume: resumedNow, inputIdleSeconds: 60 }), NOW, MIN).reason).toBe('not idle: input 1 min ago (needs 30)');
    expect(idleDecision(longIdle({ resume: resumedNow, keepAwake: null }), NOW, MIN).reason).toBe('not idle: cannot read the keep-awake files');
  });
  it('--wake-grace-minutes is the sixth parameter; 1 and 60 are the bounds, anything else is refused', () => {
    expect(idleDecision(longIdle({ resume: resumedNow }), NOW, MIN, 20, 20, 1).reason).toBe('not idle: wake grace (1 min left)');
    expect(idleDecision(longIdle({ resume: resumedNow }), NOW, MIN, 20, 20, 60).reason).toBe('not idle: wake grace (60 min left)');
    for (const bad of [0, 61, 2.5, NaN]) expect(() => idleDecision(longIdle(), NOW, MIN, 20, 20, bad), String(bad)).toThrow(/wake grace/);
  });
  it('the counter is unreadable at the first pass: the grace applies once, and the line says why', () => {
    const cause = 'cannot read /sys/power/suspend_stats/success (missing or unreadable)';
    const d = idleDecision(longIdle({ resume: { counter: { unreadable: cause }, stored: 'absent' } }), NOW, MIN);
    expect(d).toEqual({ suspend: false, reason: `not idle: wake grace (5 min left) (resume detection off: ${cause})`, state: null });
  });
  it('a counter that stays unreadable never blocks for ever: after the grace the suspend works and EVERY line (not idle, idle, suspending) names the cause', () => {
    const cause = 'cannot read /sys/power/suspend_stats/success (missing or unreadable)';
    const resume: IdleResumeFacts = { counter: { unreadable: cause }, stored: { kind: 'unreadable', seenAt: NOW - 3600 } };
    const note = ` (resume detection off: ${cause})`;
    expect(idleDecision(longIdle({ resume }), NOW, MIN)).toEqual({ suspend: true, reason: `suspending: idle 600 min${note}`, state: null });
    expect(idleDecision(idle({ resume }, 12), NOW, MIN).reason).toBe(`idle 12/30 min${note}`);
    expect(idleDecision(idle({ resume, load5Hundredths: 99 }, 12), NOW, MIN).reason).toBe(`not idle: load 0.99 (limit 0.30)${note}`);
  });
  it('a quiet counter leaves every other line untouched (no note, no grace)', () => {
    expect(idleDecision(longIdle(), NOW, MIN)).toEqual({ suspend: true, reason: 'suspending: idle 600 min', state: null });
  });
});

describe('the cadence changes nothing but the delay (decision 113): the same behaviour at 30 s, 1 min and 2 min', () => {
  // [minutes, rdp, ssh, cadence]: one triple per cadence, plus triples whose cadence comes from another option than the one in use.
  const triples: Array<[number, number, number, number]> = [
    [9, 9, 9, 30],
    [20, 9, 45, 30],
    [15, 15, 15, 60],
    [45, 20, 20, 60],
    [45, 45, 45, 120],
    [60, 45, 40, 120],
    [33, 31, 35, 120],
  ];
  const PHASES = [0, 1, 7, 15, 29];

  /** Runs idleDecision on every pass of the timer (`phase` seconds after the last input, then every cadence) until it suspends; the delay since the last input. */
  function firstSuspend(minutes: number, rdp: number, ssh: number, rdpConnected: boolean, phase: number): { delay: number; reasons: string[] } {
    const cadence = idleCadenceSeconds(minutes, rdp, ssh);
    const lastInput = NOW;
    let state: IdleFacts['state'] = 'absent';
    const reasons: string[] = [];
    for (let k = -3; k < 100000; k += 1) {
      const t = lastInput + phase + k * cadence;
      const input = Math.max(0, t - lastInput);
      const d = idleDecision(idle({ connections: { rdp: rdpConnected ? 1 : 0, ssh: 0, peer: 0 }, inputIdleSeconds: input, state, audit: { lastActivityEpoch: NOW - 10 * 86400, openHolds: 0 } }), t, minutes, rdp, ssh);
      reasons.push(d.reason);
      if (d.suspend) {
        return { delay: t - lastInput, reasons };
      }
      state = d.state === null ? 'absent' : d.state;
    }
    throw new Error('never suspended');
  }

  describe.each(triples)('minutes %i, rdp %i, ssh %i: every %i s', (minutes, rdp, ssh, cadence) => {
    it('RDP connected: suspends N+cadence to N+2 x cadence after the last input (N = --rdp-minutes), whatever the phase of the timer', () => {
      expect(idleCadenceSeconds(minutes, rdp, ssh)).toBe(cadence);
      for (const phase of PHASES) {
        const { delay, reasons } = firstSuspend(minutes, rdp, ssh, true, phase % cadence);
        expect(delay, `phase ${phase}`).toBeGreaterThanOrEqual(rdp * 60 + cadence);
        expect(delay, `phase ${phase}`).toBeLessThan(rdp * 60 + 2 * cadence);
        expect(reasons.filter((r) => r.startsWith('idle: rdp connected')), 'one confirming pass, then the suspend').toHaveLength(1);
        const range = idleSuspendDelaySeconds(minutes, rdp, ssh, true);
        expect(delay).toBeGreaterThanOrEqual(range.fromSeconds);
        expect(delay).toBeLessThan(range.toSeconds);
      }
    });
    it('no RDP connection: the input must be N min old, then the N-minute timer (about 2N), the same range at every phase', () => {
      for (const phase of PHASES) {
        const { delay } = firstSuspend(minutes, rdp, ssh, false, phase % cadence);
        const range = idleSuspendDelaySeconds(minutes, rdp, ssh, false);
        expect(delay, `phase ${phase}`).toBeGreaterThanOrEqual(range.fromSeconds);
        expect(delay, `phase ${phase}`).toBeLessThan(range.toSeconds);
        expect(delay).toBeGreaterThanOrEqual(2 * minutes * 60);
      }
    });
    it('the N-minute timer is counted in TIME, not in passes: the whole minutes shown are the same at any cadence', () => {
      const state = { since: NOW - 12 * 60, last: NOW - cadence };
      expect(idleDecision(idle({ state }), NOW, minutes, rdp, ssh).reason).toBe(minutes <= 12 ? 'suspending: idle 12 min' : `idle 12/${minutes} min`);
    });
    it('one missed pass (2 x cadence since the last one) is the same run; a gap above max(300 s, 10 x cadence) restarts the confirmation', () => {
      const gap = idleGapSeconds(cadence);
      expect(gap).toBe(Math.max(300, 10 * cadence));
      const rdpFacts = (last: number): IdleFacts => idle({ connections: { rdp: 1, ssh: 0, peer: 0 }, inputIdleSeconds: 99999, state: { since: NOW - 7200, last } });
      expect(idleDecision(rdpFacts(NOW - 2 * cadence), NOW, minutes, rdp, ssh).suspend).toBe(true);
      expect(idleDecision(rdpFacts(NOW - gap), NOW, minutes, rdp, ssh).suspend).toBe(true);
      const late = idleDecision(rdpFacts(NOW - gap - 1), NOW, minutes, rdp, ssh);
      expect(late.suspend).toBe(false);
      expect(late.reason).toContain(`(timer restarted: no check for more than ${gap / 60} min, the box slept or was off)`);
    });
  });

  it('idleSuspendDelaySeconds: the exact ranges of the table of the spec', () => {
    // RDP: [R + c, R + 2c). No RDP: [N + ceil(N*60/c)*c, ... + c).
    expect(idleSuspendDelaySeconds(30, 20, 20, true)).toEqual({ fromSeconds: 20 * 60 + 60, toSeconds: 20 * 60 + 120 });
    expect(idleSuspendDelaySeconds(9, 9, 9, true)).toEqual({ fromSeconds: 9 * 60 + 30, toSeconds: 9 * 60 + 60 });
    expect(idleSuspendDelaySeconds(60, 45, 40, true)).toEqual({ fromSeconds: 45 * 60 + 120, toSeconds: 45 * 60 + 240 });
    expect(idleSuspendDelaySeconds(9, 9, 9, false)).toEqual({ fromSeconds: 18 * 60, toSeconds: 18 * 60 + 30 });
    expect(idleSuspendDelaySeconds(30, 20, 20, false)).toEqual({ fromSeconds: 60 * 60, toSeconds: 60 * 60 + 60 });
    // Cadence 2 min and an odd N: the timer needs the next pass of an even number of minutes.
    expect(idleSuspendDelaySeconds(45, 45, 45, false)).toEqual({ fromSeconds: 91 * 60, toSeconds: 91 * 60 + 120 });
    expect(idleSuspendDelaySeconds(60, 45, 40, false)).toEqual({ fromSeconds: 120 * 60, toSeconds: 120 * 60 + 120 });
  });
});

describe('the units (decision 113): the cadence is part of the timer text', () => {
  it('OnUnitActiveSec follows the cadence, AccuracySec=1s keeps systemd from coalescing the 30 s timer, the boot delay stays 2 min', () => {
    expect(idleSuspendTimerUnit(30)).toContain('OnUnitActiveSec=30s');
    expect(idleSuspendTimerUnit(60)).toContain('OnUnitActiveSec=1min');
    expect(idleSuspendTimerUnit(120)).toContain('OnUnitActiveSec=2min');
    for (const c of [30, 60, 120]) {
      const text = idleSuspendTimerUnit(c);
      expect(text).toContain('AccuracySec=1s');
      expect(text).toContain('OnBootSec=2min');
      expect(text).toContain('WantedBy=timers.target');
      expect(text).not.toContain('AccuracySec=10s');
    }
    expect(idleSuspendTimerUnit(30)).toContain('check every 30 s');
    expect(idleSuspendTimerUnit(60)).toContain('check every 1 min');
    expect(idleSuspendTimerUnit(120)).toContain('check every 2 min');
    expect(idleSuspendTimerUnit(30)).not.toBe(idleSuspendTimerUnit(60));
    expect(() => idleSuspendTimerUnit(45)).toThrow(InstallError);
  });
  it('the service has an explicit TimeoutStartSec under the shortest cadence (a hung pass cannot block the next ones)', () => {
    const text = idleSuspendServiceUnit();
    expect(text).toMatch(/^TimeoutStartSec=25$/m);
    expect(text).toContain('Type=oneshot');
  });
  it('the installed cadence is read back from the timer text, undefined when it cannot be', () => {
    for (const c of [30, 60, 120] as const) expect(idleSuspendInstalledCadenceSeconds(idleSuspendTimerUnit(c))).toBe(c);
    expect(idleSuspendInstalledCadenceSeconds('[Timer]\nOnUnitActiveSec=2min\n')).toBe(120);
    expect(idleSuspendInstalledCadenceSeconds('[Timer]\nOnBootSec=2min\n')).toBeUndefined();
    expect(idleSuspendInstalledCadenceSeconds('[Timer]\nOnUnitActiveSec=7h\n')).toBeUndefined();
    expect(idleSuspendInstalledCadenceSeconds('')).toBeUndefined();
  });
});

describe('the script (decision 113): version 8, the wake grace and the gap in its text', () => {
  const mk = (over: Partial<Parameters<typeof idleSuspendScript>[0]> = {}): string => idleSuspendScript({ minutes: 30, rdpMinutes: 20, sshMinutes: 20, wakeGraceMinutes: 5, root: '', configDir: '/home/alice/.config/machine', tools: TOOLS, ...over });
  it('the marker says version 8, WAKE_GRACE_MINUTES=<n> is read back (undefined for an older script)', () => {
    expect(mk()).toContain('# managed by machine install idle-suspend, version 8');
    expect(mk()).toMatch(/^WAKE_GRACE_MINUTES=5$/m);
    expect(idleSuspendInstalledWakeGraceMinutes(mk({ wakeGraceMinutes: 45 }))).toBe(45);
    expect(idleSuspendInstalledWakeGraceMinutes('#!/bin/sh\nMINUTES=30\n')).toBeUndefined();
    expect(idleSuspendInstalledWakeGraceMinutes('WAKE_GRACE_MINUTES=99\n')).toBeUndefined();
    for (const bad of [0, 61, 2.5, NaN]) expect(() => mk({ wakeGraceMinutes: bad }), String(bad)).toThrow(InstallError);
  });
  it('the script has no sleep, reads the kernel counter and keeps its record next to the timer state', () => {
    const s = mk();
    expect(s).not.toMatch(/(^|[^A-Za-z_-])sleep [0-9]/m);
    expect(s).toContain('/sys/power/suspend_stats/success');
    expect(s).toContain('/run/machine-idle-suspend/resume');
    expect(s).toContain('wake grace');
  });
  it('the gap of the state is the one of the cadence (300 s, 600 s, 1200 s), written as a validated integer', () => {
    expect(mk({ minutes: 9, rdpMinutes: 9, sshMinutes: 9 })).toMatch(/^GAP_SECONDS=300$/m);
    expect(mk()).toMatch(/^GAP_SECONDS=600$/m);
    expect(mk({ minutes: 60, rdpMinutes: 45, sshMinutes: 40 })).toMatch(/^GAP_SECONDS=1200$/m);
  });
});
