import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { finalCode, openSealed } from '@wadeck-app/machine-core';
import { pairSecretContext } from './approval.js';
import { startMachineDaemon, type RunningDaemon } from './daemonEntry.js';
import { startFakeRelay, type FakeRelay } from './fakeRelay.js';
import { readMachine } from './identity.js';
import { readRelayConfig } from './relayStore.js';
import { makeOrchStub, type OrchStub } from './orchStub.js';
import { cli, fakeTiming, ok } from './testing.js';

// Bootstrap of a network: the very first machine is also the admin machine (candidate == admin), then a second machine
// joins and is approved by the first. Everything through the command line, one fake relay, no shortcut.

const SHELL = process.platform === 'win32' ? 'cmd' : 'sh';
const MACHINE_CODE = '12345678';
const SECOND_CODE = '22223333';
const THIRD_CODE = '33334444';
const ADMIN_CODE = '87654321';
const yes = async () => 'y';
const forbidden = (what: string) => async (): Promise<string> => {
  throw new Error(`${what} must not be asked`);
};

let root: string;
let a: string;
let b: string;
let relay: FakeRelay;
let passphrase: string;
let stub: OrchStub;
let bindMode = false;
const daemons: RunningDaemon[] = [];

const decisions = () => relay.requests.filter((q) => q.method === 'PUT' && q.path.endsWith('/decision'));
const peersOf = (dir: string): { registration: { body: { uuid: string } }; pairSecret: string }[] => {
  const file = join(dir, '_secrets_', 'peers.json');
  return existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as { peers: { registration: { body: { uuid: string } }; pairSecret: string }[] }).peers : [];
};
const approve = (dir: string, id: string, ask: (l: string) => Promise<string> = yes) => cli(dir, ['admin', 'approve', id, '--relay', relay.url], async () => passphrase, { ask });

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'machine-bootstrap-'));
  a = join(root, 'a');
  b = join(root, 'b');
  mkdirSync(a);
  mkdirSync(b);
  stub = makeOrchStub();
  relay = await startFakeRelay({ code: MACHINE_CODE, moreCodes: [SECOND_CODE, THIRD_CODE], adminCode: ADMIN_CODE, bindOwnershipAtApproval: bindMode });
});
afterEach(async () => {
  while (daemons.length > 0) await daemons.pop()?.stop();
  await relay.close();
  rmSync(root, { recursive: true, force: true });
  rmSync(stub.dir, { recursive: true, force: true });
});

/** init, admin init, admin login, join (token and candidacy). Returns the id of the candidacy of the first machine. */
async function firstMachinePosts(): Promise<string> {
  await ok(a, ['init', '--name', 'desktop']);
  const init = await ok(a, ['admin', 'init']);
  passphrase = /passphrase[^\n]*\n\s*([A-Z0-9 -]{20,})/i.exec(init.err)?.[1]?.trim() ?? '';
  expect(passphrase).not.toBe('');
  await ok(a, ['admin', 'login', ADMIN_CODE, '--relay', relay.url]);
  await ok(a, ['join', MACHINE_CODE, '--relay', relay.url, '--no-wait']);
  return relay.pendingIds()[0] as string;
}

describe.each([
  ['relay as deployed', false],
  ['relay that binds the uuid at approval', true],
])('%s', (_label, bind) => {
  beforeAll(() => {
    bindMode = bind;
  });

  describe('the first machine of a network is also its admin machine', () => {
    it('approves its own candidacy: no passphrase typed twice, no error, nothing about a peer', async () => {
      const id = await firstMachinePosts();
      const asked: string[] = [];
      const r = await approve(a, id, async (l) => (asked.push(l), 'y'));
      expect(r.code, r.err).toBe(0);
      expect(r.err).toBe('');
      expect(asked).toHaveLength(1);
      expect(decisions()).toHaveLength(1);
      // The approval carries the registration of this machine and no peer at all (a machine is not its own peer).
      const sent = (decisions()[0]?.body as { approval: { adminUuid: string; self: { registration: { body: { uuid: string } } }; peers: unknown[] } }).approval;
      expect(sent.peers).toEqual([]);
      expect(sent.self.registration.body.uuid).toBe(readMachine(a).uuid);
      expect(sent.adminUuid).toBe(readMachine(a).uuid);
      // Nothing is stored as a peer of itself, and the output says why nothing is compared nor distributed.
      expect(peersOf(a)).toEqual([]);
      expect(r.out).toMatch(/this machine is the admin machine/i);
      expect(r.out).not.toMatch(/machine admin revoke/);
      expect(r.out).not.toMatch(/other peer/);
    });

    it('the final code is shown by approve; join pins nothing a second time and asks nothing; the daemon of the first machine is not told anything', async () => {
      const id = await firstMachinePosts();
      const approved = await approve(a, id);
      expect(approved.code, approved.err).toBe(0);
      const random = (relay.candidacies.get(id) as unknown as { random: string }).random;
      const adminPin = JSON.parse(readFileSync(join(a, 'admin.json'), 'utf8')) as { adminPublicKey: string };
      expect(approved.out).toContain(finalCode(readMachine(a).identity.publicKey, adminPin.adminPublicKey, random));

      const before = readFileSync(join(a, 'admin.json'), 'utf8');
      const joined = await cli(a, ['join', '--resume'], undefined, { timing: fakeTiming(), ask: forbidden('the final code') });
      expect(joined.code, joined.err).toBe(0);
      expect(joined.out).toContain(`[ok] enrolled "desktop" (${readMachine(a).uuid})`);
      // The admin key was created here: it is already pinned, nothing to compare, and the output says so instead of staying silent.
      expect(joined.out).toMatch(/already pinned/);
      expect(joined.out).not.toMatch(/Is this the code/);
      expect(readFileSync(join(a, 'admin.json'), 'utf8')).toBe(before);
      expect(joined.out).toMatch(/no other machine yet: this machine is the first of the network/);
      expect(joined.out).not.toMatch(/peers trusted: none|the admin included none/);
      // The candidacy file is gone: nothing left to resume.
      expect(existsSync(join(a, '_secrets_', 'candidacy.json'))).toBe(false);
    });

    it('status shows enrolled with no peer; list shows only itself; startup status behaves the same before and after', async () => {
      const id = await firstMachinePosts();
      stub.script({ show: { code: 3 } });
      const startupStatus = () => cli(a, ['startup', 'status'], undefined, { startup: { orch: stub.orch, daemon: { platform: 'linux', execPath: '/usr/bin/node', scriptPath: '/opt/machine.cjs', native: false }, platform: 'linux' } });
      const before = await startupStatus();
      expect((await approve(a, id)).code).toBe(0);
      expect((await cli(a, ['join', '--resume'], undefined, { timing: fakeTiming(), ask: forbidden('the final code') })).code).toBe(0);
      const status = await ok(a, ['status', '--json']);
      expect(JSON.parse(status.out)).toMatchObject({ enrolled: true, peers: 0, problems: [] });
      const list = await ok(a, ['list', '--json']);
      expect((JSON.parse(list.out) as { peers: unknown[] }).peers).toEqual([]);
      const after = await startupStatus();
      expect(after.code).toBe(before.code);
      expect(after.out).toBe(before.out);
      // Neither the approval nor the join touched the startup job: the only orch calls are the two status reads.
      expect(stub.calls().map((c) => c[0])).toEqual(['show', 'show']);
    });

    it('a machine cannot run on itself: it is not in its own peer list', async () => {
      const id = await firstMachinePosts();
      await approve(a, id);
      const r = await cli(a, ['run', 'desktop', '--address', '127.0.0.1:1', '--shell', SHELL, '--', 'echo', 'x']);
      expect(r.code).toBe(255);
      expect(r.err).toMatch(/this machine/);
    });
  });

  /** A daemon of the first machine, started before its approval, with a manual timer. */
  async function daemonBeforeApproval() {
    const logs: string[] = [];
    const pending = new Map<number, () => void>();
    let next = 0;
    const timer = { set: (fn: () => void) => (pending.set(++next, fn), next), clear: (h: unknown) => void pending.delete(h as number) };
    const daemon = await startMachineDaemon(a, { port: 0, version: 'bootstrap', peerPort: 0, peerHost: '127.0.0.1', advertise: [{ host: '127.0.0.1' }], log: (l) => logs.push(l), inbox: { timer } });
    daemons.push(daemon);
    await daemon.inbox?.ready;
    return { daemon, logs, pending, text: () => logs.join(' | ') };
  }

  // The two relays behave differently before the approval, so each mode has its own expectations (defined per mode, never skipped).
  if (bind) {
    it('a daemon started before the approval says what to do, keeps no backoff, and publishes by itself in the next round after the approval', async () => {
      const id = await firstMachinePosts();
      const { daemon, logs, pending, text } = await daemonBeforeApproval();
      expect(text()).toMatch(/address record NOT published:.*this machine is not approved yet: run machine join and ask the admin to approve it/s);
      expect(text()).toMatch(/inbox: .*this machine is not approved yet: run machine join and ask the admin to approve it/s);
      // Said once, not at every round.
      await daemon.inbox?.runOnce();
      expect(logs.filter((l) => /not approved yet/.test(l))).toHaveLength(2);
      // The loop is not slowed down: the next round is one heartbeat away, not an exponential backoff.
      expect(pending.size).toBe(1);

      expect((await approve(a, id)).code).toBe(0);
      expect((await cli(a, ['join', '--resume'], undefined, { timing: fakeTiming(), ask: forbidden('the final code') })).code).toBe(0);
      await daemon.inbox?.runOnce();
      expect(text()).toMatch(/address record published/);
      expect(text()).toMatch(/inbox: this machine is approved on the relay now/);
      const entry = await relay.inbox(readMachine(a).uuid);
      expect(entry).toEqual([]);
    });
  } else {
    it('a daemon started before the approval: the relay as deployed has no approval gate, so nothing says "not approved yet" and the loop keeps its normal pace', async () => {
      const id = await firstMachinePosts();
      const { daemon, logs, pending, text } = await daemonBeforeApproval();
      expect(text()).not.toMatch(/not approved yet/);
      expect(text()).toMatch(/address record published/);
      await daemon.inbox?.runOnce();
      expect(pending.size).toBe(1);

      expect((await approve(a, id)).code).toBe(0);
      expect((await cli(a, ['join', '--resume'], undefined, { timing: fakeTiming(), ask: forbidden('the final code') })).code).toBe(0);
      await daemon.inbox?.runOnce();
      expect(logs.filter((l) => /not approved yet/.test(l))).toHaveLength(0);
      expect(await relay.inbox(readMachine(a).uuid)).toEqual([]);
    });
  }

  describe('the second machine joins and is approved by the first', () => {
    /** The first machine is enrolled; the second one joins with its own token and is approved. Returns the id of the second candidacy. */
    async function bothEnrolled(): Promise<void> {
      const id = await firstMachinePosts();
      expect((await approve(a, id)).code).toBe(0);
      expect((await cli(a, ['join', '--resume'], undefined, { timing: fakeTiming(), ask: yes })).code).toBe(0);
      await ok(b, ['init', '--name', 'laptop']);
      await ok(b, ['join', SECOND_CODE, '--relay', relay.url, '--no-wait']);
      const second = relay.pendingIds()[0] as string;
      const approved = await approve(a, second);
      expect(approved.code, approved.err).toBe(0);
      const asked: string[] = [];
      const joined = await cli(b, ['join', '--resume'], undefined, { timing: fakeTiming(), ask: async (l) => (asked.push(l), 'y') });
      expect(joined.code, joined.err).toBe(0);
      // The second machine does compare the final code: the admin key is new to it.
      expect(asked).toHaveLength(1);
    }

    it('each machine trusts the other, with the same pair secret, and neither lists itself', async () => {
      await bothEnrolled();
      const ua = readMachine(a).uuid;
      const ub = readMachine(b).uuid;
      expect(peersOf(a).map((p) => p.registration.body.uuid)).toEqual([ub]);
      expect(peersOf(b).map((p) => p.registration.body.uuid)).toEqual([ua]);
      expect((peersOf(a)[0] as { pairSecret: string }).pairSecret).toBe((peersOf(b)[0] as { pairSecret: string }).pairSecret);
      expect(JSON.parse((await ok(a, ['status', '--json'])).out)).toMatchObject({ enrolled: true, peers: 1, problems: [] });
      expect(JSON.parse((await ok(b, ['status', '--json'])).out)).toMatchObject({ enrolled: true, peers: 1, problems: [] });
      // The second approval was sealed to the key of the second machine, with the first machine as the only peer.
      const sent = (decisions()[1]?.body as { approval: { adminUuid: string; random: string; peers: { sealedPairSecret: string }[] } }).approval;
      expect(sent.peers).toHaveLength(1);
      const opened = Buffer.from(openSealed(readMachine(b).identity.privateKeyPkcs8, sent.peers[0]?.sealedPairSecret as string, pairSecretContext({ adminUuid: ua, candidateUuid: ub, random: sent.random, slot: `peer:${ua}` }))).toString('base64url');
      expect(opened).toBe((peersOf(b)[0] as { pairSecret: string }).pairSecret);
    });

    it('the admin sent nothing to its own inbox and nothing to the new machine beyond the approval (no other peer yet)', async () => {
      await bothEnrolled();
      expect(relay.inbox(readMachine(a).uuid)).toEqual([]);
      expect(relay.inbox(readMachine(b).uuid)).toEqual([]);
    });

    it('a third machine: the others get one peer document each about each other, none is sent to the admin machine about itself, none to a machine about itself', async () => {
      await bothEnrolled();
      const c = join(root, 'c');
      mkdirSync(c);
      await ok(c, ['init', '--name', 'nas']);
      await ok(c, ['join', THIRD_CODE, '--relay', relay.url, '--no-wait']);
      const third = relay.pendingIds()[0] as string;
      const approved = await approve(a, third);
      expect(approved.code, approved.err).toBe(0);
      expect(approved.out).toContain('2 document(s) stored by the relay for 1 machine(s)');
      const [ua, ub, uc] = [readMachine(a).uuid, readMachine(b).uuid, readMachine(c).uuid];
      const about = (uuid: string) => relay.inbox(uuid).map((d) => ((d.document as { body: { kind: string; payload: { registration: { body: { uuid: string } } } } }).body.payload.registration.body.uuid));
      expect(relay.inbox(ua)).toEqual([]);
      expect(about(ub)).toEqual([uc]);
      expect(about(uc)).toEqual([ub]);
      // The admin machine knows both by itself.
      expect(peersOf(a).map((p) => p.registration.body.uuid).sort()).toEqual([ub, uc].sort());
      // The admin machine is not a distribution subject for itself: a clear refusal, no document.
      const self = await cli(a, ['admin', 'distribute', 'desktop'], async () => passphrase);
      expect(self.code, self.err).toBe(0);
      expect(self.out).toMatch(/this is the admin machine itself: nothing to distribute to itself/);
      expect(relay.inbox(ua)).toEqual([]);
    });

    it('the first machine runs a command on the second one, with the address given and with the record the daemon published', async () => {
      await bothEnrolled();
      // The second machine gets its policy from the first through the relay inbox, like in real life.
      const { writeFileSync } = await import('node:fs');
      writeFileSync(join(root, 'draft.json'), JSON.stringify({ v: 1, target: readMachine(b).uuid, version: 1, baseVersion: 0, defaults: [{ shell: SHELL, command: 'echo hello from laptop' }], peers: {} }));
      const signed = await cli(a, ['admin', 'sign-policy', join(root, 'draft.json'), '--out', join(root, 'policy-b.json')], async () => passphrase);
      expect(signed.code, signed.err).toBe(0);
      await ok(b, ['policy', 'install', join(root, 'policy-b.json')]);

      const daemon = await startMachineDaemon(b, { port: 0, version: 'bootstrap', peerPort: 0, peerHost: '127.0.0.1', advertise: [{ host: '127.0.0.1' }], log: () => undefined });
      daemons.push(daemon);
      await daemon.inbox?.ready;
      const byAddress = await cli(a, ['run', 'laptop', '--address', `127.0.0.1:${daemon.peerPort}`, '--shell', SHELL, '--', 'echo', 'hello', 'from', 'laptop']);
      expect(byAddress.err).toBe('');
      expect(byAddress.code).toBe(0);
      expect(byAddress.out.trim()).toBe('hello from laptop');
      const byRecord = await cli(a, ['run', 'laptop', '--shell', SHELL, '--', 'echo', 'hello', 'from', 'laptop'], undefined, { allowLoopbackPeers: true });
      expect(byRecord.err).toBe('');
      expect(byRecord.code).toBe(0);
      expect(byRecord.out.trim()).toBe('hello from laptop');
      expect(readRelayConfig(b)?.label).toBe('machine-pairing-2');
    });
  });
});
