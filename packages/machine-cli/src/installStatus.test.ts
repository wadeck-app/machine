import { describe, expect, it } from 'vitest';
import { findInstallable, type Installable } from '@wadeck-app/machine-core';
import { ageText, decisionText, installedStatusLines, listStatuses, parseDecision, statusBlock } from './installStatus.js';
import { fakeInstall, type FakeInstallOptions } from './installTesting.js';

const SCRIPT = '/usr/local/bin/machine-suspend';
const SUDOERS = '/etc/sudoers.d/machine-suspend';
const def = findInstallable('suspend') as Installable;
const FACTS = { platform: 'linux', userName: 'alice', systemctlPath: '/usr/bin/systemctl', sudoPath: '/usr/bin/sudo' };
const shipped = def.plan(FACTS);
const contentOf = (id: string): string => (shipped.files.find((f) => f.id === id) as { content: string }).content;
const INSTALLED: FakeInstallOptions = { userFiles: { [SCRIPT]: contentOf('script') }, rootFiles: { [SUDOERS]: contentOf('sudoers') } };
const OUTDATED: FakeInstallOptions = { ...INSTALLED, userFiles: { [SCRIPT]: contentOf('script').replace('3 s', '9 s') } };

describe('listStatuses', () => {
  it('not installed: the two files are absent / not listed by sudo, next step is the install', async () => {
    const fake = fakeInstall();
    const [s] = await listStatuses(fake.env);
    expect(s).toMatchObject({ id: 'suspend', supportedHere: true, state: 'not installed', sudoAllowsCommand: false, nextSteps: ['machine install suspend'] });
    expect(s?.files.map((f) => [f.path, f.state])).toEqual([[SCRIPT, 'absent'], [SUDOERS, 'not listed by sudo']]);
  });

  it('installed: every file there; the only sudo call is the non-prompting listing', async () => {
    const fake = fakeInstall(INSTALLED);
    const [s] = await listStatuses(fake.env);
    expect(s).toMatchObject({ state: 'installed', nextSteps: [] });
    expect(fake.calls.filter((c) => c.startsWith('/usr/bin/sudo'))).toEqual(['/usr/bin/sudo -n -l /usr/bin/systemctl suspend']);
    expect(fake.staged.size).toBe(0);
  });

  it('outdated: the next step is --refresh', async () => {
    const [s] = await listStatuses(fakeInstall(OUTDATED).env);
    expect(s).toMatchObject({ state: 'outdated', nextSteps: ['machine install suspend --refresh'] });
  });

  it('partial: names the part that is missing', async () => {
    const [a] = await listStatuses(fakeInstall({ userFiles: INSTALLED.userFiles ?? {} }).env);
    expect(a).toMatchObject({ state: 'partial', missing: [SUDOERS] });
    const [b] = await listStatuses(fakeInstall({ rootFiles: INSTALLED.rootFiles ?? {} }).env);
    expect(b).toMatchObject({ state: 'partial', missing: [SCRIPT] });
  });

  it('foreign: never touched, the removal by hand is a next step', async () => {
    const [s] = await listStatuses(fakeInstall({ userFiles: { [SCRIPT]: 'mine\n' } }).env);
    expect(s?.state).toBe('foreign');
    expect(s?.nextSteps[0]).toContain(`sudo rm -- ${SCRIPT}`);
  });

  it('unsupported platform: the reason, nothing run', async () => {
    const fake = fakeInstall({ platform: 'win32' });
    const [s] = await listStatuses(fake.env);
    expect(s).toMatchObject({ state: 'unsupported here', supportedHere: false, reason: 'not supported on windows yet (supported: linux)', files: [] });
    expect(fake.calls).toEqual([]);
  });

  it('a missing tool is reported as unsupported here with the cause, never an error of the list', async () => {
    const [s] = await listStatuses(fakeInstall({ tools: { sudo: '/usr/bin/sudo' } }).env);
    expect(s?.state).toBe('unsupported here');
    expect(s?.reason).toMatch(/systemctl was not found/);
  });
});

describe('installedStatusLines (the line of `machine status`)', () => {
  it('nothing when no item is installed', async () => {
    expect(await installedStatusLines(fakeInstall().env)).toEqual({ lines: [], items: [] });
  });

  it('installed and up to date: one line', async () => {
    const r = await installedStatusLines(fakeInstall(INSTALLED).env);
    expect(r.lines).toEqual(['installed: suspend (up to date)']);
    expect(r.items).toEqual([{ id: 'suspend', state: 'installed' }]);
  });

  it('outdated: a warning with the command', async () => {
    const r = await installedStatusLines(fakeInstall(OUTDATED).env);
    expect(r.lines).toEqual(['[warn] installed: suspend is outdated: run machine install suspend --refresh']);
  });

  it('nothing for a file machine did not write', async () => {
    expect((await installedStatusLines(fakeInstall({ userFiles: { [SCRIPT]: 'mine\n' } }).env)).lines).toEqual([]);
  });

  it('runs no sudo at all, and nothing at all on an unsupported platform', async () => {
    const linux = fakeInstall(INSTALLED);
    await installedStatusLines(linux.env);
    expect(linux.calls.filter((c) => c.includes('sudo ') || c.startsWith('/usr/bin/sudo'))).toEqual([]);
    const win = fakeInstall({ platform: 'win32' });
    expect((await installedStatusLines(win.env)).lines).toEqual([]);
    expect(win.calls).toEqual([]);
  });

  it('a file that cannot be read is a warning with the cause', async () => {
    const fake = fakeInstall(INSTALLED);
    fake.env.fs.readText = () => {
      throw new Error(`cannot read ${SCRIPT}: EACCES`);
    };
    const r = await installedStatusLines(fake.env);
    expect(r.lines[0]).toMatch(/^\[warn\] installed items: suspend not read: cannot read .*EACCES/);
  });
});

describe('parseDecision: the journal line of idle-suspend, without host, tag and pid', () => {
  const at = '2026-11-22T18:13:56+00:00';
  const hhmmss = (iso: string): string => {
    const d = new Date(iso);
    const p = (n: number): string => String(n).padStart(2, '0');
    return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  };

  it('keeps the local time and the reason', () => {
    expect(parseDecision(`${at} thinkcentre machine-idle-suspend[46595]: not idle: rdp connected`)).toEqual({ atMs: Date.parse(at), time: hhmmss(at), reason: 'not idle: rdp connected' });
  });

  it('accepts +0000, Z and fractions, and a tag without pid', () => {
    expect(parseDecision('2026-11-22T10:00:00+0000 box machine-idle-suspend[42]: idle 12/45 min')).toMatchObject({ atMs: Date.parse('2026-11-22T10:00:00Z'), reason: 'idle 12/45 min' });
    expect(parseDecision('2026-11-22T10:00:00.123456Z box machine-idle-suspend: suspending')).toMatchObject({ reason: 'suspending' });
  });

  it('returns undefined when the line does not parse (never throws)', () => {
    for (const line of ['', 'x machine-idle-suspend[1]: not idle: rdp connected', 'garbage', '2026-99-99T99:99:99+00:00 h t[1]: r']) {
      expect(parseDecision(line), line).toBeUndefined();
    }
  });
});

describe('ageText', () => {
  it.each([
    [0, 'just now'],
    [-5000, 'just now'],
    [30_000, '30 s ago'],
    [3 * 60_000 + 5000, '3 min ago'],
    [2 * 3600_000, '2 h ago'],
    [3 * 86400_000, '3 d ago'],
  ])('%i ms -> %s', (ms, text) => {
    expect(ageText(ms)).toBe(text);
  });
});

describe('statusBlock: one compact block per item', () => {
  const NOW = Date.parse('2026-11-22T18:17:00+00:00');
  const base = { id: 'idle-suspend', description: 'long', platforms: ['linux'], supportedHere: true, state: 'installed' as const, files: [], missing: [], nextSteps: [] };
  const opts = { columns: 100, now: NOW };

  it('header: state first, the configuration in parentheses; then what it does; then the last decision parsed with its age', () => {
    const lines = statusBlock({ ...base, details: ['suspends after 5 min idle', 'last decision: x'], lastDecision: '2026-11-22T18:13:56+00:00 thinkcentre machine-idle-suspend[46595]: not idle: rdp connected' }, opts);
    const time = parseDecision('2026-11-22T18:13:56+00:00 h t[1]: r')?.time as string;
    expect(lines).toEqual([
      'idle-suspend  installed, up to date  (suspends after 5 min idle)',
      '  suspends this box by itself when really idle (root timer, every 2 min)',
      `  last: ${time} not idle: rdp connected (3 min ago)`,
    ]);
  });

  it('an unparsable last decision is never truncated: it is wrapped on indented lines, even a word longer than the width', () => {
    const raw = `x machine-idle-suspend[1]: ${'w'.repeat(200)}`;
    const lines = statusBlock({ ...base, details: ['suspends after 5 min idle', `last decision: ${raw}`], lastDecision: raw }, opts);
    const last = lines.slice(2);
    expect(last[0]?.startsWith('  last: x machine-idle-suspend[1]:')).toBe(true);
    expect(last.slice(1).every((l) => l.startsWith('    '))).toBe(true);
    expect(last.every((l) => l.length <= 99)).toBe(true);
    expect(last.join('').replace(/\s+/g, '')).toBe(`last:${raw.replace(/\s+/g, '')}`);
    expect(last.join('')).not.toContain('...');
  });

  it('the cause of a long reason is never cut: the last line wraps on indented lines (bug seen on the box: `xprintidle f...`)', () => {
    const raw = '2026-11-22T18:13:56+00:00 thinkcentre machine-idle-suspend[46595]: not idle: rdp connected (input idle unreadable: xprintidle failed on :0 as root)';
    for (const columns of [60, 80, 100]) {
      const lines = statusBlock({ ...base, details: ['suspends after 5 min idle'], lastDecision: raw }, { columns, now: NOW });
      const last = lines.slice(lines.findIndex((l) => l.startsWith('  last:')));
      expect(last.join(' ').replace(/\s+/g, ' ')).toContain('not idle: rdp connected (input idle unreadable: xprintidle failed on :0 as root) (3 min ago)');
      expect(last.slice(1).every((l) => l.startsWith('    '))).toBe(true);
      expect(last.join('')).not.toContain('...');
      for (const l of last) expect(l.length).toBeLessThanOrEqual(columns - 1);
    }
  });

  it('decisionText (--check, machine status) keeps the whole line, parsed or not', () => {
    const long = `x machine-idle-suspend[1]: ${'w'.repeat(200)}`;
    expect(decisionText(long, NOW)).toBe(long);
    expect(decisionText('2026-11-22T18:13:56+00:00 h t[1]: not idle: ' + 'c'.repeat(150), NOW)).toContain('c'.repeat(150));
  });

  it('a journal the user cannot read: says so and names the command on its own line', () => {
    const lines = statusBlock({ ...base, details: ['suspends after 5 min idle', 'last decision: not readable by your user (try: sudo /usr/bin/journalctl -t machine-idle-suspend -n 1)'] }, opts);
    expect(lines.slice(2)).toEqual(['  last: not readable by your user, try:', '    sudo /usr/bin/journalctl -t machine-idle-suspend -n 1']);
  });

  it('a platform that cannot run it: one line', () => {
    expect(statusBlock({ ...base, id: 'suspend', supportedHere: false, state: 'unsupported here', reason: 'not supported on windows yet (supported: linux)' }, opts)).toEqual(['suspend  not supported here (platforms: linux)']);
  });

  it('a supported platform where the plan cannot be built: the cause and the fix are kept, wrapped to the width', () => {
    const reason = 'sudo was not found on this machine (`command -v sudo` found nothing): machine installs root-owned files through sudo, with your own password. Install sudo and run the command again. Nothing was changed';
    const lines = statusBlock({ ...base, supportedHere: false, state: 'unsupported here', reason }, { columns: 60, now: NOW });
    expect(lines[0]).toBe('idle-suspend  not supported here (platforms: linux)');
    expect(lines.slice(1).every((l) => l.length <= 59)).toBe(true);
    expect(lines.slice(1).join(' ').replace(/\s+/g, ' ')).toContain('Install sudo and run the command again');
  });

  it('not installed and partial: the next step and the missing parts', () => {
    expect(statusBlock({ ...base, id: 'suspend', state: 'not installed', nextSteps: ['machine install suspend'] }, opts)).toEqual([
      'suspend  not installed',
      '  lets `machine run` suspend this box (one sudoers rule); wake: `machine wake`',
      '  next: machine install suspend',
    ]);
    expect(statusBlock({ ...base, id: 'suspend', state: 'partial', missing: ['/etc/sudoers.d/machine-suspend'], nextSteps: ['machine install suspend'] }, opts)).toContain('  missing: /etc/sudoers.d/machine-suspend');
  });

  it('no line is longer than the terminal minus one, 80 when the width is unknown', () => {
    const raw = `2026-11-22T18:13:56+00:00 h machine-idle-suspend[1]: ${'w'.repeat(200)}`;
    for (const columns of [50, 80, undefined]) {
      const lines = statusBlock({ ...base, details: ['suspends after 5 min idle'], lastDecision: raw }, { columns, now: NOW });
      for (const l of lines) expect(l.length).toBeLessThanOrEqual(columns === undefined ? 80 : columns - 1);
    }
  });
});
