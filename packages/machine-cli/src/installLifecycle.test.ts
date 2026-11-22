import { describe, expect, it } from 'vitest';
import { InstallError, findInstallable, type Installable } from '@wadeck-app/machine-core';
import { runInstallFlow, type FlowIo, type FlowOptions } from './installFlow.js';
import { fakeInstall, type FakeInstallOptions } from './installTesting.js';

// The lifecycle of an installable (install.md, "Lifecycle"): status, refresh (force) and the post-check of the removal.

const SCRIPT = '/usr/local/bin/machine-suspend';
const SUDOERS = '/etc/sudoers.d/machine-suspend';
const def = findInstallable('suspend') as Installable;
const FACTS = { platform: 'linux', userName: 'alice', systemctlPath: '/usr/bin/systemctl', sudoPath: '/usr/bin/sudo' };
const shipped = def.plan(FACTS);
const contentOf = (id: string): string => (shipped.files.find((f) => f.id === id) as { content: string }).content;
const OPTIONS: FlowOptions = { mode: 'install', dryRun: false, yes: false, machineName: 'desktop' };
const INSTALLED: FakeInstallOptions = { userFiles: { [SCRIPT]: contentOf('script') }, rootFiles: { [SUDOERS]: contentOf('sudoers') } };
const HAND_EDITED_SCRIPT = contentOf('script').replace('3 s', '1 s');

function harness(o: FakeInstallOptions = {}, answer = true) {
  const fake = fakeInstall(o);
  const said: string[] = [];
  const warned: string[] = [];
  const questions: string[] = [];
  // What had been said when each question was asked: the plan must be on the screen BEFORE the question.
  const beforeQuestion: string[] = [];
  const io: FlowIo = {
    say: (t) => void said.push(t),
    warn: (t) => void warned.push(t),
    confirm: async (q) => {
      questions.push(q);
      beforeQuestion.push(said.join(''));
      return answer;
    },
  };
  return { fake, io, questions, beforeQuestion, text: () => said.join('') + warned.join('') };
}

const sudoCalls = (calls: string[]): string[] => calls.filter((c) => c.startsWith('/usr/bin/sudo'));
const mutating = (calls: string[]): string[] => calls.filter((c) => / install | rm /.test(c));

describe('--refresh (force: the whole plan again, even when the status says up to date)', () => {
  const REFRESH: FlowOptions = { ...OPTIONS, mode: 'refresh' };

  it('rewrites BOTH files, re-validates with visudo and re-verifies, after showing the plan and asking once', async () => {
    const h = harness(INSTALLED);
    const r = await runInstallFlow(def, REFRESH, h.fake.env, h.io);
    expect(r.exit).toBe(0);
    const sudo = sudoCalls(h.fake.calls);
    const at = (s: string): number => sudo.findIndex((c) => c.includes(s));
    expect(at('visudo -c -f')).toBeGreaterThanOrEqual(0);
    expect(at('install -m 0755 -o root -g root')).toBeGreaterThan(at('visudo -c -f'));
    expect(at('install -m 0440 -o root -g root')).toBeGreaterThan(at('install -m 0755'));
    expect(at('-n -l /usr/bin/systemctl suspend')).toBeGreaterThan(at('install -m 0440'));
    expect(h.questions).toHaveLength(1);
    expect(h.beforeQuestion[0]).toContain('install -m 0440');
    expect(h.beforeQuestion[0]).toMatch(/REWRITTEN/);
    expect(r.document).toMatchObject({ id: 'suspend', action: 'refresh', applied: true, state: 'installed', supportedHere: true });
    expect(h.text()).toContain('refreshed and verified');
  });

  it('says that the status cannot read the rule without root, and that refresh rewrites it whatever it holds', async () => {
    const h = harness(INSTALLED);
    await runInstallFlow(def, REFRESH, h.fake.env, h.io);
    expect(h.beforeQuestion[0]).toMatch(/status cannot read .*sudoers.*without root/s);
    expect(h.beforeQuestion[0]).toMatch(/refresh .*rewrit/i);
  });

  it('repairs a rule and a script changed by hand (the marker is still there, the content is not)', async () => {
    const h = harness({
      userFiles: { [SCRIPT]: HAND_EDITED_SCRIPT },
      rootFiles: { [SUDOERS]: `${contentOf('sudoers')}alice ALL=(root) NOPASSWD: ALL\n` },
    });
    const r = await runInstallFlow(def, { ...REFRESH, yes: true }, h.fake.env, h.io);
    expect(r.exit).toBe(0);
    expect(h.fake.userFiles.get(SCRIPT)).toBe(contentOf('script'));
    expect(h.fake.rootFiles.get(SUDOERS)).toBe(contentOf('sudoers'));
  });

  it('--yes does not ask', async () => {
    const h = harness(INSTALLED);
    await runInstallFlow(def, { ...REFRESH, yes: true }, h.fake.env, h.io);
    expect(h.questions).toEqual([]);
  });

  it('declining changes nothing', async () => {
    const h = harness(INSTALLED, false);
    const r = await runInstallFlow(def, REFRESH, h.fake.env, h.io);
    expect(r.exit).toBe(1);
    expect(mutating(h.fake.calls)).toEqual([]);
    expect(h.text()).toMatch(/cancelled: nothing was changed/);
  });

  it('refuses a file machine did not write, exactly like install, and changes nothing', async () => {
    const h = harness({ userFiles: { [SCRIPT]: 'mine\n' }, rootFiles: { [SUDOERS]: contentOf('sudoers') } });
    await expect(runInstallFlow(def, REFRESH, h.fake.env, h.io)).rejects.toThrow(/not written by `machine install suspend`/);
    expect(mutating(h.fake.calls)).toEqual([]);
    expect(h.fake.userFiles.get(SCRIPT)).toBe('mine\n');
  });

  it('--dry-run prints the plan and runs no sudo at all', async () => {
    const h = harness({ ...INSTALLED, tty: false });
    const r = await runInstallFlow(def, { ...REFRESH, dryRun: true }, h.fake.env, h.io);
    expect(r.exit).toBe(0);
    expect(sudoCalls(h.fake.calls)).toEqual([]);
    expect(h.text()).toContain('dry run: nothing was changed');
    expect(h.text()).toContain('install -m 0440');
  });

  it('needs a terminal, --yes included', async () => {
    const h = harness({ ...INSTALLED, tty: false });
    await expect(runInstallFlow(def, { ...REFRESH, yes: true }, h.fake.env, h.io)).rejects.toThrow(/`machine install suspend --refresh` needs an interactive terminal/);
    expect(h.fake.calls).toEqual([]);
  });

  it('a failed visudo validation installs nothing (the previous files stay)', async () => {
    const h = harness({ ...INSTALLED, visudoFails: 'visudo: syntax error' });
    await expect(runInstallFlow(def, { ...REFRESH, yes: true }, h.fake.env, h.io)).rejects.toThrow(/syntax error/);
    expect(mutating(h.fake.calls)).toEqual([]);
  });

  it('works on a machine where nothing is installed (it is then an install)', async () => {
    const h = harness();
    const r = await runInstallFlow(def, { ...REFRESH, yes: true }, h.fake.env, h.io);
    expect(r.exit).toBe(0);
    expect(h.fake.rootFiles.get(SUDOERS)).toBe(contentOf('sudoers'));
  });
});

describe('removal: the post-check', () => {
  const REMOVE: FlowOptions = { ...OPTIONS, mode: 'remove', yes: true };

  it('after the removal the status reads not installed, and says so', async () => {
    const h = harness(INSTALLED);
    const r = await runInstallFlow(def, REMOVE, h.fake.env, h.io);
    expect(r.exit).toBe(0);
    expect(h.text()).toContain('status after the removal: not installed');
    expect(r.document).toMatchObject({ state: 'not installed', supportedHere: true });
  });

  it('a file that is still there fails loudly: its path, its owner and the sudo command to remove it', async () => {
    const h = harness({ ...INSTALLED, rmLeaves: [SUDOERS] });
    const err = await runInstallFlow(def, REMOVE, h.fake.env, h.io).catch((e: Error) => e);
    expect(err).toBeInstanceOf(InstallError);
    const text = (err as Error).message;
    expect(text).toContain(SUDOERS);
    expect(text).toContain('owner root:root');
    expect(text).toContain(`sudo rm -- ${SUDOERS}`);
    expect(text).not.toContain(`sudo rm -- ${SCRIPT}`);
  });

  it('says when ANOTHER sudo rule still allows the command (not the one of machine)', async () => {
    const h = harness({ ...INSTALLED, probeAllowsWithoutRule: true });
    const r = await runInstallFlow(def, REMOVE, h.fake.env, h.io);
    expect(r.exit).toBe(0);
    expect(h.text()).toMatch(/sudo still lists the command.*another sudoers rule/s);
  });
});

describe('--check and the documents', () => {
  const check = (o: FakeInstallOptions) => {
    const h = harness({ tty: false, ...o });
    return runInstallFlow(def, { ...OPTIONS, mode: 'check' }, h.fake.env, h.io).then((r) => ({ r, h }));
  };

  it('every state follows the exit code rule: 0 only for installed', async () => {
    expect((await check(INSTALLED)).r.exit).toBe(0);
    const others: FakeInstallOptions[] = [{}, { userFiles: INSTALLED.userFiles ?? {} }, { userFiles: { [SCRIPT]: 'x\n' } }, { ...INSTALLED, userFiles: { [SCRIPT]: HAND_EDITED_SCRIPT } }];
    for (const [i, o] of others.entries()) {
      expect((await check(o)).r.exit, `case ${i}`).toBe(1);
    }
  });

  it('the document has the stable fields: id, state, files[{path, state}], supportedHere, nextSteps', async () => {
    const { r } = await check({ ...INSTALLED, userFiles: { [SCRIPT]: HAND_EDITED_SCRIPT } });
    expect(r.document).toMatchObject({ id: 'suspend', state: 'outdated', supportedHere: true, nextSteps: ['machine install suspend --refresh'] });
    const files = r.document.files as Array<{ path: string; state: string }>;
    expect(files.map((f) => [f.path, f.state])).toEqual([[SCRIPT, 'outdated'], [SUDOERS, 'listed by sudo']]);
  });

  it('outdated points at --refresh; installed says that --refresh repairs what was changed by hand', async () => {
    const o = await check({ ...INSTALLED, userFiles: { [SCRIPT]: HAND_EDITED_SCRIPT } });
    expect(o.h.text()).toContain('machine install suspend --refresh');
    const i = await check(INSTALLED);
    expect(i.h.text()).toContain('installed, up to date');
    expect(i.h.text()).toMatch(/changed by hand.*--refresh/s);
  });

  it('partial names the part that is missing', async () => {
    const { r, h } = await check({ userFiles: INSTALLED.userFiles ?? {} });
    expect(r.document).toMatchObject({ state: 'partial', missing: [SUDOERS] });
    expect(h.text()).toContain(`missing: ${SUDOERS}`);
  });

  it('the install document carries the same stable fields', async () => {
    const h = harness();
    const i = await runInstallFlow(def, { ...OPTIONS, yes: true }, h.fake.env, h.io);
    expect(i.document).toMatchObject({ id: 'suspend', state: 'installed', supportedHere: true });
    expect(Array.isArray(i.document.nextSteps)).toBe(true);
    const files = i.document.files as Array<{ path: string }>;
    expect(files.map((f) => f.path)).toEqual([SCRIPT, SUDOERS]);
  });
});
