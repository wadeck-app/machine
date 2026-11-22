import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { INSTALLABLES, findInstallable, type Installable } from '@wadeck-app/machine-core';
import { groupHelpText } from './cliHelp.js';
import { fakeInstall, type FakeInstallOptions } from './installTesting.js';
import { cli } from './testing.js';

// `machine install` (install.md): list, help, usage errors, and the command over a fake machine (no sudo, no /etc, no terminal).

let root: string;
let dir: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'machine-cliinstall-'));
  dir = join(root, 'cfg');
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const suspend = findInstallable('suspend') as Installable;
const FACTS = { platform: 'linux', userName: 'alice', systemctlPath: '/usr/bin/systemctl', sudoPath: '/usr/bin/sudo' };
const shipped = suspend.plan(FACTS);
const INSTALLED: FakeInstallOptions = {
  userFiles: { '/usr/local/bin/machine-suspend': (shipped.files[0] as { content: string }).content },
  rootFiles: { '/etc/sudoers.d/machine-suspend': (shipped.files[1] as { content: string }).content },
};

const run = (args: string[], o: FakeInstallOptions = {}, answers: string[] = ['y']) => {
  const fake = fakeInstall(o);
  const asked: string[] = [];
  return cli(dir, ['install', ...args], undefined, {
    install: fake.env,
    ask: async (label) => {
      asked.push(label);
      return answers.shift() ?? 'n';
    },
  }).then((r) => ({ ...r, fake, asked }));
};

describe('machine install (list)', () => {
  it('lists every installable with its platforms, whether this machine supports it, and the usage', async () => {
    const r = await run([]);
    expect(r.code).toBe(0);
    expect(r.err).toBe('');
    expect(r.out).toMatch(/^suspend {2}not installed$/m);
    expect(r.out).toMatch(/^idle-suspend {2}not installed {2}\(suspends after 30 min idle\)$/m);
    // One compact block per item: no generic text repeated, the long description stays in --dry-run.
    expect(r.out).not.toMatch(/platforms: linux|supported on this machine|state:/);
    expect(r.out).not.toContain('a root-owned script and a sudoers rule');
    for (const line of r.out.split('\n').filter((l) => /^ {2}\S/.test(l) && !l.includes('machine install'))) expect(line.length, line).toBeLessThanOrEqual(80);
    expect(r.out).toContain('machine install <id> [--dry-run | --check | --refresh | --remove] [--yes] [--minutes <n>] [--json]');
    // The only sudo call of the list is the listing that never prompts.
    expect(r.fake.calls.filter((c) => c.startsWith('/usr/bin/sudo'))).toEqual(['/usr/bin/sudo -n -l /usr/bin/systemctl suspend']);
    expect(r.fake.staged.size).toBe(0);
  });

  it('shows the state of every item on this machine: not installed, installed, outdated, partial, foreign', async () => {
    expect((await run([])).out).toMatch(/^suspend {2}not installed$/m);
    expect((await run([], INSTALLED)).out).toMatch(/^suspend {2}installed, up to date$/m);
    expect((await run([], { ...INSTALLED, userFiles: { '/usr/local/bin/machine-suspend': 'x' } })).out).toMatch(/^suspend {2}foreign/m);
    const old = (shipped.files[0] as { content: string }).content.replace('3 s', '9 s');
    const outdated = await run([], { ...INSTALLED, userFiles: { '/usr/local/bin/machine-suspend': old } });
    expect(outdated.out).toMatch(/^suspend {2}outdated \(this build ships newer content\)$/m);
    expect(outdated.out).toContain('machine install suspend --refresh');
    const partial = await run([], { userFiles: INSTALLED.userFiles ?? {} });
    expect(partial.out).toMatch(/^suspend {2}partial/m);
    expect(partial.out).toContain('missing: /etc/sudoers.d/machine-suspend');
  });

  it('says when this machine is not supported yet', async () => {
    const r = await run([], { platform: 'win32' });
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/^suspend {2}not supported here \(platforms: linux\)$/m);
    expect(r.out).toMatch(/^idle-suspend {2}not supported here \(platforms: linux\)$/m);
    expect(r.fake.calls).toEqual([]);
  });

  it('`install status` is the explicit alias of the list (same text, same document)', async () => {
    const list = await run([], INSTALLED);
    const status = await run(['status'], INSTALLED);
    expect(status.code).toBe(0);
    expect(status.out).toBe(list.out);
    const a = await run(['--json'], INSTALLED);
    const b = await run(['status', '--json'], INSTALLED);
    expect(b.out).toBe(a.out);
  });

  it('`install status` takes no flag but --json', async () => {
    for (const flag of ['--check', '--refresh', '--remove', '--dry-run', '--yes']) {
      const r = await run(['status', flag]);
      expect(r.code, flag).toBe(2);
      expect(r.err, flag).toMatch(/`machine install status` takes no `--/);
    }
  });

  it('--json: one document with every installable', async () => {
    const r = await run(['--json'], { platform: 'darwin' });
    expect(JSON.parse(r.out)).toEqual({
      platform: 'darwin',
      installables: INSTALLABLES.map((d) => ({
        id: d.id,
        description: d.description,
        platforms: d.platforms,
        supportedHere: false,
        state: 'unsupported here',
        reason: 'not supported on macos yet (supported: linux)',
        files: [],
        missing: [],
        nextSteps: [],
      })),
    });
  });

  it('--json: the stable fields id, state, files[{path, state}], supportedHere, nextSteps for an installed item', async () => {
    const r = await run(['--json'], INSTALLED);
    const doc = JSON.parse(r.out) as { installables: Array<{ id: string; state: string; supportedHere: boolean; nextSteps: string[]; files: Array<{ path: string; state: string }> }> };
    expect(doc.installables[0]).toMatchObject({ id: 'suspend', state: 'installed', supportedHere: true, nextSteps: [] });
    expect(doc.installables[0]?.files.map((f) => [f.path, f.state])).toEqual([['/usr/local/bin/machine-suspend', 'current'], ['/etc/sudoers.d/machine-suspend', 'listed by sudo']]);
  });
});

describe('machine install: help', () => {
  it('the group help lists the subcommand, the flags and the consequence; the sub help too', async () => {
    for (const args of [['install', '--help'], ['install', 'help'], ['help', 'install'], ['install', 'suspend', '--help']]) {
      const r = await cli(join(root, 'none'), args);
      expect(r.code, args.join(' ')).toBe(0);
      expect(r.out, args.join(' ')).toMatch(/^machine install /);
      expect(r.out, args.join(' ')).toMatch(/every trusted peer/);
      expect(r.out, args.join(' ')).toMatch(/--dry-run/);
      expect(r.out, args.join(' ')).toMatch(/--check/);
      expect(r.out, args.join(' ')).toMatch(/--remove/);
      expect(r.out, args.join(' ')).toMatch(/--refresh/);
      if (!args.includes('suspend')) {
        expect(r.out, args.join(' ')).toMatch(/install status/);
      }
      expect(r.out, args.join(' ')).toMatch(/--yes/);
    }
  });

  it('every installable of the registry has its help entry (no drift)', () => {
    for (const d of INSTALLABLES) expect(groupHelpText('install'), d.id).toContain(`  ${d.id} [`);
  });

  it('the global help mentions the command', async () => {
    const r = await cli(join(root, 'none'), ['--help']);
    expect(r.out).toContain('install [<id> | status] [--dry-run | --check | --refresh | --remove] [--yes]');
  });
});

describe('machine install: usage errors (exit 2)', () => {
  it('an unknown id lists the known ones', async () => {
    const r = await run(['nothing']);
    expect(r.code).toBe(2);
    expect(r.err).toBe('[fail] unknown installable "nothing": `machine install` lists them (suspend, idle-suspend)\n');
    expect(r.fake.calls).toEqual([]);
  });

  it('two words', async () => {
    const r = await run(['suspend', 'extra']);
    expect(r.code).toBe(2);
    expect(r.err).toContain('unexpected argument "extra"');
  });

  it.each([['--check', '--remove'], ['--check', '--dry-run'], ['--check', '--yes'], ['--check', '--refresh'], ['--refresh', '--remove']])('%s with %s', async (a, b) => {
    const r = await run(['suspend', a, b]);
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/cannot be combined/);
  });

  it.each(['--check', '--remove', '--dry-run', '--yes', '--refresh'])('%s without an id', async (flag) => {
    const r = await run([flag]);
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/needs an id/);
  });

  it.each([['--yes'], ['--dry-run'], ['--check'], ['--refresh']])('%s on another command', async (flag) => {
    const r = await cli(dir, ['status', flag]);
    expect(r.code).toBe(2);
    expect(r.err).toContain('only apply to `machine install <id>`');
  });

  it('--remove stays refused on commands that do not know it, and accepted here', async () => {
    expect((await cli(dir, ['status', '--remove'])).code).toBe(2);
    expect((await run(['suspend', '--remove', '--dry-run'], INSTALLED)).code).toBe(0);
  });

  it('--list is not an option of install', async () => {
    const r = await run(['suspend', '--list']);
    expect(r.code).toBe(2);
  });
});

describe('machine install suspend', () => {
  it('on windows and macos: refuses, exit 1, the exact message, nothing run', async () => {
    for (const [platform, name] of [['win32', 'windows'], ['darwin', 'macos']]) {
      for (const flags of [[], ['--dry-run'], ['--check'], ['--remove']]) {
        const r = await run(['suspend', ...flags], { platform: platform as string });
        expect(r.code, `${platform} ${flags.join(' ')}`).toBe(1);
        expect(r.err).toBe(`[fail] not supported on ${name} yet (supported: linux)\n`);
        expect(r.out).toBe('');
        expect(r.fake.calls).toEqual([]);
      }
    }
  });

  it('no terminal: refuses with the reason and the fix, exit 1', async () => {
    const r = await run(['suspend'], { tty: false });
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/^\[fail\] `machine install suspend` needs an interactive terminal/);
    expect(r.fake.calls).toEqual([]);
  });

  it('installs after a y, with the name of this machine in the lines to run next', async () => {
    expect((await cli(dir, ['init', '--name', 'desktop'])).code).toBe(0);
    const r = await run(['suspend']);
    expect(r.code).toBe(0);
    expect(r.asked).toHaveLength(1);
    expect(r.out).toContain('machine admin allow desktop --shell sh -- /usr/local/bin/machine-suspend');
    expect(r.out).toContain('machine run desktop -- /usr/local/bin/machine-suspend');
    expect(r.out).toContain('machine wake desktop');
    expect(r.fake.rootFiles.has('/etc/sudoers.d/machine-suspend')).toBe(true);
    expect(r.err).toBe('');
  });

  it('a machine without identity: still installs, with a warning and a placeholder', async () => {
    const r = await run(['suspend']);
    expect(r.code).toBe(0);
    expect(r.out).toContain('machine admin allow <this machine name> --shell sh');
    expect(r.err).toMatch(/\[warn\] this machine has no name yet/);
  });

  it('an answer other than yes changes nothing', async () => {
    const r = await run(['suspend'], {}, ['n']);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/cancelled: nothing was changed/);
    expect(r.fake.rootFiles.size).toBe(0);
  });

  it('--yes asks nothing', async () => {
    const r = await run(['suspend', '--yes']);
    expect(r.code).toBe(0);
    expect(r.asked).toEqual([]);
  });

  it('--dry-run prints the plan and changes nothing', async () => {
    const r = await run(['suspend', '--dry-run'], { tty: false });
    expect(r.code).toBe(0);
    expect(r.out).toContain('dry run: nothing was changed');
    expect(r.fake.calls.filter((c) => c.startsWith('/usr/bin/sudo'))).toEqual([]);
  });

  it('--check: installed, exit 0; not installed, exit 1', async () => {
    const yes = await run(['suspend', '--check'], { ...INSTALLED, tty: false });
    expect(yes.code).toBe(0);
    expect(yes.out).toContain('suspend on linux: installed');
    const no = await run(['suspend', '--check'], { tty: false });
    expect(no.code).toBe(1);
    expect(no.out).toContain('suspend on linux: not installed');
    expect(no.err).toBe('');
  });

  it('--check --json: one document with the state, the files and their hashes', async () => {
    const r = await run(['suspend', '--check', '--json'], { ...INSTALLED, tty: false });
    const doc = JSON.parse(r.out) as { state: string; files: Array<{ id: string; state: string; shippedSha256: string }> };
    expect(doc.state).toBe('installed');
    expect(doc.files.map((f) => f.id)).toEqual(['script', 'sudoers']);
    expect(doc.files[0]?.shippedSha256).toBe((shipped.files[0] as { sha256: string }).sha256);
  });

  it('--json on a real install: stdout is ONE document, the prose goes to stderr', async () => {
    const r = await run(['suspend', '--json']);
    const doc = JSON.parse(r.out) as { applied: boolean; state: string };
    expect(doc).toMatchObject({ applied: true, state: 'installed' });
    expect(r.err).toContain('commands that will run');
  });

  it('--remove removes the two files and says what to withdraw on the admin machine', async () => {
    const r = await run(['suspend', '--remove'], INSTALLED);
    expect(r.code).toBe(0);
    expect(r.fake.rootFiles.size).toBe(0);
    expect(r.out).toContain('machine admin allow <this machine name> --shell sh --remove -- /usr/local/bin/machine-suspend');
  });

  it('a failure is reported on stderr with the command and exits 1', async () => {
    const r = await run(['suspend'], { visudoFails: 'visudo: syntax error near line 3' });
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/^\[fail\] step failed: validate the sudoers rule/);
    expect(r.err).toContain('syntax error near line 3');
  });
});

describe('machine install is local only (hard rule 7: the daemon is never elevated)', () => {
  it('no daemon, peer or app-module source imports the install executor', () => {
    const src = dirname(fileURLToPath(import.meta.url));
    const sources = readdirSync(src, { recursive: true, encoding: 'utf8' }).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'));
    const importers = sources.filter((f) => /from '\.{1,2}\/(?:[\w/]*\/)?(?:installFlow|installEnv|cliInstall)\.js'/.test(readFileSync(join(src, f), 'utf8'))).map((f) => f.replaceAll('\\', '/')).sort();
    expect(importers).toEqual(['cli.ts', 'cliInstall.ts', 'cliTypes.ts', 'installFlow.ts', 'installStatus.ts', 'installTesting.ts']);
  });
});

describe('machine install <id> --refresh', () => {
  it('rewrites an installed item after a y, and says what it did', async () => {
    const r = await run(['suspend', '--refresh'], INSTALLED);
    expect(r.code).toBe(0);
    expect(r.asked).toHaveLength(1);
    expect(r.out).toContain('refreshed and verified');
    expect(r.fake.calls.filter((c) => c.includes('visudo -c -f'))).toHaveLength(1);
  });

  it('--json: one document with action refresh', async () => {
    const r = await run(['suspend', '--refresh', '--yes', '--json'], INSTALLED);
    expect(JSON.parse(r.out)).toMatchObject({ id: 'suspend', action: 'refresh', state: 'installed', applied: true, supportedHere: true });
  });

  it('--refresh --dry-run needs no terminal and runs no sudo', async () => {
    const r = await run(['suspend', '--refresh', '--dry-run'], { ...INSTALLED, tty: false });
    expect(r.code).toBe(0);
    expect(r.fake.calls.filter((c) => c.startsWith('/usr/bin/sudo'))).toEqual([]);
  });
});

describe('the lifecycle contract, through the command, for EVERY installable of the registry', () => {
  it.each(INSTALLABLES.map((d) => [d.id] as const))('%s: status, install, status, refresh, remove, status', async (id) => {
    const fake = fakeInstall({ platform: (INSTALLABLES.find((d) => d.id === id) as Installable).platforms[0] as string });
    const go = (args: string[]) => cli(dir, ['install', ...args], undefined, { install: fake.env, ask: async () => 'y' });
    const before = await go([id, '--check']);
    expect(before.code, before.err).toBe(1);
    expect(before.out).toContain('not installed');
    const installed = await go([id, '--yes']);
    expect(installed.code, installed.err).toBe(0);
    const after = await go([id, '--check']);
    expect(after.code, after.out + after.err).toBe(0);
    const refreshed = await go([id, '--refresh', '--yes']);
    expect(refreshed.code, refreshed.err).toBe(0);
    expect(refreshed.out).toContain('refreshed and verified');
    expect((await go([id, '--check'])).code).toBe(0);
    const removed = await go([id, '--remove', '--yes']);
    expect(removed.code, removed.err).toBe(0);
    expect(removed.out).toContain('status after the removal: not installed');
    const gone = await go([id, '--check']);
    expect(gone.code).toBe(1);
    expect(gone.out).toContain('not installed');
    // The list shows the same state.
    const list = await go(['status', '--json']);
    expect((JSON.parse(list.out) as { installables: Array<{ id: string; state: string }> }).installables.find((d) => d.id === id)?.state).toBe('not installed');
  });
});

describe('machine status: the line of the installed items', () => {
  const statusWith = async (o: FakeInstallOptions) => {
    expect((await cli(dir, ['init', '--name', 'desktop'])).code).toBe(0);
    const fake = fakeInstall(o);
    const r = await cli(dir, ['status'], undefined, { install: fake.env });
    return { ...r, fake };
  };

  it('prints "installed: suspend (up to date)" and runs no sudo', async () => {
    const r = await statusWith({ ...INSTALLED, tty: false });
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/^installed: suspend \(up to date\)$/m);
    expect(r.fake.calls.filter((c) => c.startsWith('/usr/bin/sudo'))).toEqual([]);
  });

  it('an outdated item is a warning with the command', async () => {
    const old = (shipped.files[0] as { content: string }).content.replace('3 s', '9 s');
    const r = await statusWith({ ...INSTALLED, userFiles: { '/usr/local/bin/machine-suspend': old } });
    expect(r.out).toMatch(/^\[warn\] installed: suspend is outdated: run machine install suspend --refresh$/m);
  });

  it('prints nothing about it when no item is installed, and in --json lists the installed ones only', async () => {
    const none = await statusWith({});
    expect(none.out).not.toMatch(/installed: suspend/);
    const dir2 = join(root, 'cfg2');
    expect((await cli(dir2, ['init', '--name', 'desktop'])).code).toBe(0);
    const json = await cli(dir2, ['status', '--json'], undefined, { install: fakeInstall(INSTALLED).env });
    expect((JSON.parse(json.out) as { installedItems?: unknown }).installedItems).toEqual([{ id: 'suspend', state: 'installed' }]);
    const json0 = await cli(dir2, ['status', '--json'], undefined, { install: fakeInstall({}).env });
    expect(JSON.parse(json0.out)).not.toHaveProperty('installedItems');
  });
});
