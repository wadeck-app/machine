import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runCli } from './cli.js';
import type { CliMetaDeps } from './cliMeta.js';

// `machine cli version | update | rollback | self-check | logs | post-update`. Every side effect (updater process, npm, orch,
// daemon) is injected through io.cliMeta: nothing here updates anything.

const RELEASE = '2026.11.14-592-bbbbbbbb';
let dir: string;
let saved: string | undefined;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'machine-climeta-'));
  saved = process.env.MACHINE_CONFIG_DIR;
  delete process.env.MACHINE_CONFIG_DIR;
});
afterEach(() => {
  if (saved === undefined) delete process.env.MACHINE_CONFIG_DIR;
  else process.env.MACHINE_CONFIG_DIR = saved;
  rmSync(dir, { recursive: true, force: true });
});

async function run(args: string[], cliMeta: Partial<CliMetaDeps> = {}): Promise<{ code: number; out: string; err: string }> {
  let out = '';
  let err = '';
  const code = await runCli([...args, '--config-dir', dir], { stdout: (t) => (out += t), stderr: (t) => (err += t), cliMeta });
  return { code, out, err };
}

describe('machine cli', () => {
  it('without a subcommand or with an unknown one, it is a usage error that lists the subcommands', async () => {
    for (const args of [['cli'], ['cli', 'frobnicate']]) {
      const r = await run(args);
      expect(r.code, args.join(' ')).toBe(2);
      expect(r.err).toMatch(/version \| update \| rollback \| self-check \| logs \| post-update \| register/);
    }
  });

  it('refuses an argument a subcommand does not take instead of ignoring it', async () => {
    const r = await run(['cli', 'version', 'extra']);
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/unexpected argument "extra"/);
  });

  it('--quiet and --follow are refused outside the commands they belong to', async () => {
    expect((await run(['cli', 'version', '--quiet'])).err).toMatch(/--quiet only applies to `machine cli self-check`/);
    expect((await run(['cli', 'version', '--follow'])).err).toMatch(/--follow only applies to `machine cli logs`/);
    expect((await run(['status', '--follow'])).code).toBe(2);
  });
});

describe('machine cli version | logs', () => {
  it('version asks for the published version of the wrapper package', async () => {
    const seen: string[] = [];
    const r = await run(['cli', 'version'], { version: RELEASE, showVersion: async (pkg, v) => void seen.push(`${pkg} ${v}`) });
    expect(r.code).toBe(0);
    expect(seen).toEqual([`@wadeck-app/machine-cli ${RELEASE}`]);
  });

  it('logs shows the log of the configuration directory, --follow and -f follow it', async () => {
    const seen: unknown[] = [];
    const showLogs = async (d: string, o: { follow?: boolean }) => void seen.push([d, o.follow === true]);
    await run(['cli', 'logs'], { showLogs });
    await run(['cli', 'logs', '--follow'], { showLogs });
    await run(['cli', 'logs', '-f'], { showLogs });
    expect(seen).toEqual([[dir, false], [dir, true], [dir, true]]);
  });
});

describe('machine cli update', () => {
  it('refuses a development build before anything runs, with the reason', async () => {
    let ran = false;
    const r = await run(['cli', 'update'], { version: '0.1.0', updaterPath: join(dir, 'u.cjs'), runUpdater: async () => void (ran = true) });
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/\[fail\] dev build 0\.1\.0: refusing to update the global install of machine/);
    expect(ran).toBe(false);
  });

  it('fails with the path when the updater bundle is not there (a checkout)', async () => {
    const r = await run(['cli', 'update'], { version: RELEASE, updaterPath: join(dir, 'missing-updater.cjs'), runUpdater: async () => undefined });
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/\[fail\] updater not found: .*missing-updater\.cjs/);
  });

  it('hands the configuration directory to the updater through MACHINE_CONFIG_DIR, for the run only, and warns about the restart', async () => {
    const updater = join(dir, 'machine-updater.cjs');
    writeFileSync(updater, '');
    const seen: Array<string | undefined> = [];
    const r = await run(['cli', 'update'], { version: RELEASE, updaterPath: updater, runUpdater: async (p) => void seen.push(`${p}|${process.env.MACHINE_CONFIG_DIR}`) });
    expect(r.code).toBe(0);
    expect(seen).toEqual([`${updater}|${dir}`]);
    expect(process.env.MACHINE_CONFIG_DIR).toBeUndefined();
    expect(r.err).toMatch(/restarts the daemon/);
  });

  it('a failing updater is a failure that points at the state file and the log', async () => {
    const updater = join(dir, 'machine-updater.cjs');
    writeFileSync(updater, '');
    const r = await run(['cli', 'update'], {
      version: RELEASE,
      updaterPath: updater,
      runUpdater: async () => {
        throw new Error('Updater exited with code 1');
      },
    });
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/\[fail\] Updater exited with code 1.*update-state\.json.*machine cli logs/s);
  });
});

describe('machine cli rollback', () => {
  // update-state.json is still there (nothing consumed it): shared-cli reads previousVersion from it.
  beforeEach(() => writeFileSync(join(dir, 'update-state.json'), JSON.stringify({ status: 'success', previousVersion: '2026.11.14-590-aaaaaaaa', targetVersion: RELEASE, timestamp: 5 })));

  it('refuses a development build, never touching the install', async () => {
    let ran = false;
    const r = await run(['cli', 'rollback'], { version: '0.1.0', rollback: async () => void (ran = true) });
    expect(r.code).toBe(1);
    expect(ran).toBe(false);
  });

  it('reinstalls the previous version, then runs post-update from the restored install', async () => {
    const order: string[] = [];
    const r = await run(['cli', 'rollback'], {
      version: RELEASE,
      rollback: async (pkg, d) => void order.push(`rollback ${pkg} ${d}`),
      spawnPostUpdate: async () => {
        order.push('post-update');
        return { code: 0, output: '[ok] startup job updated\n' };
      },
    });
    expect(r.code).toBe(0);
    expect(order).toEqual([`rollback @wadeck-app/machine-cli ${dir}`, 'post-update']);
    expect(r.err).toContain('[ok] startup job updated');
  });

  it('a failing post-update after a rollback is a failure with the command to run by hand', async () => {
    const r = await run(['cli', 'rollback'], { version: RELEASE, rollback: async () => undefined, spawnPostUpdate: async () => ({ code: 1, output: '[fail] orch gone\n' }) });
    expect(r.code).toBe(1);
    expect(r.err).toContain('[fail] orch gone');
    expect(r.err).toMatch(/machine cli post-update/);
  });
});

describe('machine cli rollback after update-state.json was consumed', () => {
  const PREVIOUS = '2026.11.14-590-aaaaaaaa';
  const record = () => writeFileSync(join(dir, 'last-update.json'), JSON.stringify({ previousVersion: PREVIOUS, targetVersion: RELEASE, timestamp: 5 }));

  it('restores update-state.json from the record for the rollback, says so, then removes the record', async () => {
    record();
    let stateSeen: { previousVersion?: string } | undefined;
    const r = await run(['cli', 'rollback'], {
      version: RELEASE,
      rollback: async (_pkg, d) => {
        stateSeen = JSON.parse(readFileSync(join(d, 'update-state.json'), 'utf8')) as { previousVersion?: string };
        rmSync(join(d, 'update-state.json'));
      },
      spawnPostUpdate: async () => ({ code: 0, output: '' }),
    });
    expect(r.code).toBe(0);
    expect(stateSeen?.previousVersion).toBe(PREVIOUS);
    expect(r.err).toMatch(/last-update\.json/);
    expect(existsSync(join(dir, 'last-update.json'))).toBe(false);
  });

  it('without state and record, fails before npm with the fix, and does not call the rollback', async () => {
    let ran = false;
    const r = await run(['cli', 'rollback'], { version: RELEASE, rollback: async () => void (ran = true) });
    expect(r.code).toBe(1);
    expect(ran).toBe(false);
    expect(r.err).toMatch(/machine cli update.*npm install -g @wadeck-app\/machine-cli@<version>/s);
  });

  it('a record of another target is refused and kept untouched', async () => {
    writeFileSync(join(dir, 'last-update.json'), JSON.stringify({ previousVersion: PREVIOUS, targetVersion: '2026.11.14-500-cccccccc', timestamp: 5 }));
    let ran = false;
    const r = await run(['cli', 'rollback'], { version: RELEASE, rollback: async () => void (ran = true) });
    expect(r.code).toBe(1);
    expect(ran).toBe(false);
    expect(existsSync(join(dir, 'last-update.json'))).toBe(true);
  });

  it('when the reinstall fails, the restored state is removed again and the record is kept for a retry', async () => {
    record();
    const r = await run(['cli', 'rollback'], {
      version: RELEASE,
      rollback: async () => {
        throw new Error('npm exploded');
      },
    });
    expect(r.code).toBe(1);
    expect(r.err).toContain('npm exploded');
    expect(existsSync(join(dir, 'update-state.json'))).toBe(false);
    expect(existsSync(join(dir, 'last-update.json'))).toBe(true);
  });
});

describe('machine cli self-check', () => {
  const ok = { ok: true, checks: [{ name: 'version', ok: true }, { name: 'node', ok: true }] };
  const bad = { ok: false, checks: [{ name: 'version', ok: true }, { name: 'config-dir', ok: false, detail: 'cannot write /x' }] };

  it('prints one line per check and exits 0 when all pass', async () => {
    const r = await run(['cli', 'self-check'], { selfCheck: async () => ok });
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/\[ok\] version\n\[ok\] node\n/);
  });

  it('a failing check is a [fail] line with its detail and exit 1', async () => {
    const r = await run(['cli', 'self-check'], { selfCheck: async () => bad });
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/\[fail\] config-dir: cannot write \/x/);
  });

  it('--quiet prints nothing when everything passes, and still the failures', async () => {
    expect((await run(['cli', 'self-check', '--quiet'], { selfCheck: async () => ok })).out).toBe('');
    const r = await run(['cli', 'self-check', '--quiet'], { selfCheck: async () => bad });
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/\[fail\] config-dir/);
    expect(r.out).not.toMatch(/\[ok\]/);
  });

  it('--json is the result as one document', async () => {
    expect(JSON.parse((await run(['cli', 'self-check', '--json'], { selfCheck: async () => bad })).out)).toEqual(bad);
  });

  it('really runs the checks on this checkout: a development build fails the version check and says so', async () => {
    const r = await run(['cli', 'self-check']);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/\[fail\] version: .* is not a release version/);
  });
});

describe('machine cli post-update', () => {
  it('prints what it did and exits 0', async () => {
    const r = await run(['cli', 'post-update'], {
      version: RELEASE,
      postUpdate: {
        startup: { status: async () => ({ exists: true }), enable: async () => ({ action: 'updated' }) },
        daemon: { version: async () => '2026.11.14-590-aaaaaaaa', quit: async () => undefined },
      },
    });
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/\[ok\] startup job updated/);
    expect(r.out).toMatch(/asked to quit/);
  });

  it('without orch installed there is no startup job: it succeeds and says nothing was refreshed (not every user runs orch)', async () => {
    let out = '';
    let err = '';
    const code = await runCli(['cli', 'post-update', '--config-dir', dir], {
      stdout: (t) => (out += t),
      stderr: (t) => (err += t),
      startup: { orch: { file: join(dir, 'no-such-orch') } },
      cliMeta: { version: RELEASE, postUpdate: { daemon: { version: async () => '2026.11.14-590-aaaaaaaa', quit: async () => { throw new Error('must not be called'); } } } },
    });
    expect({ code, err }).toEqual({ code: 0, err: '' });
    expect(out).toMatch(/no startup job/);
  });

  it('a failure is [fail] with the cause and the manual command, exit 1', async () => {
    const r = await run(['cli', 'post-update'], {
      version: RELEASE,
      postUpdate: {
        startup: { status: async () => ({ exists: true }), enable: async () => { throw new Error('orch refused'); } },
        daemon: { version: async () => undefined, quit: async () => undefined },
      },
    });
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/\[fail\].*orch refused.*machine startup enable/s);
  });
});

describe('the pending update notice', () => {
  const state = (status: string, extra: Record<string, unknown> = {}) => writeFileSync(join(dir, 'update-state.json'), JSON.stringify({ status, timestamp: Date.now(), ...extra }));

  async function initMachine(): Promise<void> {
    await run(['init', '--name', 'desktop']);
  }

  it('a terminal state is shown once on stderr by an ordinary command, and NOT deleted (the daemon reads it for its loop guard and clears it)', async () => {
    await initMachine();
    state('success', { targetVersion: RELEASE });
    const first = await run(['status'], { version: RELEASE });
    expect(first.err).toMatch(/\[machine\] Updated to v2026\.11\.14-592-bbbbbbbb/);
    expect(existsSync(join(dir, 'update-state.json'))).toBe(true);
    expect((await run(['status'], { version: RELEASE })).err).not.toMatch(/Updated to/);
    expect(existsSync(join(dir, 'update-state.json'))).toBe(true);
  });

  it('a state that is replaced by a newer one is shown again', async () => {
    await initMachine();
    state('success', { targetVersion: RELEASE, timestamp: 1000 });
    await run(['status'], { version: RELEASE });
    state('rolled-back', { previousVersion: '1.0.0', timestamp: 2000 });
    expect((await run(['status'], { version: RELEASE })).err).toMatch(/Rollback to v1\.0\.0/);
  });

  it('a development build neither shows nor touches the state of the real install', async () => {
    await initMachine();
    state('success', { targetVersion: RELEASE });
    const r = await run(['status'], { version: '0.1.0' });
    expect(r.err).not.toMatch(/Updated to/);
    expect(existsSync(join(dir, 'update-state.json'))).toBe(true);
    expect(readdirSync(dir).filter((n) => n.includes('notice'))).toEqual([]);
  });

  it('--json stdout stays one JSON document', async () => {
    await initMachine();
    state('rolled-back', { previousVersion: '1.0.0' });
    const r = await run(['status', '--json'], { version: RELEASE });
    expect(() => JSON.parse(r.out)).not.toThrow();
    expect(r.err).toMatch(/Rollback to v1\.0\.0/);
  });

  it("'applying' is the updater's journal: shown, never cleared", async () => {
    await initMachine();
    state('applying', { pid: 2 ** 31 - 2, targetVersion: RELEASE });
    const r = await run(['status'], { version: RELEASE });
    expect(r.err).toMatch(/interrupted/);
    expect(existsSync(join(dir, 'update-state.json'))).toBe(true);
  });

  it('the `cli` commands do not consume it (the updater and the daemon read it)', async () => {
    state('success', { targetVersion: RELEASE });
    await run(['cli', 'logs'], { showLogs: async () => undefined });
    expect(existsSync(join(dir, 'update-state.json'))).toBe(true);
  });
});

describe('a failed post-update of a background update', () => {
  const pending = () => writeFileSync(join(dir, 'post-update-pending.json'), JSON.stringify({ targetVersion: RELEASE, error: '[fail] orch refused the job', timestamp: 1 }));

  it('is shown by every ordinary command until it is fixed, with the command to run', async () => {
    await run(['init', '--name', 'desktop']);
    pending();
    for (let i = 0; i < 2; i++) {
      const r = await run(['status'], { version: RELEASE });
      expect(r.err).toMatch(/post-update failed.*orch refused the job.*machine cli post-update/s);
    }
  });

  it('is cleared by a post-update that succeeds', async () => {
    pending();
    const r = await run(['cli', 'post-update'], {
      version: RELEASE,
      postUpdate: { startup: { status: async () => ({ exists: false }), enable: async () => ({ action: 'x' }) }, daemon: { version: async () => undefined, quit: async () => undefined } },
    });
    expect(r.code).toBe(0);
    expect(existsSync(join(dir, 'post-update-pending.json'))).toBe(false);
  });
});

describe('machine cli register', () => {
  it('offers the admin page module to app-core now and prints what happened, with this config dir and version', async () => {
    const calls: Array<{ configDir: string; version: string }> = [];
    const r = await run(['cli', 'register'], {
      version: '2026.11.14-001-abcdef12',
      register: async (o) => {
        calls.push({ configDir: o.machineConfigDir ?? '', version: o.moduleStamp ?? '' });
        o.log('app-core: registered machine');
      },
    });
    expect(r.code).toBe(0);
    expect(calls).toEqual([{ configDir: dir, version: '2026.11.14-001-abcdef12' }]);
    expect(r.out).toContain('app-core: registered machine');
  });

  it('--force-register is passed to the registration', async () => {
    const seen: Array<boolean | undefined> = [];
    const r = await run(['cli', 'register', '--force-register'], { register: async (o) => void seen.push(o.forceRegister) });
    expect(r.code).toBe(0);
    expect(seen).toEqual([true]);
    const r2 = await run(['cli', 'register'], { register: async (o) => void seen.push(o.forceRegister) });
    expect(r2.code).toBe(0);
    expect(seen).toEqual([true, false]);
  });

  it('a skipped registration exits 0 with the skip line on stderr, not stdout', async () => {
    const line = 'app-core registration skipped: the configuration folder X is under the temporary folder, so the module would be registered from a path that will disappear (a probe or a test). Set APP_CORE_CONFIG_DIR to an isolated app-core folder to register there, or run machine cli register --force-register';
    const r = await run(['cli', 'register'], { register: async (o) => o.log(line) });
    expect(r.code).toBe(0);
    expect(r.err).toContain(line);
    expect(r.out).not.toContain('skipped');
  });

  it('--force-register only applies to machine cli register', async () => {
    const r = await run(['cli', 'version', '--force-register']);
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/--force-register only applies to .machine cli register./);
    const r2 = await run(['ping', '--force-register']);
    expect(r2.code).toBe(2);
    expect(r2.err).toMatch(/--force-register only applies/);
  });

  it('a registration that throws is a failure with the cause', async () => {
    const r = await run(['cli', 'register'], {
      register: async () => {
        throw new Error('app-core is not reachable');
      },
    });
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/app-core is not reachable/);
  });
});

describe('post-update records the update it follows (an older updater did not)', () => {
  const postUpdateDeps = { startup: { status: async () => ({ exists: false }), enable: async () => ({ action: 'updated' }) }, daemon: { version: async () => undefined, quit: async () => undefined } };
  const recordFile = () => join(dir, 'last-update.json');
  const state = (status: string) => writeFileSync(join(dir, 'update-state.json'), JSON.stringify({ status, targetVersion: RELEASE, previousVersion: '2026.11.14-590-aaaaaaaa', timestamp: 5 }));

  it('writes last-update.json from a success state for this version, and leaves update-state.json for the daemon', async () => {
    state('success');
    const r = await run(['cli', 'post-update'], { version: RELEASE, postUpdate: postUpdateDeps });
    expect(r.code).toBe(0);
    expect(JSON.parse(readFileSync(recordFile(), 'utf8'))).toEqual({ previousVersion: '2026.11.14-590-aaaaaaaa', targetVersion: RELEASE, timestamp: 5 });
    expect(existsSync(join(dir, 'update-state.json'))).toBe(true);
  });

  it('writes nothing for a state that is not a success, or whose target is another version', async () => {
    state('failed');
    await run(['cli', 'post-update'], { version: RELEASE, postUpdate: postUpdateDeps });
    expect(existsSync(recordFile())).toBe(false);
    state('success');
    await run(['cli', 'post-update'], { version: '2026.11.14-600-cccccccc', postUpdate: postUpdateDeps });
    expect(existsSync(recordFile())).toBe(false);
  });
});
