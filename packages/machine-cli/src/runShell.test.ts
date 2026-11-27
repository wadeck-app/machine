import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { runCommand, type RunOptions, type RunResult } from '@wadeck-app/machine-exec';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startMachineDaemon } from './daemonEntry.js';
import { connectionsFile } from './connectionsStore.js';
import { readMachine } from './identity.js';
import { cli, provision, type PolicyDraftEntry } from './testing.js';

// The shell is part of the exact entry (decision 71). A = "desktop" (admin, the caller), B = "laptop" (the target). The real incident: the entry
// was allowed with the shell of the TARGET (sh) and the caller (Windows) sent cmd by default. Here the platform shell of the caller is SHELL, the
// shell of the entry is ALT (a shell that works on this host too, so that a run that is allowed really executes).

const SHELL = process.platform === 'win32' ? 'cmd' : 'sh';
const ALT = process.platform === 'win32' ? 'ps' : 'bash';

// The first real PowerShell of a fresh Windows CI runner timed out the test '--shell wins' (60 s) in the runs of 7b4ae48 and 3b45748 while the same test passed
// in other runs: its cause was never established. This warm-up starts PowerShell once, alone, with its own limit and a message that names the measured time, so a
// slow cold start fails HERE with that fact instead of as an anonymous timeout of a machine run.
beforeAll(() => {
  if (process.platform !== 'win32') return;
  const started = Date.now();
  const done = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', 'exit 0'], { timeout: 110_000, windowsHide: true });
  const seconds = Math.round((Date.now() - started) / 100) / 10;
  if (done.error !== undefined || done.status !== 0) {
    throw new Error(`the PowerShell warm-up of this test file failed after ${seconds} s (${done.error?.message ?? `exit ${String(done.status)}`}): powershell does not start on this host, the machine run tests of the ps shell cannot run`);
  }
  // Said on purpose in the CI log: the slowest cold start seen is then known.
  console.info(`PowerShell warm-up: ${seconds} s`);
}, 120_000);

let root: string;
let a: string;
let b: string;
const stoppers: Array<() => Promise<void>> = [];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'machine-runshell-'));
  a = join(root, 'a');
  b = join(root, 'b');
});
afterEach(async () => {
  while (stoppers.length > 0) await stoppers.pop()?.();
  rmSync(root, { recursive: true, force: true });
});

async function setUp(policy: PolicyDraftEntry[], runner?: { run: (options: RunOptions) => Promise<RunResult>; timeoutMs: number }) {
  await provision(root, a, b, policy);
  const daemon = await startMachineDaemon(b, { port: 0, version: 'e2e', peerPort: 0, peerHost: '127.0.0.1', ...(runner !== undefined ? { exec: runner } : {}) });
  stoppers.push(daemon.stop);
  return `127.0.0.1:${daemon.peerPort}`;
}

const LS = 'echo hi';

/** The processes that matter to a hung shell (pid, parent, name, command line), as text. Never rejects: a failure of the snapshot is itself the text. */
function processTree(): Promise<string> {
  const win = process.platform === 'win32';
  const file = win ? 'powershell' : 'ps';
  const args = win
    ? ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', "Get-CimInstance Win32_Process | Where-Object { $_.Name -match 'node|powershell|pwsh|cmd|conhost|taskkill|reg' } | ForEach-Object { '{0} ppid={1} {2} :: {3}' -f $_.ProcessId, $_.ParentProcessId, $_.Name, $_.CommandLine }"]
    : ['-eo', 'pid,ppid,args'];
  return new Promise((resolve) => {
    let text = '';
    const child = spawn(file, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    const timer = setTimeout(() => {
      child.kill();
      resolve(`(process snapshot did not finish in 20 s: ${text})`);
    }, 20_000);
    child.stdout.on('data', (c: Buffer) => (text += c.toString('utf8')));
    child.stderr.on('data', (c: Buffer) => (text += c.toString('utf8')));
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve(`(process snapshot could not start: ${e.message})`);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve(code === 0 ? text.trim() : `(process snapshot exited ${String(code)}) ${text.trim()}`);
    });
  });
}

/**
 * The daemon runs the real command, but with a shorter limit than the test watchdog and a snapshot of the process tree taken while the child is still
 * running: a hang then ends with the process tree and with what the child wrote (stdout, stderr, timedOut), not with an anonymous timeout.
 */
function diagnosedRunner() {
  const seen: { snapshots: Array<Promise<string>>; results: RunResult[]; errors: string[] } = { snapshots: [], results: [], errors: [] };
  const run = (options: RunOptions): Promise<RunResult> => {
    // 20 s after the start the child should have ended long ago (a cold start measured 5 s at most): what still runs is the suspect.
    const timer = setTimeout(() => seen.snapshots.push(processTree()), 20_000);
    return runCommand({ ...options, timeoutMs: 40_000 })
      .then(
        (r) => {
          seen.results.push(r);
          return r;
        },
        (e: unknown) => {
          seen.errors.push((e as Error).message);
          throw e;
        },
      )
      .finally(() => clearTimeout(timer));
  };
  const report = async (): Promise<string> => {
    const snapshots = await Promise.all(seen.snapshots);
    return [
      `runs ended: ${JSON.stringify(seen.results)}`,
      `run errors: ${JSON.stringify(seen.errors)}`,
      snapshots.length === 0 ? 'process tree: no snapshot (no run was alive 20 s after its start)' : `process tree 20 s after the start of the run:\n${snapshots.join('\n')}`,
    ].join('\n');
  };
  return { runner: { run, timeoutMs: 40_000 }, report };
}

describe('machine run: the shell comes from --shell, else the default of the peer, else the platform', () => {
  it('REAL INCIDENT: the entry exists under another shell: the refusal says which one works, once, and the caller adds what its policy record allows', async () => {
    const address = await setUp([{ shell: ALT, command: LS }, { shell: ALT, command: 'echo other' }]);
    const r = await cli(a, ['run', 'laptop', '--no-wait', '--address', address, '--', 'echo', 'hi']);
    expect(r.code).toBe(255);
    expect(r.out).toBe('');
    // The hint of the target, word for word, then nothing that repeats it.
    expect(r.err).toContain(`refused by laptop: not-listed: "${LS}" is allowed with shell ${ALT}, not with ${SHELL}: run machine run laptop --shell ${ALT} -- "${LS}" (or: machine peer connect laptop --shell ${ALT} to make it the default)`);
    expect(r.err.match(/is allowed with shell/g)).toHaveLength(1);
    // The old advice (add the command under the shell that was used) would widen the list for nothing: it is not repeated.
    expect(r.err).not.toContain('To allow it');
    // The caller holds the policy it signed: one more line, the list of this peer.
    expect(r.err).toContain(`commands allowed on laptop per the policy signed here (v 1): ${ALT} "${LS}", ${ALT} "echo other" (machine allowed laptop)`);
  });

  it('the refusal of a command that exists nowhere keeps the old advice, plus the list line', async () => {
    const address = await setUp([{ shell: ALT, command: LS }]);
    const r = await cli(a, ['run', 'laptop', '--no-wait', '--address', address, '--', 'echo', 'nope']);
    expect(r.code).toBe(255);
    expect(r.err).toContain(`To allow it, on the admin machine run: machine admin allow laptop --shell ${SHELL} -- "echo nope"`);
    expect(r.err).not.toContain('is allowed with shell');
    expect(r.err).toContain(`commands allowed on laptop per the policy signed here (v 1): ${ALT} "${LS}" (machine allowed laptop)`);
  });

  it('--shell wins', async () => {
    // Timed out at 60 s on the Windows runners of 7b4ae48, 3b45748 and 5e4158d (warm-up 4.9 s in the last one, cause not established, the log shows nothing between the warm-up and the timeout). The stages and a 50 s watchdog below make the next failure say WHERE the time went instead of an anonymous timeout.
    const started = Date.now();
    const seconds = (): string => `${((Date.now() - started) / 1000).toFixed(1)} s`;
    const diagnosed = diagnosedRunner();
    const address = await setUp([{ shell: ALT, command: LS }], diagnosed.runner);
    const setUpDone = seconds();
    let watchdog: NodeJS.Timeout | undefined;
    const hung = new Promise<never>((_, reject) => {
      watchdog = setTimeout(() => {
        // The daemon ends the child at 40 s (timedOut), so its result, its output and the process tree of the 20 s snapshot are known here.
        void diagnosed.report().then((report) => reject(new Error(`machine run --shell ${ALT} was still running after 50 s: provision and daemon start were done at ${setUpDone}, now ${seconds()} into the test. Either the daemon or the ${ALT} child hung; the cause is not established (see the test comment). Diagnostics:\n${report}`)));
      }, 50_000);
    });
    const r = await Promise.race([cli(a, ['run', 'laptop', '--no-wait', '--address', address, '--shell', ALT, '--', 'echo', 'hi']), hung]).finally(() => clearTimeout(watchdog));
    // powershell writes its own progress XML on stderr: only what machine says matters here.
    expect(r.err).not.toContain('refused');
    expect(r.code).toBe(0);
    expect(r.out.trim()).toBe('hi');
  });

  it('the default shell of the peer is used and said (stderr, stdout stays the command output)', async () => {
    const address = await setUp([{ shell: ALT, command: LS }]);
    expect((await cli(a, ['peer', 'connect', 'laptop', '--shell', ALT])).code).toBe(0);
    const r = await cli(a, ['run', 'laptop', '--no-wait', '--address', address, '--', 'echo', 'hi']);
    expect(r.code).toBe(0);
    expect(r.out.trim()).toBe('hi');
    expect(r.err).toContain(`[info] shell ${ALT}: the default of laptop (machine peer connect laptop --shell; --shell overrides it)\n`);
    expect(r.err).not.toContain('refused');
  });

  it('precedence: an explicit --shell beats the default of the peer (and then nothing is said about the default)', async () => {
    const address = await setUp([{ shell: ALT, command: LS }]);
    await cli(a, ['peer', 'connect', 'laptop', '--shell', ALT]);
    const r = await cli(a, ['run', 'laptop', '--no-wait', '--address', address, '--shell', SHELL, '--', 'echo', 'hi']);
    expect(r.code).toBe(255);
    expect(r.err).not.toContain('the default of laptop');
    expect(r.err).toContain(`is allowed with shell ${ALT}, not with ${SHELL}`);
  });

  it('a refusal under the default of the peer says that shell came from the default', async () => {
    const address = await setUp([{ shell: SHELL, command: LS }]);
    await cli(a, ['peer', 'connect', 'laptop', '--shell', ALT]);
    const r = await cli(a, ['run', 'laptop', '--no-wait', '--address', address, '--', 'echo', 'hi']);
    expect(r.code).toBe(255);
    expect(r.err).toContain(`[info] shell ${ALT}: the default of laptop`);
    expect(r.err).toContain(`is allowed with shell ${SHELL}, not with ${ALT}`);
  });

  it('--no-shell goes back to the platform of the caller', async () => {
    const address = await setUp([{ shell: SHELL, command: LS }]);
    await cli(a, ['peer', 'connect', 'laptop', '--shell', ALT]);
    await cli(a, ['peer', 'connect', 'laptop', '--no-shell']);
    const r = await cli(a, ['run', 'laptop', '--no-wait', '--address', address, '--', 'echo', 'hi']);
    expect(r.err).toBe('');
    expect(r.code).toBe(0);
  });

  it('an unknown --shell is refused before anything is sent', async () => {
    const r = await cli(a, ['run', 'laptop', '--no-wait', '--shell', 'zsh', '--', 'echo', 'hi']);
    expect(r.code).toBe(255);
    expect(r.err).toMatch(/unknown shell "zsh": expected one of cmd, ps, bash, sh/);
  });

  it('a damaged connections.json stops the run with the path (no silent platform fallback)', async () => {
    const address = await setUp([{ shell: SHELL, command: LS }]);
    const file = connectionsFile(a);
    const { writeFileSync } = await import('node:fs');
    writeFileSync(file, JSON.stringify({ v: 1, peers: { [readMachine(b).uuid]: { type: 'direct', shell: 'zsh' } } }));
    const r = await cli(a, ['run', 'laptop', '--no-wait', '--address', address, '--', 'echo', 'hi']);
    expect(r.code).not.toBe(0);
    expect(r.err).toContain(file);
    expect(r.err).toMatch(/shell: expected one of cmd, ps, bash, sh, got "zsh"/);
    expect(readFileSync(file, 'utf8')).toContain('zsh');
  });
});

describe('machine allowed <machine>', () => {
  it('prints the entries per shell, the version, when it was signed here, and the line about the remote view', async () => {
    await setUp([{ shell: 'sh', command: 'ls' }, { shell: 'cmd', command: 'dir' }, { shell: 'sh', command: 'pwd' }]);
    const r = await cli(a, ['allowed', 'laptop']);
    expect(r.err).toBe('');
    expect(r.code).toBe(0);
    const lines = r.out.trimEnd().split('\n');
    expect(lines[0]).toMatch(/^Allowed on "laptop" per the policy signed here \(version 1, signed .+\):$/);
    expect(lines.slice(1)).toEqual(['  by default, for every trusted peer without a list of its own:', '    sh', '      #1 "ls"', '      #3 "pwd"', '    cmd', '      #2 "dir"', 'as installed on laptop: ask there with machine policy allow --list (remote view: machine requests/policy views are not built yet)']);
  });

  it('is read-only: no passphrase and no question, and it does not touch the policy record', async () => {
    await setUp([{ shell: 'sh', command: 'ls' }]);
    const forbidden = async (): Promise<string> => {
      throw new Error('a read-only command must not ask anything');
    };
    const r = await cli(a, ['allowed', 'laptop'], forbidden, { ask: forbidden });
    expect(r.code).toBe(0);
  });

  it('a machine with no policy signed here says so and gives the way to see what is installed there', async () => {
    await setUp([{ shell: 'sh', command: 'ls' }]);
    // B never signed anything: it is not the admin, there is nothing on record for the machine "desktop" there.
    const r = await cli(b, ['allowed', 'desktop']);
    expect(r.code).toBe(0);
    expect(r.out).toContain('No policy was signed on this machine for "desktop"');
    expect(r.out).toContain('as installed on desktop: ask there with machine policy allow --list (remote view: machine requests/policy views are not built yet)');
  });

  it('this machine: the installed policy and its mode', async () => {
    await setUp([{ shell: 'sh', command: 'ls' }]);
    const r = await cli(b, ['allowed', 'laptop']);
    expect(r.code).toBe(0);
    expect(r.out).toContain('Allowed on this machine "laptop" (installed policy version 1, mode admin)');
    expect(r.out).toContain('      #1 "ls"');
    expect(r.out).not.toContain('as installed on');
  });

  it('--json: one document', async () => {
    await setUp([{ shell: 'sh', command: 'ls' }]);
    const r = await cli(a, ['allowed', 'laptop', '--json']);
    const doc = JSON.parse(r.out) as { name: string; source: string; version: number; defaults: Array<{ shell: string; command: string }>; issuedAt: number };
    expect(doc).toMatchObject({ name: 'laptop', source: 'signed-here', version: 1, defaults: [{ shell: 'sh', command: 'ls' }] });
    expect(typeof doc.issuedAt).toBe('number');
  });

  it('an unknown machine is exit 3, a missing argument is exit 2', async () => {
    await setUp([{ shell: 'sh', command: 'ls' }]);
    expect((await cli(a, ['allowed', 'nobody'])).code).toBe(3);
    const none = await cli(a, ['allowed']);
    expect(none.code).toBe(2);
    expect(none.err).toMatch(/usage: machine allowed <machine>/);
  });
});
