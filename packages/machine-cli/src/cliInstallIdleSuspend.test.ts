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
    [['idle-suspend', '--minutes', '0'], /1 to 1440/],
    [['idle-suspend', '--minutes', '1441'], /1 to 1440/],
    [['idle-suspend', '--minutes', '30m'], /--minutes must be a whole number/],
    [['idle-suspend', '--minutes', '1e2'], /--minutes must be a whole number/],
    [['idle-suspend', '--minutes', '-5'], /needs a value|--minutes must be/],
    [['idle-suspend', '--minutes'], /--minutes needs a value/],
    [['idle-suspend', '--check', '--minutes', '30'], /not with --check/],
    [['idle-suspend', '--remove', '--minutes', '30'], /not with --remove/],
    [['suspend', '--minutes', '30'], /only applies to `machine install idle-suspend`/],
    [['status', '--minutes', '30'], /only applies to `machine install idle-suspend`/],
    [['--minutes', '30'], /only applies to `machine install idle-suspend`/],
    [['idle-suspend', '--rdp-minutes', '0'], /--rdp-minutes must be a whole number of minutes from 1 to 1440 \(default 20\)/],
    [['idle-suspend', '--rdp-minutes', '1441'], /--rdp-minutes must be a whole number of minutes from 1 to 1440/],
    [['idle-suspend', '--rdp-minutes', '20m'], /--rdp-minutes must be a whole number/],
    [['idle-suspend', '--rdp-minutes'], /--rdp-minutes needs a value/],
    [['idle-suspend', '--check', '--rdp-minutes', '30'], /--rdp-minutes sets what is installed.*not with --check/],
    [['idle-suspend', '--remove', '--rdp-minutes', '30'], /not with --remove/],
    [['suspend', '--rdp-minutes', '30'], /--rdp-minutes only applies to `machine install idle-suspend`/],
    [['status', '--rdp-minutes', '30'], /--rdp-minutes only applies to `machine install idle-suspend`/],
    [['idle-suspend', '--ssh-minutes', '0'], /--ssh-minutes must be a whole number of minutes from 1 to 1440 \(default 20\)/],
    [['idle-suspend', '--ssh-minutes', '1441'], /--ssh-minutes must be a whole number of minutes from 1 to 1440/],
    [['idle-suspend', '--ssh-minutes', '20m'], /--ssh-minutes must be a whole number/],
    [['idle-suspend', '--ssh-minutes'], /--ssh-minutes needs a value/],
    [['idle-suspend', '--check', '--ssh-minutes', '30'], /--ssh-minutes sets what is installed.*not with --check/],
    [['idle-suspend', '--remove', '--ssh-minutes', '30'], /not with --remove/],
    [['suspend', '--ssh-minutes', '30'], /--ssh-minutes only applies to `machine install idle-suspend`/],
    [['status', '--ssh-minutes', '30'], /--ssh-minutes only applies to `machine install idle-suspend`/],
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
    expect(r.out).toContain('| # managed by machine install idle-suspend, version 6');
    expect(r.out).toContain('$ /usr/bin/sudo /usr/bin/systemctl enable machine-idle-suspend.timer');
    expect(r.out).toMatch(/only RESTRICTS uptime/);
    expect(b.sudoCalls()).toEqual([]);
    expect(b.fake.staged.size).toBe(0);
  });

  it('without --minutes: 30', async () => {
    const r = await box({ tty: false }).go(['idle-suspend', '--dry-run']);
    expect(r.out).toContain('| MINUTES=30');
  });

  it('decision 106: 1 is accepted for both flags (9 and 3 too), 0 is not, and the help says the timer checks every 2 min', async () => {
    const r = await box({ tty: false }).go(['idle-suspend', '--dry-run', '--minutes', '1', '--rdp-minutes', '1']);
    expect(r.code, r.err).toBe(0);
    expect(r.out).toContain('| MINUTES=1');
    expect(r.out).toContain('| RDP_MINUTES=1');
    const r2 = await box({ tty: false }).go(['idle-suspend', '--dry-run', '--minutes', '9', '--rdp-minutes', '3']);
    expect(r2.code, r2.err).toBe(0);
    expect(r2.out).toContain('| MINUTES=9');
    expect(r2.out).toContain('| RDP_MINUTES=3');
    const bad = await box({ tty: false }).go(['idle-suspend', '--dry-run', '--rdp-minutes', '0']);
    expect(bad.code).toBe(2);
    expect(bad.err).toContain('--rdp-minutes must be a whole number of minutes from 1 to 1440 (default 20), got "0"');
    const help = await cli(dir, ['install', 'idle-suspend', '--help']);
    expect(help.out).toContain('--minutes <1..1440>');
    expect(help.out).toMatch(/timer runs every 2 min, so a value below 2 acts at the first check/);
    expect(help.out).toMatch(/only restricts uptime/);
  });

  it('decision 103: --rdp-minutes (default 20) is written into the script, with --minutes it is independent', async () => {
    const r = await box({ tty: false }).go(['idle-suspend', '--dry-run']);
    expect(r.out).toContain('| RDP_MINUTES=20');
    const r2 = await box({ tty: false }).go(['idle-suspend', '--dry-run', '--minutes', '5', '--rdp-minutes', '45']);
    expect(r2.code, r2.err).toBe(0);
    expect(r2.out).toContain('| MINUTES=5');
    expect(r2.out).toContain('| RDP_MINUTES=45');
  });
});

// Decision 111: --ssh-minutes (default 20, meaning: input idle time of the tty of an ssh session), stored and read back like --rdp-minutes.
describe('machine install idle-suspend --ssh-minutes (decision 111)', () => {
  it('is written into the script (default 20), independent of the other two, and the help says what counts', async () => {
    const r = await box({ tty: false }).go(['idle-suspend', '--dry-run']);
    expect(r.out).toContain('| SSH_MINUTES=20');
    const r2 = await box({ tty: false }).go(['idle-suspend', '--dry-run', '--minutes', '5', '--rdp-minutes', '45', '--ssh-minutes', '3']);
    expect(r2.code, r2.err).toBe(0);
    expect(r2.out).toContain('| MINUTES=5');
    expect(r2.out).toContain('| RDP_MINUTES=45');
    expect(r2.out).toContain('| SSH_MINUTES=3');
    const help = await box().go(['idle-suspend', '--help']);
    expect(help.out).toMatch(/[--ssh-minutes <1..1440>]/);
    expect(help.out).toMatch(/--ssh-minutes <1..1440>.*tty/);
    expect(help.out).toMatch(/without a tty.*never activity by itself/);
  });

  it('is stored like --rdp-minutes: shown by --check, kept when only another flag changes, a script of version 4 is outdated', async () => {
    const b = box();
    expect((await b.go(['idle-suspend', '--minutes', '5', '--ssh-minutes', '45'])).code).toBe(0);
    expect((await b.go(['idle-suspend', '--check'])).out).toContain('suspends after 5 min idle (RDP: 20 min, SSH: 45 min)');
    expect((await b.go(['idle-suspend', '--rdp-minutes', '60'])).code).toBe(0);
    expect(b.fake.userFiles.get(SCRIPT)).toMatch(/^SSH_MINUTES=45$/m);
    expect((await b.go(['idle-suspend', '--ssh-minutes', '7'])).code).toBe(0);
    expect(b.fake.userFiles.get(SCRIPT)).toMatch(/^SSH_MINUTES=7$/m);
    expect(b.fake.userFiles.get(SCRIPT)).toMatch(/^RDP_MINUTES=60$/m);
    expect((await b.go(['status'])).out).toContain('(suspends after 5 min idle (RDP: 60 min, SSH: 7 min))');
    const old = (b.fake.userFiles.get(SCRIPT) ?? '').replace('version 6', 'version 4').replace(/^SSH_MINUTES=.*\n/m, '');
    b.fake.userFiles.set(SCRIPT, old);
    const check = await b.go(['idle-suspend', '--check']);
    expect(check.code).toBe(1);
    expect(check.out).toMatch(/outdated/);
    expect(check.out).toContain('--refresh');
  });
});

// Decision 102: the RDP input check needs xprintidle; the install only SAYS whether it is there, never installs it.
describe('machine install idle-suspend: xprintidle (read-only probe)', () => {
  const NO_XP = 'xprintidle missing, input idleness is not checked, and an RDP connection counts as activity: sudo apt install xprintidle';
  const base = { systemctl: '/usr/bin/systemctl', sudo: '/usr/bin/sudo', date: '/usr/bin/date', ss: '/usr/bin/ss', 'systemd-inhibit': '/usr/bin/systemd-inhibit', logger: '/usr/bin/logger', journalctl: '/usr/bin/journalctl' };

  it('--dry-run without xprintidle says so with the command, and runs nothing that installs it', async () => {
    const b = box({ tty: false });
    const r = await b.go(['idle-suspend', '--dry-run']);
    expect(r.code, r.err).toBe(0);
    expect(r.out).toContain(NO_XP);
    expect(b.fake.calls.filter((c) => /apt|xprintidle -|install xprintidle/.test(c))).toEqual([]);
    expect(b.sudoCalls()).toEqual([]);
  });

  it('--dry-run with xprintidle names its path (the one written into the script)', async () => {
    const b = box({ tty: false, tools: { ...base, xprintidle: '/usr/bin/xprintidle' } });
    const r = await b.go(['idle-suspend', '--dry-run']);
    expect(r.out).toContain('xprintidle found at /usr/bin/xprintidle');
    expect(r.out).not.toContain(NO_XP);
    expect(r.out).toContain("| XPRINTIDLE='/usr/bin/xprintidle'");
  });

  it('--check and --json carry the note as a detail (installed without xprintidle)', async () => {
    const b = box();
    await b.go(['idle-suspend']);
    const r = await b.go(['idle-suspend', '--check']);
    expect(r.code, r.out + r.err).toBe(0);
    expect(r.out).toContain(`note: ${NO_XP}`);
    const json = JSON.parse((await b.go(['idle-suspend', '--check', '--json'])).out) as { details: string[] };
    expect(json.details).toContain(`note: ${NO_XP}`);
  });

  it('the list block shows the note on its own line', async () => {
    const b = box();
    await b.go(['idle-suspend']);
    const r = await b.go(['status']);
    // The block is wrapped to 80 columns: compare without the line breaks.
    expect(r.out.replace(/\s+/g, ' ')).toContain(` note: ${NO_XP}`);
  });

  it('a script of the previous build (version 3, per-socket input) is outdated: --check says so and names --refresh; --refresh replaces it', async () => {
    const b = box();
    await b.go(['idle-suspend']);
    const current = b.fake.userFiles.get(SCRIPT) as string;
    b.fake.userFiles.set(SCRIPT, current.replace('version 6', 'version 3').replace(/^LOGINCTL=.*\n/m, ''));
    const check = await b.go(['idle-suspend', '--check']);
    expect(check.code).toBe(1);
    expect(check.out).toContain('outdated');
    expect(check.out).toContain('machine install idle-suspend --refresh');
    const refreshed = await b.go(['idle-suspend', '--refresh']);
    expect(refreshed.code, refreshed.out + refreshed.err).toBe(0);
    expect(b.fake.userFiles.get(SCRIPT)).toBe(current);
    expect((await b.go(['idle-suspend', '--check'])).code).toBe(0);
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
    expect(r.out).toContain('suspends after 45 min idle (RDP: 20 min, SSH: 20 min)');
    // Parsed: no host, tag or pid; local time and the age.
    expect(r.out).toMatch(/^last decision: \d\d:\d\d:\d\d idle 12\/45 min \((just now|\d+ (s|min|h|d) ago)\)$/m);
    expect(r.out).not.toContain('machine-idle-suspend[42]');
    const json = JSON.parse((await b.go(['idle-suspend', '--check', '--json'])).out) as { state: string; details: string[] };
    expect(json.state).toBe('installed');
    expect(json.details[0]).toBe('suspends after 45 min idle (RDP: 20 min, SSH: 20 min)');
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

  it('decision 103: the RDP minutes are stored like --minutes: shown by --check, kept when only the other flag changes', async () => {
    const b = box();
    expect((await b.go(['idle-suspend', '--minutes', '5', '--rdp-minutes', '45'])).code).toBe(0);
    const check = await b.go(['idle-suspend', '--check']);
    expect(check.out).toContain('suspends after 5 min idle (RDP: 45 min, SSH: 20 min)');
    expect((await b.go(['idle-suspend', '--minutes', '10'])).code).toBe(0);
    expect(b.fake.userFiles.get(SCRIPT)).toMatch(/^MINUTES=10$/m);
    expect(b.fake.userFiles.get(SCRIPT)).toMatch(/^RDP_MINUTES=45$/m);
    expect((await b.go(['idle-suspend', '--rdp-minutes', '60'])).code).toBe(0);
    expect(b.fake.userFiles.get(SCRIPT)).toMatch(/^MINUTES=10$/m);
    expect(b.fake.userFiles.get(SCRIPT)).toMatch(/^RDP_MINUTES=60$/m);
    const list = await b.go(['status']);
    expect(list.out).toContain('(suspends after 10 min idle (RDP: 60 min, SSH: 20 min))');
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
    expect(list.out).toContain('idle-suspend  not supported here (platforms: linux)');
    expect(list.out.replace(/\s+/g, ' ')).toContain(`${tool} was not found`);
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
    expect(r.out).toMatch(/^installed: idle-suspend \(up to date; suspends after 15 min idle \(RDP: 20 min, SSH: 20 min\); note: xprintidle missing, input idleness is not checked, and an RDP connection counts as activity: sudo apt install xprintidle; last decision: x machine-idle-suspend\[1\]: not idle: rdp connected\)$/m);
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
