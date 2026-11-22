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
    expect(r.out).toContain('suspend');
    expect(r.out).toMatch(/platforms: linux/);
    expect(r.out).toMatch(/supported on this machine \(linux\)/);
    expect(r.out).toContain('machine install <id> [--dry-run | --check | --remove] [--yes] [--json]');
    expect(r.fake.calls).toEqual([]);
  });

  it('says when this machine is not supported yet', async () => {
    const r = await run([], { platform: 'win32' });
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/not supported on windows yet \(supported: linux\)/);
  });

  it('--json: one document with every installable', async () => {
    const r = await run(['--json'], { platform: 'darwin' });
    expect(JSON.parse(r.out)).toEqual({
      platform: 'darwin',
      installables: INSTALLABLES.map((d) => ({ id: d.id, description: d.description, platforms: d.platforms, supportedHere: false })),
    });
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
      expect(r.out, args.join(' ')).toMatch(/--yes/);
    }
  });

  it('every installable of the registry has its help entry (no drift)', () => {
    for (const d of INSTALLABLES) expect(groupHelpText('install'), d.id).toContain(`  ${d.id} [`);
  });

  it('the global help mentions the command', async () => {
    const r = await cli(join(root, 'none'), ['--help']);
    expect(r.out).toMatch(/install \[<id>\]/);
  });
});

describe('machine install: usage errors (exit 2)', () => {
  it('an unknown id lists the known ones', async () => {
    const r = await run(['nothing']);
    expect(r.code).toBe(2);
    expect(r.err).toBe('[fail] unknown installable "nothing": `machine install` lists them (suspend)\n');
    expect(r.fake.calls).toEqual([]);
  });

  it('two words', async () => {
    const r = await run(['suspend', 'extra']);
    expect(r.code).toBe(2);
    expect(r.err).toContain('unexpected argument "extra"');
  });

  it.each([['--check', '--remove'], ['--check', '--dry-run'], ['--check', '--yes']])('%s with %s', async (a, b) => {
    const r = await run(['suspend', a, b]);
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/cannot be combined/);
  });

  it.each(['--check', '--remove', '--dry-run', '--yes'])('%s without an id', async (flag) => {
    const r = await run([flag]);
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/needs an id/);
  });

  it.each([['--yes'], ['--dry-run'], ['--check']])('%s on another command', async (flag) => {
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
    expect(importers).toEqual(['cli.ts', 'cliInstall.ts', 'cliTypes.ts', 'installFlow.ts', 'installTesting.ts']);
  });
});
