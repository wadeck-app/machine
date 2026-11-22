import { describe, expect, it } from 'vitest';
import {
  IDLE_DEFAULT_MINUTES,
  IDLE_GAP_SECONDS,
  IDLE_MAX_MINUTES,
  IDLE_MIN_MINUTES,
  idleDecision,
  idleSuspendInstalledMinutes,
  idleSuspendScript,
  parseIdleMinutes,
  parseLoadHundredths,
  type IdleFacts,
} from './idleSuspend.js';
import { InstallError } from './install.js';

const NOW = 1_800_000_000;
const MIN = 30;

/** Everything idle, a timer that started `elapsedMin` minutes ago and was checked 2 minutes ago. */
const idle = (over: Partial<IdleFacts> = {}, elapsedMin = 12): IdleFacts => ({
  keepAwake: [{ present: false }, { present: false }],
  connections: { rdp: 0, ssh: 0, peer: 0 },
  audit: { lastActivityEpoch: NOW - 3 * 3600, openHolds: 0 },
  load5Hundredths: 5,
  inhibitors: 0,
  state: { since: NOW - elapsedMin * 60, last: NOW - 120 },
  ...over,
});

describe('idleDecision: not idle (each reason, the state is cleared)', () => {
  const notIdle: Array<[string, Partial<IdleFacts>, string]> = [
    ['an indefinite keep-awake file', { keepAwake: [{ present: true, untilEpoch: null }, { present: false }] }, 'not idle: keep-awake requested'],
    ['the second keep-awake file', { keepAwake: [{ present: false }, { present: true, untilEpoch: null }] }, 'not idle: keep-awake requested'],
    ['a keep-awake file until the future', { keepAwake: [{ present: true, untilEpoch: NOW + 1 }, { present: false }] }, 'not idle: keep-awake requested'],
    ['unreadable keep-awake files', { keepAwake: null }, 'not idle: cannot read the keep-awake files'],
    ['an RDP connection', { connections: { rdp: 1, ssh: 0, peer: 0 } }, 'not idle: rdp connected'],
    ['an SSH connection', { connections: { rdp: 0, ssh: 2, peer: 0 } }, 'not idle: ssh connected'],
    ['a machine peer connection', { connections: { rdp: 0, ssh: 0, peer: 1 } }, 'not idle: machine peer connected'],
    ['rdp and ssh together: rdp is named first', { connections: { rdp: 1, ssh: 1, peer: 1 } }, 'not idle: rdp connected'],
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
    expect(idleDecision(idle({}, 5), NOW, IDLE_MIN_MINUTES).suspend).toBe(true);
    expect(idleDecision(idle({}, 4), NOW, IDLE_MIN_MINUTES).reason).toBe('idle 4/5 min');
    const quiet = { audit: { lastActivityEpoch: NOW - 2 * 86400, openHolds: 0 } };
    expect(idleDecision(idle({ ...quiet }, 1439), NOW, IDLE_MAX_MINUTES).reason).toBe('idle 1439/1440 min');
    expect(idleDecision(idle({ ...quiet, state: { since: NOW - 1440 * 60, last: NOW - 120 } }), NOW, IDLE_MAX_MINUTES).suspend).toBe(true);
  });

  it('the last check older than the gap: the box slept or was off, the timer restarts (never suspends)', () => {
    const f = idle({ state: { since: NOW - 3 * 3600, last: NOW - IDLE_GAP_SECONDS - 1 } });
    expect(idleDecision(f, NOW, MIN)).toEqual({ suspend: false, reason: 'idle 0/30 min (timer restarted: no check for more than 5 min, the box slept or was off)', state: { since: NOW, last: NOW } });
  });

  it('a gap of exactly the limit is still the same run', () => {
    const f = idle({ state: { since: NOW - 31 * 60, last: NOW - IDLE_GAP_SECONDS } });
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
    for (const bad of [4, 1441, 0, -30, 30.5, NaN, Infinity, 1e21]) {
      expect(() => idleDecision(idle(), NOW, bad), String(bad)).toThrow(/minutes/);
    }
    for (const bad of [NaN, -1, 1.5, Infinity]) {
      expect(() => idleDecision(idle(), bad, MIN), String(bad)).toThrow(/clock/);
    }
  });
});

describe('parseIdleMinutes', () => {
  it('accepts whole numbers 5 to 1440 only', () => {
    expect(parseIdleMinutes('30')).toBe(30);
    expect(parseIdleMinutes('5')).toBe(5);
    expect(parseIdleMinutes('1440')).toBe(1440);
    for (const bad of ['4', '1441', '', ' 30', '30 ', '3e1', '0x1e', '30.0', '-30', '+30', '030', 'abc', '30; reboot']) {
      expect(() => parseIdleMinutes(bad), bad).toThrow(/--minutes/);
    }
  });
  it('the error names the range and the default', () => {
    expect(() => parseIdleMinutes('2')).toThrow(/5 to 1440/);
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
    root: '',
    configDir: '/home/alice/.config/machine',
    tools: { date: '/usr/bin/date', ss: '/usr/bin/ss', systemdInhibit: '/usr/bin/systemd-inhibit', logger: '/usr/bin/logger', systemctl: '/usr/bin/systemctl' },
  };
  const script = (o: Partial<typeof opts> = {}): string => idleSuspendScript({ ...opts, ...o });

  it('starts with the shebang, carries the marker and the minutes, ends with a newline', () => {
    const s = script();
    expect(s.split('\n')[0]).toBe('#!/bin/sh');
    expect(s.split('\n')).toContain('# managed by machine install idle-suspend, version 1');
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

  it('refuses a minutes value outside 5..1440 or not an integer', () => {
    for (const minutes of [4, 1441, 30.5, NaN]) expect(() => script({ minutes })).toThrow(InstallError);
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
});
