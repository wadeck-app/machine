import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { finalCode } from '@wadeck-app/machine-core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { adminPinFile, pinAdminKey, readAdminPin } from './admin.js';
import { startFakeRelay, type FakeRelay } from './fakeRelay.js';
import { readMachine } from './identity.js';
import { exportMachineInfo, loadNetwork } from './network.js';
import { candidacyFile, readCandidacy, readRelayConfig } from './relayStore.js';
import { buildApproval, cli, fakeTiming, makeAdmin, ok, type TestAdmin } from './testing.js';

let root: string;
let cand: string;
let adminDir: string;
let peerDir: string;
let relay: FakeRelay;
let admin: TestAdmin;

const yes = async () => 'y';
const no = async () => 'n';
const noTty = async (): Promise<string> => {
  throw new Error('no tty');
};
const approvalFor = (options?: Parameters<typeof buildApproval>[2]) => buildApproval(admin, cand, options);
const runJoinCli = (args: string[] = [], io: Parameters<typeof cli>[3] = {}) => cli(cand, ['join', '12345678', '--relay', relay.url, ...args], undefined, io);
const resume = (args: string[] = [], io: Parameters<typeof cli>[3] = {}) => cli(cand, ['join', '--resume', ...args], undefined, io);
/** The admin approves the first pending candidacy the first time the candidate sleeps. */
const approveOnFirstSleep = (approval: unknown) =>
  fakeTiming((_ms, n) => {
    if (n === 1) relay.approve(relay.pendingIds()[0] as string, approval);
  });
const lastCodeLine = (out: string): string => [...out.matchAll(/^ {2}([0-9A-Z]{4}(?:-[0-9A-Z]{4}){3})$/gm)].at(-1)?.[1] as string;
const noToken = (...texts: string[]) => expect(texts.join('\n')).not.toContain(relay.token);

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'machine-enroll-'));
  cand = join(root, 'cand');
  adminDir = join(root, 'admin');
  peerDir = join(root, 'peer');
  for (const d of [cand, adminDir, peerDir]) mkdirSync(d);
  relay = await startFakeRelay();
  await ok(cand, ['init', '--name', 'laptop']);
  await ok(peerDir, ['init', '--name', 'desktop']);
  admin = makeAdmin(adminDir);
});
afterEach(async () => {
  await relay.close();
  rmSync(root, { recursive: true, force: true });
});

describe('machine join: waiting for the approval and enrolling', () => {
  it('approved: prints the final code alone on its line, pins after a y, imports the peers, cleans up, never prints the token', async () => {
    const timing = approveOnFirstSleep(await approvalFor({ peerDirs: [peerDir] }));
    const asked: string[] = [];
    const r = await runJoinCli([], { timing, ask: async (label) => (asked.push(label), 'y') });
    expect(r.code, r.err).toBe(0);

    const id = [...relay.candidacies.keys()][0] as string;
    const random = relay.candidacies.get(id)?.random as string;
    const expected = finalCode(readMachine(cand).identity.publicKey, admin.adminPublicKey, random);
    expect(r.out.split('\n')).toContain(`  ${expected}`);
    expect(asked).toHaveLength(1);
    expect(asked[0]).toContain(admin.adminKeyId);

    expect(readAdminPin(cand).adminKeyId).toBe(admin.adminKeyId);
    const network = loadNetwork(cand, Math.floor(Date.now() / 1000));
    expect(network.directory.machines().map((m) => m.name)).toEqual(['desktop']);
    expect(r.out).toContain(admin.adminKeyId);
    expect(r.out).toContain('desktop');
    // The candidacy (and the approval it held) is gone, the token stays.
    expect(existsSync(candidacyFile(cand))).toBe(false);
    expect(readRelayConfig(cand)?.token).toBe(relay.token);
    noToken(r.out, r.err);
  });

  it('--json: stdout is one JSON document with the enrollment, the human text goes to stderr', async () => {
    const timing = approveOnFirstSleep(await approvalFor({ peerDirs: [peerDir] }));
    const r = await runJoinCli(['--json'], { timing, ask: yes });
    expect(r.code, r.err).toBe(0);
    const parsed = JSON.parse(r.out) as { adminKeyId: string; finalCode: string; peers: { name: string }[] };
    expect(parsed.adminKeyId).toBe(admin.adminKeyId);
    expect(parsed.peers.map((p) => p.name)).toEqual(['desktop']);
    expect(r.err).toContain(parsed.finalCode);
    noToken(r.out, r.err);
  });

  it('an answer other than y pins nothing and keeps the approval', async () => {
    const timing = approveOnFirstSleep(await approvalFor());
    const r = await runJoinCli([], { timing, ask: no });
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/NOT pinned/);
    expect(existsSync(adminPinFile(cand))).toBe(false);
    expect(readCandidacy(cand)?.approval).toBeDefined();
  });

  it('no terminal and no flag: fails with the final code and the fix, pins nothing, then --resume --yes-final-code enrolls without asking', async () => {
    const timing = approveOnFirstSleep(await approvalFor({ peerDirs: [peerDir] }));
    const first = await runJoinCli([], { timing, ask: noTty });
    expect(first.code).toBe(1);
    expect(first.err).toMatch(/--yes-final-code/);
    expect(existsSync(adminPinFile(cand))).toBe(false);
    const code = lastCodeLine(first.out);
    expect(first.err).toContain(code);
    noToken(first.out, first.err);

    // The relay is not needed any more: the approval was kept locally.
    const before = relay.requests.length;
    const second = await resume(['--yes-final-code', code.toLowerCase().replaceAll('-', ' ')], { ask: noTty, timing: fakeTiming() });
    expect(second.code, second.err).toBe(0);
    expect(relay.requests.length).toBe(before);
    expect(readAdminPin(cand).adminKeyId).toBe(admin.adminKeyId);
    expect(loadNetwork(cand, Math.floor(Date.now() / 1000)).directory.machines()).toHaveLength(1);
    expect(existsSync(candidacyFile(cand))).toBe(false);
  });

  it('a wrong --yes-final-code is refused: nothing pinned, approval kept', async () => {
    const timing = approveOnFirstSleep(await approvalFor({ peerDirs: [peerDir] }));
    const r = await runJoinCli(['--yes-final-code', '0000-0000-0000-0000'], { timing, ask: yes });
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/does not match/);
    expect(r.err).toMatch(/swapped/);
    expect(existsSync(adminPinFile(cand))).toBe(false);
    expect(loadNetwork(cand, Math.floor(Date.now() / 1000)).directory.machines()).toHaveLength(0);
    expect(readCandidacy(cand)?.approval).toBeDefined();
  });

  it('a relay that swaps the whole approval for one signed by its own key: it verifies, but the final code differs from the real admin one', async () => {
    const attacker = makeAdmin(join(root, 'attacker'));
    const timing = approveOnFirstSleep(await buildApproval(attacker, cand));
    const r = await runJoinCli([], { timing, ask: no });
    expect(r.code).toBe(1);
    expect(existsSync(adminPinFile(cand))).toBe(false);
    const random = [...relay.candidacies.values()][0]?.random as string;
    const key = readMachine(cand).identity.publicKey;
    expect(lastCodeLine(r.out)).toBe(finalCode(key, attacker.adminPublicKey, random));
    expect(lastCodeLine(r.out)).not.toBe(finalCode(key, admin.adminPublicKey, random));
  });

  it('rejected: exit 1, token kept, candidacy forgotten', async () => {
    const timing = fakeTiming((_ms, n) => {
      if (n === 1) relay.reject(relay.pendingIds()[0] as string);
    });
    const r = await runJoinCli([], { timing, ask: yes });
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/rejected/);
    expect(r.err).toMatch(/--resume/);
    expect(readRelayConfig(cand)?.token).toBe(relay.token);
    expect(existsSync(candidacyFile(cand))).toBe(false);
    noToken(r.out, r.err);
  });

  it('timeout: exit 1, token and candidacy kept, tells to resume until expiresAt', async () => {
    const timing = fakeTiming();
    const r = await runJoinCli(['--timeout', '60'], { timing, ask: yes });
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/no decision after 60 s/);
    expect(r.err).toMatch(/machine join --resume/);
    expect(r.err).toMatch(/valid until 20\d\d-/);
    expect(readCandidacy(cand)?.id).toBeDefined();
    expect(readRelayConfig(cand)?.token).toBe(relay.token);
    // Polls every 3 s, and stops at the deadline.
    expect(timing.sleeps.reduce((a, b) => a + b, 0)).toBe(60_000);
    noToken(r.out, r.err);
  });

  it('Ctrl-C: exit 1, token and candidacy kept, tells to resume', async () => {
    const controller = new AbortController();
    const timing = { ...fakeTiming((_ms, n) => n === 2 && controller.abort()), signal: controller.signal };
    const r = await runJoinCli([], { timing, ask: yes });
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/interrupted/);
    expect(r.err).toMatch(/machine join --resume/);
    expect(readCandidacy(cand)).toBeDefined();
  });

  it('expired while waiting: says so, then --resume posts a fresh candidacy (new random, same name and key) and enrolls', async () => {
    const approval = await approvalFor();
    const expiring = fakeTiming((_ms, n) => {
      if (n === 1) relay.expire(relay.pendingIds()[0] as string);
    });
    const first = await runJoinCli([], { timing: expiring, ask: yes });
    expect(first.code).toBe(1);
    expect(first.err).toMatch(/expired/);
    expect(first.err).toMatch(/machine join --resume/);
    expect(relay.candidacies.size).toBe(0);

    const posts = relay.requests.filter((q) => q.method === 'POST' && q.path === '/api/machines/candidacies');
    const second = await resume([], { timing: approveOnFirstSleep(approval), ask: yes });
    expect(second.code, second.err).toBe(0);
    const reposts = relay.requests.filter((q) => q.method === 'POST' && q.path === '/api/machines/candidacies');
    expect(reposts).toHaveLength(posts.length + 1);
    const firstBody = posts[0]?.body as Record<string, string>;
    const secondBody = reposts.at(-1)?.body as Record<string, string>;
    expect(secondBody.random).not.toBe(firstBody.random);
    expect(secondBody.identityPublicKey).toBe(firstBody.identityPublicKey);
    expect(secondBody.name).toBe(firstBody.name);
    expect(readAdminPin(cand).adminKeyId).toBe(admin.adminKeyId);
  });

  it('--resume after a timeout with the candidacy expired meanwhile: warns, posts a new one, announces the new code', async () => {
    const approval = await approvalFor();
    const first = await runJoinCli(['--timeout', '9'], { timing: fakeTiming(), ask: yes });
    expect(first.code).toBe(1);
    const oldId = readCandidacy(cand)?.id as string;
    relay.expire(oldId);

    const second = await resume([], { timing: approveOnFirstSleep(approval), ask: yes });
    expect(second.code, second.err).toBe(0);
    expect(second.out + second.err).toMatch(/previous candidacy expired/);
    expect(relay.candidacies.has(oldId)).toBe(false);
  });

  it('429 on the poll: waits the Retry-After of the relay, then goes on', async () => {
    const approval = await approvalFor();
    relay.force('/api/machines/candidacies/', 429, { success: false, error: 'too_many_requests', message: 'slow down' }, { 'Retry-After': '7' }, 'GET');
    const timing = fakeTiming((_ms, n) => {
      if (n === 2) relay.approve(relay.pendingIds()[0] as string, approval);
    });
    const r = await runJoinCli([], { timing, ask: yes });
    expect(r.code, r.err).toBe(0);
    expect(timing.sleeps[0]).toBe(7000);
    expect(timing.sleeps[1]).toBe(3000);
    expect(r.out + r.err).toMatch(/rate limiting/);
  });

  it('a relay hiccup (503) while waiting is reported and retried, not fatal', async () => {
    const approval = await approvalFor();
    relay.force('/api/machines/candidacies/', 503, { success: false, error: 'store_unavailable', message: 'down' }, {}, 'GET');
    const timing = fakeTiming((_ms, n) => {
      if (n === 2) relay.approve(relay.pendingIds()[0] as string, approval);
    });
    const r = await runJoinCli([], { timing, ask: yes });
    expect(r.code, r.err).toBe(0);
    expect(r.out + r.err).toMatch(/\[warn\].*retrying/);
  });

  it('a revoked token while waiting stops with the relay message and keeps the candidacy file', async () => {
    relay.force('/api/machines/candidacies/', 401, { success: false, error: 'unauthorized', message: 'revoked' }, {}, 'GET');
    const r = await runJoinCli([], { timing: fakeTiming(), ask: yes });
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/refused the stored token/);
    noToken(r.out, r.err);
  });
});

describe('machine join: approvals that must be refused', () => {
  const refused = async (approval: unknown, pattern: RegExp) => {
    const r = await runJoinCli([], { timing: approveOnFirstSleep(approval), ask: yes });
    expect(r.code).toBe(1);
    expect(r.err).toMatch(pattern);
    expect(r.err).toMatch(/Nothing was pinned/);
    expect(existsSync(adminPinFile(cand))).toBe(false);
    expect(loadNetwork(cand, Math.floor(Date.now() / 1000)).directory.machines()).toHaveLength(0);
    // Useless, so forgotten: `--resume` posts a new candidacy.
    expect(existsSync(candidacyFile(cand))).toBe(false);
    noToken(r.out, r.err);
  };

  it('for another machine', async () => {
    await refused(await approvalFor({ selfInfo: exportMachineInfo(peerDir) }), /registers another machine/);
  });

  it('with a tampered signature (swapped key)', async () => {
    const approval = (await approvalFor()) as { self: { registration: { signature: string; body: { identityPublicKey: string } } } };
    const sig = approval.self.registration.signature;
    approval.self.registration.signature = `${sig[0] === 'A' ? 'B' : 'A'}${sig.slice(1)}`;
    await refused(approval, /invalid signature/);
  });

  it('whose registration binds another key than the one of this machine', async () => {
    const approval = (await approvalFor()) as { self: { registration: { body: { identityPublicKey: string } } } };
    approval.self.registration.body.identityPublicKey = readMachine(peerDir).identity.publicKey;
    await refused(approval, /invalid signature|another machine/);
  });

  it('carrying an admin key that did not sign the registration', async () => {
    const other = makeAdmin(join(root, 'other'));
    const approval = (await approvalFor()) as { admin: unknown };
    approval.admin = { v: 1, adminPublicKey: other.adminPublicKey, adminKeyId: other.adminKeyId };
    await refused(approval, /certified by admin key/);
  });

  it('with a peer registration signed by another admin', async () => {
    const other = makeAdmin(join(root, 'other'));
    const forgedPeer = (await buildApproval(other, cand, { peerDirs: [peerDir] })) as { peers: unknown[] };
    const approval = (await approvalFor()) as { peers: unknown[] };
    approval.peers = forgedPeer.peers;
    await refused(approval, /peer #1 of the approval was refused/);
  });

  it('that is not an approval at all, or has an unknown field', async () => {
    await refused('garbage', /not a JSON object/);
  });

  it('with an unknown field', async () => {
    const approval = (await approvalFor()) as Record<string, unknown>;
    approval.extra = 1;
    await refused(approval, /unknown field "extra"/);
  });
});

describe('machine join: other rules', () => {
  it('another admin key already pinned: refused before any question, nothing changes', async () => {
    const other = makeAdmin(join(root, 'other'));
    pinAdminKey(cand, adminPinFile(other.dir));
    const timing = approveOnFirstSleep(await approvalFor());
    const r = await runJoinCli([], {
      timing,
      ask: async () => {
        throw new Error('must not be asked');
      },
    });
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/already trusts another admin key/);
    expect(readAdminPin(cand).adminKeyId).toBe(other.adminKeyId);
  });

  it('the same admin key already pinned: enrolls without asking again', async () => {
    pinAdminKey(cand, adminPinFile(admin.dir));
    const timing = approveOnFirstSleep(await approvalFor({ peerDirs: [peerDir] }));
    const r = await runJoinCli([], { timing, ask: noTty });
    expect(r.code, r.err).toBe(0);
    expect(loadNetwork(cand, Math.floor(Date.now() / 1000)).directory.machines()).toHaveLength(1);
  });

  it('--resume without a saved token: names the fix, sends nothing', async () => {
    const r = await resume([], { timing: fakeTiming(), ask: yes });
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/machine join <code>/);
    expect(relay.requests).toHaveLength(0);
  });

  it('--resume with a code, --resume with --force, a bad --timeout, --yes-final-code with --no-wait: usage errors', async () => {
    expect((await cli(cand, ['join', '--resume', '12345678'])).code).toBe(2);
    expect((await cli(cand, ['join', '--resume', '--force'])).code).toBe(2);
    expect((await runJoinCli(['--timeout', '0'])).code).toBe(2);
    expect((await runJoinCli(['--timeout', 'abc'])).code).toBe(2);
    expect((await runJoinCli(['--no-wait', '--yes-final-code', 'AAAA'])).code).toBe(2);
    expect(relay.requests).toHaveLength(0);
  });

  it('--resume with another --relay than the saved token: refused', async () => {
    await ok(cand, ['join', '12345678', '--relay', relay.url, '--no-wait']);
    const r = await resume(['--relay', 'https://other.example'], { timing: fakeTiming(), ask: yes });
    expect(r.code).toBe(1);
    expect(r.err).toContain(relay.url);
  });

  it('--no-wait then --resume picks the same candidacy up (no second post) and enrolls', async () => {
    await ok(cand, ['join', '12345678', '--relay', relay.url, '--no-wait']);
    const saved = readCandidacy(cand);
    expect(saved?.id).toBe([...relay.candidacies.keys()][0]);
    const posts = () => relay.requests.filter((q) => q.method === 'POST' && q.path === '/api/machines/candidacies').length;
    const r = await resume([], { timing: approveOnFirstSleep(await approvalFor()), ask: yes });
    expect(r.code, r.err).toBe(0);
    expect(posts()).toBe(1);
    expect(r.out).toContain(saved?.id as string);
  });

  it('the candidacy file is private and holds no token', async () => {
    await ok(cand, ['join', '12345678', '--relay', relay.url, '--no-wait']);
    expect(readFileSync(candidacyFile(cand), 'utf8')).not.toContain(relay.token);
    if (process.platform !== 'win32') {
      const { statSync } = await import('node:fs');
      expect(statSync(candidacyFile(cand)).mode & 0o077).toBe(0);
    }
  });
});
