import { describe, expect, it } from 'vitest';
import { InstallError, findInstallable, sha256Hex, type Installable } from '@wadeck-app/machine-core';
import { runInstallFlow, type FlowIo, type FlowOptions } from './installFlow.js';
import { fakeInstall, type FakeInstallOptions } from './installTesting.js';

const SCRIPT = '/usr/local/bin/machine-suspend';
const SUDOERS = '/etc/sudoers.d/machine-suspend';
const def = findInstallable('suspend') as Installable;
const FACTS = { platform: 'linux', userName: 'alice', systemctlPath: '/usr/bin/systemctl', sudoPath: '/usr/bin/sudo' };
const shipped = def.plan(FACTS);
const contentOf = (id: string): string => (shipped.files.find((f) => f.id === id) as { content: string }).content;

const OPTIONS: FlowOptions = { mode: 'install', dryRun: false, yes: false, machineName: 'desktop' };

/** The sudo steps that change the machine (the first one marks the end of the plan on the screen). */
const CHANGING_STEP = /(^| )(install|visudo|systemctl|rm)( |$)/;

function harness(o: FakeInstallOptions = {}) {
  const fake = fakeInstall(o);
  const said: string[] = [];
  const warned: string[] = [];
  const questions: string[] = [];
  // What had been said when the first sudo step that changes something ran: the plan must be on the screen BEFORE it (no question is asked any more).
  const beforeFirstStep: string[] = [];
  // A spy that fails any test that uses it: the flow must never ask a question (cast: FlowIo has no `confirm` any more).
  const io = {
    say: (t: string) => void said.push(t),
    warn: (t: string) => void warned.push(t),
    confirm: async (q: string) => {
      questions.push(q);
      return true;
    },
  } as FlowIo;
  const realExec = fake.env.exec;
  fake.env.exec = async (argv) => {
    if (beforeFirstStep.length === 0 && argv[0] === '/usr/bin/sudo' && CHANGING_STEP.test(argv.join(' '))) {
      beforeFirstStep.push(said.join(''));
    }
    return realExec(argv);
  };
  return { fake, io, said, warned, questions, beforeFirstStep, text: () => said.join('') + warned.join('') };
}

const sudoCalls = (calls: string[]): string[] => calls.filter((c) => c.startsWith('/usr/bin/sudo'));
const mutating = (calls: string[]): string[] => calls.filter((c) => / install | rm /.test(c));
const INSTALLED: FakeInstallOptions = { userFiles: { [SCRIPT]: contentOf('script') }, rootFiles: { [SUDOERS]: contentOf('sudoers') } };

describe('install: the happy path', () => {
  it('stages, validates with visudo, installs the script then the sudoers rule, then checks the rule', async () => {
    const h = harness();
    const r = await runInstallFlow(def, OPTIONS, h.fake.env, h.io);
    expect(r.exit).toBe(0);
    const sudo = sudoCalls(h.fake.calls);
    const at = (s: string): number => sudo.findIndex((c) => c.includes(s));
    expect(at('visudo -c -f')).toBeGreaterThanOrEqual(0);
    expect(at('install -m 0755 -o root -g root')).toBeGreaterThan(at('visudo -c -f'));
    expect(at('install -m 0440 -o root -g root')).toBeGreaterThan(at('install -m 0755'));
    expect(at('-n -l /usr/bin/systemctl suspend')).toBeGreaterThan(at('install -m 0440'));
    expect(h.fake.userFiles.get(SCRIPT)).toBe(contentOf('script'));
    expect(h.fake.rootFiles.get(SUDOERS)).toBe(contentOf('sudoers'));
    expect(h.fake.modes.get(SCRIPT)).toBe('0755');
    expect(h.fake.modes.get(SUDOERS)).toBe('0440');
    // The staged files are the exact content, in the temporary folder, and the folder is removed at the end.
    expect([...h.fake.staged.values()].map((s) => s.content).sort()).toEqual([contentOf('script'), contentOf('sudoers')].sort());
    expect(h.fake.removedDirs).toEqual(h.fake.tempDirs);
    expect(h.fake.tempDirs).toHaveLength(1);
    expect(h.questions).toEqual([]);
    expect(r.document).toMatchObject({ id: 'suspend', action: 'install', applied: true });
  });

  it('shows the plan (every file and command) BEFORE it asks, and the output ends with the next steps in order', async () => {
    const h = harness();
    await runInstallFlow(def, OPTIONS, h.fake.env, h.io);
    const text = h.text();
    const at = (s: string): number => text.indexOf(s);
    expect(h.beforeFirstStep[0]).toContain('visudo -c -f <temp dir>/sudoers');
    expect(h.beforeFirstStep[0]).toContain('install -m 0755 -o root -g root <temp dir>/script /usr/local/bin/machine-suspend');
    expect(h.beforeFirstStep[0]).toContain('install -m 0440 -o root -g root <temp dir>/sudoers /etc/sudoers.d/machine-suspend');
    expect(h.beforeFirstStep[0]).toContain('| #!/bin/sh');
    expect(at('visudo -c -f')).toBeGreaterThanOrEqual(0);
    expect(at('alice ALL=(root) NOPASSWD: /usr/bin/systemctl suspend')).toBeGreaterThanOrEqual(0);
    expect(at('sudo asks YOUR password')).toBeGreaterThanOrEqual(0);
    expect(at('installed:')).toBeGreaterThan(at('visudo -c -f'));
    expect(at('sudo -n -l /usr/bin/systemctl suspend')).toBeGreaterThan(at('installed:'));
    expect(at('machine admin allow desktop --shell sh -- /usr/local/bin/machine-suspend')).toBeGreaterThan(at('sudo -n -l'));
    expect(at('machine run desktop -- /usr/local/bin/machine-suspend')).toBeGreaterThan(at('machine admin allow'));
    expect(at('machine wake desktop')).toBeGreaterThan(at('machine run desktop'));
    expect(text).toMatch(/every trusted peer/);
  });

  it('without a machine name (no identity yet) it says so and keeps a placeholder', async () => {
    const h = harness();
    const { machineName: _unused, ...noName } = OPTIONS;
    await runInstallFlow(def, noName, h.fake.env, h.io);
    expect(h.text()).toContain('machine admin allow <this machine name> --shell sh -- /usr/local/bin/machine-suspend');
    expect(h.text()).toMatch(/\[warn\] this machine has no name yet/);
  });

  it('--yes is accepted and changes nothing about the questions (there are none)', async () => {
    const h = harness();
    const r = await runInstallFlow(def, { ...OPTIONS, yes: true }, h.fake.env, h.io);
    expect(r.exit).toBe(0);
    expect(h.questions).toEqual([]);
    expect(h.fake.rootFiles.has(SUDOERS)).toBe(true);
  });

  it('no question is asked without --yes either: the plan is printed, then the sudo steps run (sudo asks the password)', async () => {
    const h = harness();
    const r = await runInstallFlow(def, OPTIONS, h.fake.env, h.io);
    expect(r.exit).toBe(0);
    expect(h.questions).toEqual([]);
    expect(h.text()).not.toMatch(/\[y\/N\]|Apply this plan|cancelled/);
    expect(mutating(h.fake.calls).length).toBeGreaterThan(0);
  });

  it('--dry-run prints the plan and runs no sudo step at all', async () => {
    const h = harness({ tty: false });
    const r = await runInstallFlow(def, { ...OPTIONS, dryRun: true }, h.fake.env, h.io);
    expect(r.exit).toBe(0);
    expect(sudoCalls(h.fake.calls)).toEqual([]);
    expect(h.questions).toEqual([]);
  });
});

describe('install: idempotence and outdated files', () => {
  it('a second run says "already installed, up to date" and runs nothing that changes anything', async () => {
    const h = harness(INSTALLED);
    const r = await runInstallFlow(def, OPTIONS, h.fake.env, h.io);
    expect(r.exit).toBe(0);
    expect(h.text()).toContain('already installed, up to date');
    expect(h.questions).toEqual([]);
    expect(mutating(h.fake.calls)).toEqual([]);
    expect(h.fake.tempDirs).toEqual([]);
    expect(r.document).toMatchObject({ applied: false, state: 'installed' });
  });

  it('an outdated script is replaced after showing both hashes and asking; the up-to-date rule is left alone', async () => {
    const old = contentOf('script').replace('3 s', '9 s');
    const h = harness({ ...INSTALLED, userFiles: { [SCRIPT]: old } });
    const r = await runInstallFlow(def, OPTIONS, h.fake.env, h.io);
    expect(r.exit).toBe(0);
    expect(h.text()).toContain(sha256Hex(old).slice(0, 12));
    expect(h.text()).toContain(sha256Hex(contentOf('script')).slice(0, 12));
    expect(h.questions).toEqual([]);
    expect(h.fake.userFiles.get(SCRIPT)).toBe(contentOf('script'));
    expect(mutating(h.fake.calls).filter((c) => c.includes('install -m 0440'))).toEqual([]);
    expect(h.fake.calls.some((c) => c.includes('visudo'))).toBe(false);
  });

  it('the outdated script is replaced without a question, after the plan shows both hashes', async () => {
    const old = contentOf('script').replace('3 s', '9 s');
    const h = harness({ ...INSTALLED, userFiles: { [SCRIPT]: old } });
    const r = await runInstallFlow(def, OPTIONS, h.fake.env, h.io);
    expect(r.exit).toBe(0);
    expect(h.questions).toEqual([]);
    expect(h.beforeFirstStep[0]).toContain(sha256Hex(old).slice(0, 12));
    expect(h.fake.userFiles.get(SCRIPT)).toBe(contentOf('script'));
  });
});

describe('install: refusals install NOTHING', () => {
  it('a script without the marker is never overwritten, and the message says how to remove it by hand', async () => {
    const h = harness({ userFiles: { [SCRIPT]: '#!/bin/sh\nsystemctl suspend\n' } });
    const error = await runInstallFlow(def, OPTIONS, h.fake.env, h.io).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(InstallError);
    expect((error as Error).message).toContain(SCRIPT);
    expect((error as Error).message).toMatch(/not written by `machine install suspend`/);
    expect((error as Error).message).toContain(`sudo rm -- ${SCRIPT}`);
    expect(mutating(h.fake.calls)).toEqual([]);
    expect(h.questions).toEqual([]);
    expect(h.fake.tempDirs).toEqual([]);
  });

  it('a sudoers file without the marker is never overwritten either', async () => {
    const h = harness({ rootFiles: { [SUDOERS]: 'alice ALL=(ALL) NOPASSWD: ALL\n' } });
    const error = await runInstallFlow(def, OPTIONS, h.fake.env, h.io).catch((e: unknown) => e);
    expect((error as Error).message).toContain(SUDOERS);
    expect((error as Error).message).toContain(`sudo rm -- ${SUDOERS}`);
    expect(mutating(h.fake.calls)).toEqual([]);
    expect(h.fake.rootFiles.get(SUDOERS)).toBe('alice ALL=(ALL) NOPASSWD: ALL\n');
  });

  it('a failed visudo validation installs nothing, prints the message of visudo and removes the temporary folder', async () => {
    const h = harness({ visudoFails: 'visudo: >>> /tmp/machine-install-fake0/sudoers: syntax error near line 3 <<<' });
    const error = await runInstallFlow(def, OPTIONS, h.fake.env, h.io).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(InstallError);
    expect((error as Error).message).toContain('syntax error near line 3');
    expect((error as Error).message).toContain('visudo -c -f /tmp/machine-install-fake0/sudoers');
    expect((error as Error).message).toMatch(/nothing was installed/);
    expect(mutating(h.fake.calls)).toEqual([]);
    expect(h.fake.userFiles.size).toBe(0);
    expect(h.fake.rootFiles.size).toBe(0);
    expect(h.fake.removedDirs).toEqual(h.fake.tempDirs);
  });

  it('a sudo failure is reported with the command and its stderr, and says what is already in place', async () => {
    const h = harness({ installFails: { [SCRIPT]: 'sudo: 3 incorrect password attempts' } });
    const error = await runInstallFlow(def, OPTIONS, h.fake.env, h.io).catch((e: unknown) => e);
    const message = (error as Error).message;
    expect(message).toContain('/usr/bin/sudo install -m 0755 -o root -g root /tmp/machine-install-fake0/script /usr/local/bin/machine-suspend');
    expect(message).toContain('sudo: 3 incorrect password attempts');
    expect(message).toMatch(/exit code 1/);
    expect(message).toMatch(/nothing was installed/);
    expect(h.fake.removedDirs).toEqual(h.fake.tempDirs);
  });

  it('when the rule fails after the script went in, the message says the script is in place', async () => {
    const h = harness({ installFails: { [SUDOERS]: 'install: cannot create regular file: No such file or directory' } });
    const error = await runInstallFlow(def, OPTIONS, h.fake.env, h.io).catch((e: unknown) => e);
    const message = (error as Error).message;
    expect(message).toContain('cannot create regular file');
    expect(message).toContain(`${SCRIPT} is installed`);
    expect(message).toContain('machine install suspend --remove');
  });

  it('a wrong sudo password while reading the root-only rule is a failure with the command, before any change', async () => {
    const h = harness({ rootReadFails: 'sudo: 3 incorrect password attempts' });
    const error = await runInstallFlow(def, OPTIONS, h.fake.env, h.io).catch((e: unknown) => e);
    expect((error as Error).message).toContain('sudo: 3 incorrect password attempts');
    expect((error as Error).message).toContain(SUDOERS);
    expect(mutating(h.fake.calls)).toEqual([]);
  });

  it('a rule that sudo does not list afterwards is a failure with the command to run by hand', async () => {
    const h = harness();
    // Same fake, but the rule is lost between the install and the probe: the fake lists only what is in the rootFiles.
    const original = h.fake.env.exec;
    h.fake.env.exec = async (argv) => {
      const r = await original(argv);
      if (argv.includes('install') && argv.includes(SUDOERS)) {
        h.fake.rootFiles.clear();
      }
      return r;
    };
    const r = await runInstallFlow(def, OPTIONS, h.fake.env, h.io);
    expect(r.exit).toBe(1);
    expect(h.text()).toMatch(/\[fail\] .*does not list/);
    expect(h.text()).toContain('sudo -n -l /usr/bin/systemctl suspend');
  });
});

describe('install: what is checked before anything', () => {
  it.each(['win32', 'darwin'])('%s: refuses with the exact message and runs nothing', async (platform) => {
    const h = harness({ platform, tty: false });
    const error = await runInstallFlow(def, OPTIONS, h.fake.env, h.io).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(InstallError);
    expect((error as Error).message).toBe(`not supported on ${platform === 'win32' ? 'windows' : 'macos'} yet (supported: linux)`);
    expect(h.fake.calls).toEqual([]);
  });

  it.each(['install', 'remove'] as const)('no terminal: %s refuses with the reason and the fix, and runs nothing', async (mode) => {
    const h = harness({ tty: false });
    const error = await runInstallFlow(def, { ...OPTIONS, mode }, h.fake.env, h.io).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(InstallError);
    expect((error as Error).message).toMatch(/interactive terminal/);
    expect((error as Error).message).toMatch(/sudo asks YOUR password/);
    expect((error as Error).message).toMatch(/ssh -t/);
    expect(h.fake.calls).toEqual([]);
  });

  it('--yes does not replace the terminal', async () => {
    const h = harness({ tty: false });
    await expect(runInstallFlow(def, { ...OPTIONS, yes: true }, h.fake.env, h.io)).rejects.toThrow(/interactive terminal/);
  });

  it('a user name that cannot be written into sudoers is refused before any sudo', async () => {
    const h = harness({ userName: 'Alice Smith' });
    await expect(runInstallFlow(def, OPTIONS, h.fake.env, h.io)).rejects.toThrow(/user name/);
    expect(sudoCalls(h.fake.calls)).toEqual([]);
  });

  it('systemctl not found: says that suspend needs systemd', async () => {
    const h = harness({ tools: { sudo: '/usr/bin/sudo' } });
    await expect(runInstallFlow(def, OPTIONS, h.fake.env, h.io)).rejects.toThrow(/systemctl was not found.*systemd/);
    expect(sudoCalls(h.fake.calls)).toEqual([]);
  });

  it('sudo not found: says how to get it', async () => {
    const h = harness({ tools: { systemctl: '/usr/bin/systemctl' } });
    await expect(runInstallFlow(def, OPTIONS, h.fake.env, h.io)).rejects.toThrow(/sudo was not found/);
  });

  it('a relative answer of `command -v` (a shell function or builtin) is refused', async () => {
    const h = harness({ tools: { systemctl: 'systemctl', sudo: '/usr/bin/sudo' } });
    await expect(runInstallFlow(def, OPTIONS, h.fake.env, h.io)).rejects.toThrow(/absolute/);
  });
});

describe('--dry-run', () => {
  it('prints the plan, runs no sudo, writes nothing, needs no terminal and says the rule was not read', async () => {
    const h = harness({ tty: false });
    const r = await runInstallFlow(def, { ...OPTIONS, dryRun: true }, h.fake.env, h.io);
    expect(r.exit).toBe(0);
    expect(sudoCalls(h.fake.calls)).toEqual([]);
    expect(h.fake.staged.size).toBe(0);
    expect(h.fake.tempDirs).toEqual([]);
    expect(h.questions).toEqual([]);
    expect(h.text()).toContain('visudo -c -f <temp dir>/sudoers');
    expect(h.text()).toContain('alice ALL=(root) NOPASSWD: /usr/bin/systemctl suspend');
    expect(h.text()).toMatch(/dry run: nothing was changed/);
    expect(h.text()).toMatch(/not read/);
    expect(r.document).toMatchObject({ dryRun: true, applied: false });
  });

  it('still refuses a foreign script', async () => {
    const h = harness({ tty: false, userFiles: { [SCRIPT]: 'x\n' } });
    await expect(runInstallFlow(def, { ...OPTIONS, dryRun: true }, h.fake.env, h.io)).rejects.toThrow(/not written by/);
  });

  it('--remove --dry-run lists the removal and runs nothing', async () => {
    const h = harness({ ...INSTALLED, tty: false });
    const r = await runInstallFlow(def, { ...OPTIONS, mode: 'remove', dryRun: true }, h.fake.env, h.io);
    expect(r.exit).toBe(0);
    expect(sudoCalls(h.fake.calls)).toEqual([]);
    expect(h.text()).toContain(`rm -- ${SUDOERS}`);
    expect(h.fake.userFiles.has(SCRIPT)).toBe(true);
  });
});

describe('--remove', () => {
  it('shows both files, asks, then removes exactly the rule and the script, in that order', async () => {
    const h = harness({ ...INSTALLED, userFiles: { ...INSTALLED.userFiles, '/usr/local/bin/other': 'x' } });
    const r = await runInstallFlow(def, { ...OPTIONS, mode: 'remove' }, h.fake.env, h.io);
    expect(r.exit).toBe(0);
    expect(mutating(h.fake.calls)).toEqual([`/usr/bin/sudo rm -- ${SUDOERS}`, `/usr/bin/sudo rm -- ${SCRIPT}`]);
    expect(h.fake.rootFiles.size).toBe(0);
    expect([...h.fake.userFiles.keys()]).toEqual(['/usr/local/bin/other']);
    expect(h.questions).toEqual([]);
    expect(h.beforeFirstStep[0]).toContain(SUDOERS);
    expect(h.beforeFirstStep[0]).toContain(`rm -- ${SCRIPT}`);
    expect(r.document).toMatchObject({ action: 'remove', applied: true });
    expect(h.text()).toMatch(/machine admin allow desktop --shell sh --remove -- \/usr\/local\/bin\/machine-suspend/);
  });

  it('removes only what is there: a missing rule is skipped', async () => {
    const h = harness({ userFiles: INSTALLED.userFiles ?? {} });
    const r = await runInstallFlow(def, { ...OPTIONS, mode: 'remove', yes: true }, h.fake.env, h.io);
    expect(r.exit).toBe(0);
    expect(mutating(h.fake.calls)).toEqual([`/usr/bin/sudo rm -- ${SCRIPT}`]);
  });

  it('nothing installed: says so, exit 0, asks nothing', async () => {
    const h = harness();
    const r = await runInstallFlow(def, { ...OPTIONS, mode: 'remove' }, h.fake.env, h.io);
    expect(r.exit).toBe(0);
    expect(h.text()).toContain('not installed: nothing to remove');
    expect(h.questions).toEqual([]);
  });

  it('refuses a file machine did not write, and removes nothing at all', async () => {
    const h = harness({ userFiles: { [SCRIPT]: 'mine\n' }, rootFiles: { [SUDOERS]: contentOf('sudoers') } });
    await expect(runInstallFlow(def, { ...OPTIONS, mode: 'remove' }, h.fake.env, h.io)).rejects.toThrow(/not written by/);
    expect(mutating(h.fake.calls)).toEqual([]);
    expect(h.fake.rootFiles.has(SUDOERS)).toBe(true);
  });

  it('the removal asks no question either: the files to delete are printed first, then the steps run', async () => {
    const h = harness(INSTALLED);
    const r = await runInstallFlow(def, { ...OPTIONS, mode: 'remove' }, h.fake.env, h.io);
    expect(r.exit).toBe(0);
    expect(h.questions).toEqual([]);
    expect(h.text()).not.toMatch(/\[y\/N\]|Remove these files\?|cancelled/);
    expect(h.beforeFirstStep[0]).toContain('files that will be removed (all written by machine)');
    expect(h.beforeFirstStep[0]).toContain(`${SCRIPT}`);
    expect(h.fake.rootFiles.has(SUDOERS)).toBe(false);
  });
});

describe('--check', () => {
  const check = (o: FakeInstallOptions) => {
    const h = harness({ tty: false, ...o });
    return runInstallFlow(def, { ...OPTIONS, mode: 'check' }, h.fake.env, h.io).then((r) => ({ r, h }));
  };

  it('installed: exit 0', async () => {
    const { r, h } = await check(INSTALLED);
    expect(r.exit).toBe(0);
    expect(r.document).toMatchObject({ state: 'installed' });
    expect(h.text()).toContain('installed');
  });

  it('not installed: exit 1, says how to install', async () => {
    const { r, h } = await check({});
    expect(r.exit).toBe(1);
    expect(r.document).toMatchObject({ state: 'not installed' });
    expect(h.text()).toContain('machine install suspend');
  });

  it('outdated (the content hash differs from the one this build ships): exit 1, both hashes', async () => {
    const old = contentOf('script').replace('3 s', '9 s');
    const { r, h } = await check({ ...INSTALLED, userFiles: { [SCRIPT]: old } });
    expect(r.exit).toBe(1);
    expect(r.document).toMatchObject({ state: 'outdated' });
    expect(h.text()).toContain(sha256Hex(old).slice(0, 12));
    expect(h.text()).toContain(sha256Hex(contentOf('script')).slice(0, 12));
  });

  it('a script without the marker is reported as not written by machine', async () => {
    const { r } = await check({ userFiles: { [SCRIPT]: 'mine\n' } });
    expect(r.exit).toBe(1);
    expect(r.document).toMatchObject({ state: 'foreign' });
  });

  it('the script without the rule (or the reverse) is partial', async () => {
    const a = await check({ userFiles: INSTALLED.userFiles ?? {} });
    expect(a.r.document).toMatchObject({ state: 'partial' });
    expect(a.r.exit).toBe(1);
    const b = await check({ rootFiles: INSTALLED.rootFiles ?? {} });
    expect(b.r.document).toMatchObject({ state: 'partial' });
  });

  it('changes nothing: only `command -v`, the read of the script and the non-interactive `sudo -n -l`', async () => {
    const { h } = await check(INSTALLED);
    expect(h.fake.calls.filter((c) => !c.startsWith('sh -c command -v'))).toEqual(['/usr/bin/sudo -n -l /usr/bin/systemctl suspend']);
    expect(h.fake.staged.size).toBe(0);
    expect(h.fake.tempDirs).toEqual([]);
  });

  it('says that the content of the root-only rule cannot be compared without sudo', async () => {
    const { h } = await check(INSTALLED);
    expect(h.text()).toMatch(/root-only/);
  });

  it('an unsupported platform is refused, check included', async () => {
    const h = harness({ platform: 'win32' });
    await expect(runInstallFlow(def, { ...OPTIONS, mode: 'check' }, h.fake.env, h.io)).rejects.toThrow('not supported on windows yet (supported: linux)');
  });
});
