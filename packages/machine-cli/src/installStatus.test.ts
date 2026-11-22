import { describe, expect, it } from 'vitest';
import { findInstallable, type Installable } from '@wadeck-app/machine-core';
import { installedStatusLines, listStatuses } from './installStatus.js';
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
