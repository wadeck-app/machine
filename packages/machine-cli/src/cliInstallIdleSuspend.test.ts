import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fakeInstall, type FakeInstallOptions } from './installTesting.js';
import { cli } from './testing.js';

// `machine install idle-suspend` through the command, over a fake machine (no sudo, no /etc, no systemd, no terminal).

let root: string;
let dir: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'machine-cliidle-'));
  dir = join(root, 'cfg');
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const SCRIPT = '/usr/local/bin/machine-idle-suspend';
const SERVICE = '/etc/systemd/system/machine-idle-suspend.service';
const TIMER = '/etc/systemd/system/machine-idle-suspend.timer';

/** One fake machine kept across several commands, like the real one. */
function box(o: FakeInstallOptions = {}) {
  const fake = fakeInstall(o);
  const asked: string[] = [];
  const go = async (args: string[], answer = 'y') => {
    const r = await cli(dir, ['install', ...args], undefined, {
      install: fake.env,
      ask: async (label) => {
        asked.push(label);
        return answer;
      },
    });
    return r;
  };
  const sudoCalls = (): string[] => fake.calls.filter((c) => c.startsWith('/usr/bin/sudo'));
  return { fake, go, asked, sudoCalls };
}

describe('--minutes: usage errors (exit 2), nothing run', () => {
  it.each([
    [['idle-suspend', '--minutes', '4'], /5 to 1440/],
    [['idle-suspend', '--minutes', '1441'], /5 to 1440/],
    [['idle-suspend', '--minutes', '30m'], /--minutes must be a whole number/],
    [['idle-suspend', '--minutes', '1e2'], /--minutes must be a whole number/],
    [['idle-suspend', '--minutes', '-5'], /needs a value|--minutes must be/],
    [['idle-suspend', '--minutes'], /--minutes needs a value/],
    [['idle-suspend', '--check', '--minutes', '30'], /not with --check/],
    [['idle-suspend', '--remove', '--minutes', '30'], /not with --remove/],
    [['suspend', '--minutes', '30'], /only applies to `machine install idle-suspend`/],
    [['status', '--minutes', '30'], /only applies to `machine install idle-suspend`/],
    [['--minutes', '30'], /only applies to `machine install idle-suspend`/],
  ])('%j', async (args, message) => {
    const b = box();
    const r = await b.go(args as string[]);
    expect(r.code).toBe(2);
    expect(r.err).toMatch(message as RegExp);
    expect(b.fake.calls.filter((c) => !c.startsWith('sh -c'))).toEqual([]);
  });

  it('other commands refuse --minutes too', async () => {
    const r = await cli(dir, ['status', '--minutes', '30']);
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/--minutes only applies to `machine install idle-suspend`/);
  });
});

describe('machine install idle-suspend --dry-run', () => {
  it('prints the three files, the commands and the consequence; runs no sudo, needs no terminal', async () => {
    const b = box({ tty: false });
    const r = await b.go(['idle-suspend', '--dry-run', '--minutes', '45']);
    expect(r.code, r.err).toBe(0);
    for (const p of [SCRIPT, SERVICE, TIMER]) expect(r.out).toContain(p);
    expect(r.out).toContain('| MINUTES=45');
    expect(r.out).toContain('| # managed by machine install idle-suspend, version 1');
    expect(r.out).toContain('$ /usr/bin/sudo /usr/bin/systemctl enable machine-idle-suspend.timer');
    expect(r.out).toMatch(/only RESTRICTS uptime/);
    expect(b.sudoCalls()).toEqual([]);
    expect(b.fake.staged.size).toBe(0);
  });

  it('without --minutes: 30', async () => {
    const r = await box({ tty: false }).go(['idle-suspend', '--dry-run']);
    expect(r.out).toContain('| MINUTES=30');
  });
});

describe('machine install idle-suspend: install, status, refresh, remove', () => {
  it('installs the three files with their modes, then enables and restarts the timer, and verifies it', async () => {
    const b = box();
    const r = await b.go(['idle-suspend', '--minutes', '45']);
    expect(r.code, r.err + r.out).toBe(0);
    expect(r.out).toContain('installed and verified (machine-idle-suspend.timer is running)');
    expect(b.fake.modes.get(SCRIPT)).toBe('0755');
    expect(b.fake.modes.get(SERVICE)).toBe('0644');
    expect(b.fake.modes.get(TIMER)).toBe('0644');
    expect(b.fake.userFiles.get(SCRIPT)).toContain('MINUTES=45');
    expect(b.sudoCalls().map((c) => c.replace(/\/tmp\/machine-install-fake\d+\//g, '<tmp>/'))).toEqual([
      `/usr/bin/sudo install -m 0755 -o root -g root <tmp>/script ${SCRIPT}`,
      `/usr/bin/sudo install -m 0644 -o root -g root <tmp>/service ${SERVICE}`,
      `/usr/bin/sudo install -m 0644 -o root -g root <tmp>/timer ${TIMER}`,
      '/usr/bin/sudo /usr/bin/systemctl daemon-reload',
      '/usr/bin/sudo /usr/bin/systemctl enable machine-idle-suspend.timer',
      '/usr/bin/sudo /usr/bin/systemctl restart machine-idle-suspend.timer',
    ]);
    expect(b.fake.timer).toEqual({ enabled: true, running: true });
    // The output names the journal command, the keep-awake files and the xrdp rule.
    expect(r.out).toContain('journalctl -t machine-idle-suspend');
    expect(r.out).toContain('/run/machine-keep-awake');
    expect(r.out).toMatch(/disconnected desktop session \(xrdp\) is NOT counted/);
  });

  it('--check: installed with the minutes of the script (no --minutes needed), exit 0, with the last decision of the journal', async () => {
    const b = box({ journal: '2026-11-22T10:00:00+0000 thinkcentre machine-idle-suspend[42]: idle 12/45 min\n' });
    expect((await b.go(['idle-suspend', '--minutes', '45'])).code).toBe(0);
    const r = await b.go(['idle-suspend', '--check']);
    expect(r.code, r.out + r.err).toBe(0);
    expect(r.out).toContain('idle-suspend on linux: installed, up to date');
    expect(r.out).toContain('suspends after 45 min idle');
    expect(r.out).toContain('last decision: 2026-11-22T10:00:00+0000 thinkcentre machine-idle-suspend[42]: idle 12/45 min');
    const json = JSON.parse((await b.go(['idle-suspend', '--check', '--json'])).out) as { state: string; details: string[] };
    expect(json.state).toBe('installed');
    expect(json.details[0]).toBe('suspends after 45 min idle');
  });

  it('a journal the user cannot read is reported, never an error', async () => {
    const b = box();
    await b.go(['idle-suspend']);
    const r = await b.go(['idle-suspend', '--check']);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/last decision: not readable by your user \(try: sudo \/usr\/bin\/journalctl -t machine-idle-suspend/);
  });

  it('the timer stopped by hand: --check says partial (exit 1) with the fix; the install writes it again and restarts it', async () => {
    const b = box();
    await b.go(['idle-suspend']);
    b.fake.timer.running = false;
    const check = await b.go(['idle-suspend', '--check']);
    expect(check.code).toBe(1);
    expect(check.out).toContain('partial');
    expect(check.out).toContain('machine-idle-suspend.timer is not running');
    expect(check.out).toContain('finish it with: machine install idle-suspend --refresh');
    const again = await b.go(['idle-suspend']);
    expect(again.code, again.out + again.err).toBe(0);
    expect(again.out).toContain('every file is up to date but machine-idle-suspend.timer is not running');
    expect(b.fake.timer.running).toBe(true);
  });

  it('a second install with another --minutes replaces the script only, after saying so', async () => {
    const b = box();
    await b.go(['idle-suspend', '--minutes', '45']);
    const r = await b.go(['idle-suspend', '--minutes', '10']);
    expect(r.code, r.out + r.err).toBe(0);
    expect(r.out).toMatch(new RegExp(`the installed ${SCRIPT} .* will be REPLACED`));
    expect(r.out).not.toMatch(new RegExp(`the installed ${SERVICE}`));
    expect(b.fake.userFiles.get(SCRIPT)).toContain('MINUTES=10');
  });

  it('a second install without any change says so and runs nothing', async () => {
    const b = box();
    await b.go(['idle-suspend']);
    const before = b.sudoCalls().length;
    const r = await b.go(['idle-suspend']);
    expect(r.out).toContain('already installed, up to date');
    expect(b.sudoCalls().length).toBe(before);
  });

  it('--refresh keeps the installed minutes and writes the three files again', async () => {
    const b = box();
    await b.go(['idle-suspend', '--minutes', '45']);
    const r = await b.go(['idle-suspend', '--refresh']);
    expect(r.code, r.out + r.err).toBe(0);
    expect(r.out).toContain('refreshed and verified');
    expect(b.fake.userFiles.get(SCRIPT)).toContain('MINUTES=45');
    expect(b.sudoCalls().filter((c) => c.includes(' install ')).length).toBe(6);
  });

  it('--remove disables the timer first, removes exactly the three files, reloads, and checks the state', async () => {
    const b = box();
    await b.go(['idle-suspend']);
    const mark = b.fake.calls.length;
    const r = await b.go(['idle-suspend', '--remove']);
    expect(r.code, r.out + r.err).toBe(0);
    expect(r.out).toContain('status after the removal: not installed');
    expect(b.fake.calls.slice(mark).filter((c) => c.startsWith('/usr/bin/sudo ') && !c.includes(' sh -c '))).toEqual([
      '/usr/bin/sudo /usr/bin/systemctl disable --now machine-idle-suspend.timer',
      `/usr/bin/sudo rm -- ${TIMER}`,
      `/usr/bin/sudo rm -- ${SERVICE}`,
      `/usr/bin/sudo rm -- ${SCRIPT}`,
      '/usr/bin/sudo /usr/bin/systemctl daemon-reload',
    ]);
    expect(b.fake.timer).toEqual({ enabled: false, running: false });
    expect([...b.fake.userFiles.keys()]).toEqual([]);
    expect(r.out).toMatch(/nothing to withdraw on the ADMIN machine/);
    expect(JSON.parse((await b.go(['idle-suspend', '--check', '--json'])).out)).toMatchObject({ state: 'not installed' });
  });

  it('--remove with one file not written by machine changes nothing', async () => {
    const b = box();
    await b.go(['idle-suspend']);
    b.fake.userFiles.set(SERVICE, '[Service]\nExecStart=/bin/true\n');
    const mark = b.fake.calls.length;
    const r = await b.go(['idle-suspend', '--remove']);
    expect(r.code).toBe(1);
    expect(r.err).toContain(`${SERVICE} exists and was not written by \`machine install idle-suspend\``);
    expect(b.fake.calls.slice(mark).filter((c) => c.includes(' rm ') || c.includes(' disable '))).toEqual([]);
    expect(b.fake.userFiles.has(SCRIPT)).toBe(true);
  });

  it('an install over a file not written by machine refuses and writes nothing', async () => {
    const b = box({ userFiles: { [SCRIPT]: '#!/bin/sh\necho mine\n' } });
    const r = await b.go(['idle-suspend']);
    expect(r.code).toBe(1);
    expect(r.err).toContain('was not written by `machine install idle-suspend`');
    expect(b.sudoCalls()).toEqual([]);
  });

  it('a failing systemctl enable reports the step, what is installed and the fix by hand', async () => {
    const b = box({ systemctlFails: { enable: 'Failed to enable unit: Access denied' } });
    const r = await b.go(['idle-suspend']);
    expect(r.code).toBe(1);
    expect(r.err).toContain('step failed: enable the timer');
    expect(r.err).toContain('Access denied');
    expect(r.err).toContain('are installed (the rest is not)');
    expect(r.err).toContain('sudo /usr/bin/systemctl enable machine-idle-suspend.timer');
  });

  it('a timer that does not run after a successful enable is a [fail] with the way to look', async () => {
    const b = box({ systemctlFails: { restart: 'Job for machine-idle-suspend.timer failed' } });
    const r = await b.go(['idle-suspend']);
    expect(r.code).toBe(1);
    expect(r.err).toContain('step failed: start the timer now');
  });

  it('refuses without a terminal', async () => {
    const r = await box({ tty: false }).go(['idle-suspend']);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/needs an interactive terminal/);
  });
});

describe('a tool the script needs is missing: never a silent default', () => {
  const without = (tool: string): Record<string, string> => {
    const all: Record<string, string> = { systemctl: '/usr/bin/systemctl', sudo: '/usr/bin/sudo', date: '/usr/bin/date', ss: '/usr/bin/ss', 'systemd-inhibit': '/usr/bin/systemd-inhibit', logger: '/usr/bin/logger', journalctl: '/usr/bin/journalctl' };
    delete all[tool];
    return all;
  };

  it.each([['ss', 'iproute2'], ['systemd-inhibit', 'systemd'], ['logger', 'util-linux'], ['date', 'coreutils']])('%s: install refuses with the package, the list says why, suspend is unaffected', async (tool, pkg) => {
    const b = box({ tools: without(tool) });
    const r = await b.go(['idle-suspend', '--dry-run']);
    expect(r.code).toBe(1);
    expect(r.err).toContain(`${tool} was not found`);
    expect(r.err).toContain(pkg);
    const list = await b.go([]);
    expect(list.out).toContain('state: unsupported here');
    expect(list.out).toContain(`why: ${tool} was not found`);
    expect((await b.go(['suspend', '--dry-run'])).code).toBe(0);
  });

  it('journalctl missing: installs, the last decision is simply not shown', async () => {
    const b = box({ tools: without('journalctl') });
    expect((await b.go(['idle-suspend'])).code).toBe(0);
    const r = await b.go(['idle-suspend', '--check']);
    expect(r.code).toBe(0);
    expect(r.out).not.toContain('last decision');
  });
});

describe('machine status: the line of the installed items', () => {
  const statusOf = async (b: ReturnType<typeof box>) => {
    expect((await cli(dir, ['init', '--name', 'desktop'])).code).toBe(0);
    return cli(dir, ['status'], undefined, { install: b.fake.env });
  };

  it('installed: the minutes and the last decision, and no sudo at all', async () => {
    const b = box({ journal: 'x machine-idle-suspend[1]: not idle: rdp connected\n' });
    await b.go(['idle-suspend', '--minutes', '15']);
    const mark = b.sudoCalls().length;
    const r = await statusOf(b);
    expect(r.out).toMatch(/^installed: idle-suspend \(up to date; suspends after 15 min idle; last decision: x machine-idle-suspend\[1\]: not idle: rdp connected\)$/m);
    expect(b.sudoCalls().length).toBe(mark);
  });

  it('a timer that does not run is a warning with the command', async () => {
    const b = box();
    await b.go(['idle-suspend']);
    b.fake.timer.running = false;
    const r = await statusOf(b);
    expect(r.out).toMatch(/^\[warn\] installed: idle-suspend is incomplete \(machine-idle-suspend\.timer is not running \(systemctl is-active\)\): run machine install idle-suspend --refresh$/m);
  });

  it('nothing about it when it is not installed', async () => {
    const r = await statusOf(box());
    expect(r.out).not.toMatch(/idle-suspend/);
  });
});
