import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SignedPolicy } from '@wadeck-app/machine-core';
import { startMachineDaemon } from './daemonEntry.js';
import { startFakeRelay, type FakeRelay } from './fakeRelay.js';
import { readMachine } from './identity.js';
import { loadNetwork } from './network.js';
import { cli, provision } from './testing.js';

// Policy mode `local` (hard rule 4 as amended): the machine manages its own allow list with its own policy key.
// A is the admin machine ("desktop"), B is "laptop": it starts in mode admin with one entry signed by the admin.

const SHELL = process.platform === 'win32' ? 'cmd' : 'sh';
const LOCAL_PASS = 'local passphrase for the laptop';
const yes = async () => 'y';
const no = async () => 'n';
const nowSeconds = () => Math.floor(Date.now() / 1000);

let root: string;
let a: string;
let b: string;
let adminPass = '';

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'machine-policy-local-'));
  a = join(root, 'a');
  b = join(root, 'b');
  adminPass = await provision(root, a, b, [{ shell: SHELL, command: 'echo admin entry' }]);
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** Answers the passphrase prompts of the local key by label: records every label asked. */
function typed(passphrases: string[], labels: string[] = []): (label: string) => Promise<string> {
  const queue = [...passphrases];
  return async (label) => {
    labels.push(label);
    const next = queue.shift();
    if (next === undefined) throw new Error(`unexpected prompt: ${label}`);
    return next;
  };
}
const enable = (extra: string[] = [], pass = [LOCAL_PASS, LOCAL_PASS], ask = yes) => cli(b, ['policy', 'local', 'enable', ...extra], typed(pass), { ask: async (l) => (l.includes('Hint') ? '' : ask()) });
const allow = (args: string[], ask: (l: string) => Promise<string> = yes, pass: string[] = [LOCAL_PASS]) => cli(b, ['policy', 'allow', ...args], typed(pass), { ask });
const modeOf = (dir: string) => loadNetwork(dir, nowSeconds()).policyMode;

describe('machine policy local enable', () => {
  it('generates the policy key, asks the passphrase twice, pins its public key, records the mode, shows the key id and says the list starts EMPTY', async () => {
    expect(modeOf(b)).toBe('admin');
    expect(loadNetwork(b, nowSeconds()).policy?.version).toBe(1);
    const labels: string[] = [];
    const r = await cli(b, ['policy', 'local', 'enable'], typed([LOCAL_PASS, LOCAL_PASS], labels), { ask: async (l) => (l.includes('Hint') ? 'the usual one' : 'y') });
    expect(r.code, r.err).toBe(0);
    expect(labels).toEqual(['Local policy passphrase: ', 'Confirm passphrase: ']);
    expect(r.out).toMatch(/policy key id: [0-9a-f]{32}/);
    expect(r.out).toMatch(/EMPTY/);
    expect(r.out).toContain('echo admin entry');
    expect(modeOf(b)).toBe('local');
    expect(loadNetwork(b, nowSeconds()).policy).toBeUndefined();
    const keyFile = join(b, '_secrets_', 'policy.key.json');
    const envelope = JSON.parse(readFileSync(keyFile, 'utf8')) as { v: number; hint?: string; publicKey: string };
    expect(envelope).toMatchObject({ v: 2, hint: 'the usual one' });
    const modeFile = JSON.parse(readFileSync(join(b, 'policy-mode.json'), 'utf8')) as { mode: string; localPublicKey: string; localKeyId: string };
    expect(modeFile).toMatchObject({ mode: 'local', localPublicKey: envelope.publicKey });
    expect(r.out).toContain(modeFile.localKeyId);
    // The passphrase is never printed.
    expect(r.out + r.err).not.toContain(LOCAL_PASS);
  });

  it('refuses when the machine is already local, before asking anything', async () => {
    await enable();
    const r = await cli(b, ['policy', 'local', 'enable'], typed([]), { ask: async () => { throw new Error('no question expected'); } });
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/already manages its own allow list/);
    expect(r.err).toMatch(/machine policy delegate/);
  });

  it('asks again after a mismatch or a short passphrase (3 attempts), then fails creating nothing', async () => {
    const r = await enable([], ['too short', 'x', 'y']);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/at least 12 characters/);
    expect(r.err).not.toMatch(/admin init/);
    expect(r.err).toMatch(/Nothing was created/);
    expect(existsSync(join(b, '_secrets_', 'policy.key.json'))).toBe(false);
    expect(modeOf(b)).toBe('admin');
    const mismatch = await enable([], [LOCAL_PASS, 'another passphrase here', LOCAL_PASS, LOCAL_PASS]);
    expect(mismatch.code, mismatch.err).toBe(0);
    expect(mismatch.err).toMatch(/do not match/);
    expect(modeOf(b)).toBe('local');
  });

  it('refuses a hint that gives the passphrase away, or an empty passphrase, creating nothing', async () => {
    const hint = await enable(['--hint', LOCAL_PASS]);
    expect(hint.code).toBe(1);
    expect(hint.err).toMatch(/hint contains the passphrase/);
    expect(modeOf(b)).toBe('admin');
    const empty = await enable([], ['']);
    expect(empty.code).toBe(1);
    expect(empty.err).toMatch(/passphrase is required/);
    expect(modeOf(b)).toBe('admin');
  });

  it('asks y/N when an admin-signed list is in force and keeps everything when the answer is no', async () => {
    const r = await enable([], [LOCAL_PASS, LOCAL_PASS], no);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/not confirmed/);
    expect(modeOf(b)).toBe('admin');
    expect(loadNetwork(b, nowSeconds()).policy?.version).toBe(1);
  });

  it('is refused when a local policy key file is already there while the mode is admin (an interrupted delegate), naming the file', async () => {
    writeFileSync(join(b, '_secrets_', 'policy.key.json'), '{}');
    const r = await enable();
    expect(r.code).toBe(1);
    expect(r.err).toContain('policy.key.json');
    expect(r.err).toMatch(/move|archive|delete/);
  });
});

describe('machine policy allow (mode local)', () => {
  beforeEach(async () => {
    expect((await enable()).code).toBe(0);
  });

  it('shows the difference, asks y/N then the LOCAL passphrase, signs with the local key and installs without any relay', async () => {
    const asked: string[] = [];
    const labels: string[] = [];
    const r = await cli(b, ['policy', 'allow', '--shell', SHELL, '--', 'echo', 'hello'], typed([LOCAL_PASS], labels), { ask: async (l) => (asked.push(l), 'y') });
    expect(r.code, r.err).toBe(0);
    expect(r.out).toMatch(/Policy for this machine "laptop"/);
    expect(r.out).toMatch(/version 0 -> 1/);
    expect(r.out).toContain(`+ ${SHELL}  "echo hello"`);
    expect(asked).toHaveLength(1);
    expect(labels).toEqual(['Local policy passphrase: ']);
    expect(r.out).toMatch(/\[ok\] policy version 1 signed with the local policy key and installed/);
    const policy = loadNetwork(b, nowSeconds()).policy;
    expect(policy?.version).toBe(1);
    expect(policy?.defaults).toEqual([{ shell: SHELL, command: 'echo hello' }]);
    // The policy of the admin line is untouched.
    expect(JSON.parse(readFileSync(join(b, 'policy.json'), 'utf8')).body.version).toBe(1);
  });

  it('ends with the exact `machine run` a PEER types: the shell is named, because the peer may run another platform (decision 71)', async () => {
    const r = await allow(['--shell', 'sh', '--', 'ls -la']);
    expect(r.code, r.err).toBe(0);
    expect(r.out).toContain('Then, from another machine: machine run laptop --shell sh -- "ls -la" (or make sh its default there: machine peer connect laptop --shell sh)');
    // A removal has nothing to run.
    const removed = await allow(['--remove', '--shell', 'sh', '--', 'ls -la']);
    expect(removed.out).not.toContain('Then, from another machine');
  });

  it('the shell defaults to the platform of THIS machine and says so', async () => {
    const r = await allow(['--', 'whoami']);
    expect(r.code, r.err).toBe(0);
    expect(r.out).toMatch(/shell "(cmd|sh)" chosen from this machine's platform/);
    expect(loadNetwork(b, nowSeconds()).policy?.defaults[0]?.shell).toBe(SHELL);
  });

  it('the next version is version + 1 edited from the current one (T-16), and --remove withdraws an entry', async () => {
    await allow(['--', 'whoami']);
    const second = await allow(['--', 'hostname']);
    expect(second.out).toMatch(/version 1 -> 2/);
    const removed = await allow(['--remove', '--', 'whoami']);
    expect(removed.code, removed.err).toBe(0);
    expect(removed.out).toContain(`- ${SHELL}  "whoami"`);
    const policy = loadNetwork(b, nowSeconds()).policy;
    expect(policy?.version).toBe(3);
    expect(policy?.defaults.map((e) => e.command)).toEqual(['hostname']);
  });

  it('a wrong passphrase installs nothing, an answer no signs nothing, a repeat is "already allowed"', async () => {
    const wrong = await allow(['--', 'whoami'], yes, ['not the passphrase of the key']);
    expect(wrong.code).toBe(1);
    expect(wrong.err).toMatch(/local policy key file: wrong passphrase or damaged key file/);
    expect(loadNetwork(b, nowSeconds()).policy).toBeUndefined();
    const declined = await allow(['--', 'whoami'], no, []);
    expect(declined.code).toBe(1);
    expect(declined.err).toMatch(/not confirmed/);
    await allow(['--', 'whoami']);
    const again = await allow(['--', 'whoami'], yes, []);
    expect(again.code).toBe(0);
    expect(again.out).toMatch(/already allowed/);
  });

  it('--list reads without any passphrase and shows the mode', async () => {
    await allow(['--', 'whoami']);
    const r = await cli(b, ['policy', 'allow', '--list'], async () => { throw new Error('no passphrase for --list'); });
    expect(r.code, r.err).toBe(0);
    expect(r.out).toMatch(/Allowed on this machine "laptop" \(policy version 1, managed locally\)/);
    expect(r.out).toContain('whoami');
  });

  it('--peer edits the own list of a registered peer; an unknown peer is refused', async () => {
    const r = await allow(['--peer', 'desktop', '--shell', SHELL, '--', 'echo only desktop']);
    expect(r.code, r.err).toBe(0);
    const policy = loadNetwork(b, nowSeconds()).policy;
    const desktop = readMachine(a).uuid;
    expect(policy?.peers[desktop]).toEqual([{ shell: SHELL, command: 'echo only desktop' }]);
    expect(policy?.defaults).toEqual([]);
    const unknown = await allow(['--peer', 'nas', '--', 'whoami'], yes, []);
    expect(unknown.code).toBe(3);
    expect(unknown.err).toMatch(/nas/);
  });

  it('a command with words that need quoting is refused like admin allow', async () => {
    const r = await allow(['--', 'grep', 'foo bar', 'file'], yes, []);
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/ONE quoted argument/);
  });
});

describe('machine policy allow (mode admin)', () => {
  it('refuses to edit with the two ways out, and does not ask anything', async () => {
    const r = await cli(b, ['policy', 'allow', '--', 'whoami'], typed([]), { ask: async () => { throw new Error('no question expected'); } });
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/managed by the admin/);
    expect(r.err).toContain('machine admin allow laptop');
    expect(r.err).toContain('machine policy local enable');
  });

  it('--list is read-only and works in mode admin', async () => {
    const r = await cli(b, ['policy', 'allow', '--list']);
    expect(r.code, r.err).toBe(0);
    expect(r.out).toMatch(/managed by the admin/);
    expect(r.out).toContain('echo admin entry');
  });
});

describe('refusals between the two modes', () => {
  const adminPolicyFile = (): string => join(b, 'policy.json');

  it('mode local: an admin-signed policy given to `policy install` is refused with the delegate advice and nothing changes', async () => {
    const signed = JSON.parse(readFileSync(adminPolicyFile(), 'utf8')) as SignedPolicy;
    await enable();
    await allow(['--', 'whoami']);
    const file = join(root, 'admin-v2.json');
    const next = { ...signed, body: { ...signed.body, version: 2, baseVersion: 1 } };
    writeFileSync(file, JSON.stringify(next));
    const r = await cli(b, ['policy', 'install', file]);
    expect(r.code).not.toBe(0);
    expect(r.err).toContain('this machine manages its own allow list (machine policy delegate to give it back to the admin)');
    expect(loadNetwork(b, nowSeconds()).policy?.defaults.map((e) => e.command)).toEqual(['whoami']);
  });

  it('mode admin: a locally-signed policy is refused too', async () => {
    await enable();
    await allow(['--', 'whoami']);
    const local = join(root, 'local-v1.json');
    writeFileSync(local, readFileSync(join(b, 'policy-local.json'), 'utf8'));
    // A second laptop in mode admin cannot be provisioned cheaply: the same machine in mode admin again (after delegate) refuses its own old document.
    const delegate = await cli(b, ['policy', 'delegate'], typed([LOCAL_PASS]), { ask: yes });
    expect(delegate.code, delegate.err).toBe(0);
    const r = await cli(b, ['policy', 'install', local]);
    expect(r.code).not.toBe(0);
    expect(r.err).toMatch(/policy refused \(wrong-admin-key\)/);
    expect(r.err).toMatch(/machine policy local enable/);
  });

  it('`machine admin allow` aimed at this machine is refused in mode local, naming `machine policy allow`', async () => {
    // The admin machine itself switches to mode local.
    const r1 = await cli(a, ['policy', 'local', 'enable'], typed([LOCAL_PASS, LOCAL_PASS]), { ask: async (l) => (l.includes('Hint') ? '' : 'y') });
    expect(r1.code, r1.err).toBe(0);
    const r = await cli(a, ['admin', 'allow', 'desktop', '--', 'whoami'], async () => adminPass, { ask: yes });
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/manages its own allow list/);
    expect(r.err).toContain('machine policy allow');
  });
});

describe('machine policy delegate', () => {
  it('is refused in mode admin', async () => {
    const r = await cli(b, ['policy', 'delegate'], typed([]), { ask: yes });
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/already managed by the admin/);
  });

  it('says the list becomes EMPTY, asks y/N and the local passphrase, archives the key, and the next admin-signed policy is accepted again', async () => {
    await enable();
    await allow(['--', 'whoami']);
    const labels: string[] = [];
    const asked: string[] = [];
    const r = await cli(b, ['policy', 'delegate'], typed([LOCAL_PASS], labels), { ask: async (l) => (asked.push(l), 'y') });
    expect(r.code, r.err).toBe(0);
    expect(labels).toEqual(['Local policy passphrase: ']);
    expect(asked).toHaveLength(1);
    expect(r.out).toMatch(/EMPTY/);
    expect(r.out).toMatch(/archived/);
    expect(modeOf(b)).toBe('admin');
    expect(loadNetwork(b, nowSeconds()).policy).toBeUndefined();
    expect(existsSync(join(b, '_secrets_', 'policy.key.json'))).toBe(false);
    expect(readdirSync(join(b, '_secrets_')).some((f) => f.startsWith('policy.key.json.archived-'))).toBe(true);
    // The admin signs the next version from what it recorded (version 1): it is accepted, its list is what applies.
    const sign = await cli(a, ['admin', 'allow', 'laptop', '--out', join(root, 'next.json'), '--shell', SHELL, '--', 'echo', 'back'], async () => adminPass, { ask: yes });
    expect(sign.code, sign.err).toBe(0);
    const installed = await cli(b, ['policy', 'install', join(root, 'next.json')]);
    expect(installed.code, installed.err).toBe(0);
    expect(loadNetwork(b, nowSeconds()).policy?.defaults.map((e) => e.command)).toEqual(['echo admin entry', 'echo back']);
  });

  it('a wrong local passphrase or an answer no changes nothing', async () => {
    await enable();
    const wrong = await cli(b, ['policy', 'delegate'], typed(['definitely not the passphrase']), { ask: yes });
    expect(wrong.code).toBe(1);
    expect(wrong.err).toMatch(/wrong passphrase/);
    expect(modeOf(b)).toBe('local');
    const declined = await cli(b, ['policy', 'delegate'], typed([]), { ask: no });
    expect(declined.code).toBe(1);
    expect(declined.err).toMatch(/not confirmed/);
    expect(modeOf(b)).toBe('local');
  });

  it('after delegate, a local policy can be enabled again with a new key and the versions go on (a stale local document stays refused)', async () => {
    await enable();
    await allow(['--', 'whoami']);
    const oldDoc = readFileSync(join(b, 'policy-local.json'), 'utf8');
    await cli(b, ['policy', 'delegate'], typed([LOCAL_PASS]), { ask: yes });
    expect((await enable()).code).toBe(0);
    const r = await allow(['--', 'hostname']);
    expect(r.code, r.err).toBe(0);
    expect(r.out).toMatch(/version 1 -> 2/);
    const file = join(root, 'old-local.json');
    writeFileSync(file, oldDoc);
    const stale = await cli(b, ['policy', 'install', file]);
    expect(stale.code).not.toBe(0);
    expect(stale.err).toMatch(/policy refused/);
    expect(loadNetwork(b, nowSeconds()).policy?.defaults.map((e) => e.command)).toEqual(['hostname']);
  });
});

describe('machine status and machine list show the policy mode', () => {
  it('status shows the mode and the key id of the local policy key; --json carries them', async () => {
    const admin = await cli(b, ['status']);
    expect(admin.out).toMatch(/policy mode: admin \(allow list signed by the admin\)/);
    await enable();
    const local = await cli(b, ['status']);
    expect(local.out).toMatch(/policy mode: local \(this machine manages its own allow list, policy key [0-9a-f]{32}\)/);
    expect(local.out).toMatch(/no policy \(every command is refused\)/);
    const json = JSON.parse((await cli(b, ['status', '--json'])).out) as { policyMode: string; localPolicyKeyId: string };
    expect(json.policyMode).toBe('local');
    expect(json.localPolicyKeyId).toMatch(/^[0-9a-f]{32}$/);
  });

  it('list shows the mode of this machine and says the mode of a peer is not known', async () => {
    await enable();
    const r = await cli(b, ['list']);
    expect(r.out).toMatch(/laptop .*\[this machine\].*policy: local/);
    expect(r.out).toMatch(/desktop .*policy: unknown/);
  });
});

describe('two daemons: a local-mode target', () => {
  let relay: FakeRelay | undefined;
  const stoppers: Array<() => Promise<void>> = [];
  afterEach(async () => {
    while (stoppers.length > 0) await stoppers.pop()?.();
    await relay?.close();
  });

  it('accepts its own signed policy and runs an allowed command, refuses an admin-signed policy, and after delegate accepts the admin one', async () => {
    const daemon = await startMachineDaemon(b, { port: 0, version: 'e2e', peerPort: 0, peerHost: '127.0.0.1', log: () => undefined });
    stoppers.push(daemon.stop);
    const address = `127.0.0.1:${daemon.peerPort}`;
    const run = (word: string) => cli(a, ['run', 'laptop', '--address', address, '--shell', SHELL, '--', 'echo', word]);

    // Mode admin: the entry signed by the admin runs (a single word "echo admin entry" needs the exact string).
    const first = await cli(a, ['run', 'laptop', '--address', address, '--shell', SHELL, '--', 'echo admin entry']);
    expect(first.code, first.err).toBe(0);

    // Mode local: the list starts EMPTY, then the machine allows its own command.
    expect((await enable()).code).toBe(0);
    const refused = await cli(a, ['run', 'laptop', '--address', address, '--shell', SHELL, '--', 'echo admin entry']);
    expect(refused.code).toBe(255);
    expect(refused.err).toMatch(/no-policy|not-listed|no policy/);
    expect((await allow(['--shell', SHELL, '--', 'echo local entry'])).code).toBe(0);
    // No wait: the daemon reloads its network as soon as a policy file changes (not after its 5 s cache delay).
    const okRun = await cli(a, ['run', 'laptop', '--address', address, '--shell', SHELL, '--', 'echo local entry']);
    expect(okRun.code, okRun.err).toBe(0);
    expect(okRun.out).toContain('local entry');
    const notListed = await run('other');
    expect(notListed.code).toBe(255);
    expect(notListed.err).toMatch(/not-listed/);
    expect(notListed.err).toMatch(/owner of this machine/);

    // An admin-signed policy is refused by the target in mode local: it changes nothing, the daemon keeps serving its own list.
    const adminDoc = join(root, 'admin-next.json');
    const signed = await cli(a, ['admin', 'allow', 'laptop', '--out', adminDoc, '--shell', SHELL, '--', 'echo admin new'], async () => adminPass, { ask: yes });
    expect(signed.code, signed.err).toBe(0);
    const refusedInstall = await cli(b, ['policy', 'install', adminDoc]);
    expect(refusedInstall.code).not.toBe(0);
    expect(refusedInstall.err).toContain('machine policy delegate');
    expect((await cli(a, ['run', 'laptop', '--address', address, '--shell', SHELL, '--', 'echo admin new'])).code).toBe(255);
    expect((await cli(a, ['run', 'laptop', '--address', address, '--shell', SHELL, '--', 'echo local entry'])).code).toBe(0);

    // After delegate the local list stops applying (EMPTY), the admin document is accepted, and the old local document stays refused.
    const staleLocal = join(root, 'stale-local.json');
    writeFileSync(staleLocal, readFileSync(join(b, 'policy-local.json'), 'utf8'));
    const delegate = await cli(b, ['policy', 'delegate'], typed([LOCAL_PASS]), { ask: yes });
    expect(delegate.code, delegate.err).toBe(0);
    const emptied = await cli(a, ['run', 'laptop', '--address', address, '--shell', SHELL, '--', 'echo local entry']);
    expect(emptied.code).toBe(255);
    expect(emptied.err).toMatch(/no-policy|no policy/);
    expect((await cli(b, ['policy', 'install', adminDoc])).code).toBe(0);
    const adminRun = await cli(a, ['run', 'laptop', '--address', address, '--shell', SHELL, '--', 'echo admin new']);
    expect(adminRun.code, adminRun.err).toBe(0);
    const stale = await cli(b, ['policy', 'install', staleLocal]);
    expect(stale.code).not.toBe(0);
    expect(stale.err).toMatch(/policy refused/);
    expect((await cli(a, ['run', 'laptop', '--address', address, '--shell', SHELL, '--', 'echo local entry'])).code).toBe(255);
  }, 30_000);
});
