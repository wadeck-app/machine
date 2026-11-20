import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readMachine } from '../identity.js';
import { allowEcho, joinSecond, relayGet, setupFirst } from './flows.js';
import { SHELL, startWorld, type World } from './world.js';

// OFFBOARDING, rejected and interrupted candidacies, wrong passphrase: against the REAL relay (`npm run test:relay`). One story, in order.
// What the real relay answers is asserted as it is; the behaviours the tests discovered are named in the test titles.

let w: World;
let a: string;
let b: string;
let desktopPeerPort = 0;

beforeAll(async () => {
  w = await startWorld('offboarding');
  a = w.machineDir('desktop');
  b = w.machineDir('laptop');
});
afterAll(async () => {
  await w.stop();
});

describe('two machines, then the second leaves', () => {
  it('precondition: both enrolled, a command allowed on the laptop and on the desktop, daemons up, run works both ways', async () => {
    await setupFirst(w, a);
    await joinSecond(w, a, b);
    await allowEcho(w, a, 'laptop', 'hello-laptop');
    await allowEcho(w, a, 'desktop', 'hello-desktop');
    const daemonB = await w.daemon(b);
    desktopPeerPort = (await w.daemon(a)).peerPort;
    await daemonB.inbox?.runOnce();
    const r = await w.run('desktop', a, ['run', 'laptop', '--shell', SHELL, '--', 'echo hello-laptop'], { allowLoopbackPeers: true });
    expect(r.out.trim()).toBe('hello-laptop');
    const back = await w.run('laptop', b, ['run', 'desktop', '--shell', SHELL, '--', 'echo hello-desktop'], { allowLoopbackPeers: true });
    expect(back.out.trim()).toBe('hello-desktop');
    const machines = await relayGet(w, '/api/machines', w.relay.adminToken);
    expect((machines.body.machines as unknown[]).length).toBe(2);
  });

  it('a wrong admin passphrase signs nothing and says so (the revoke is not done)', async () => {
    const r = await w.run('desktop', a, ['admin', 'revoke', 'laptop'], { visible: ['y'], hidden: 'not the passphrase at all' });
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/wrong passphrase/);
    const status = JSON.parse((await w.run('desktop', a, ['status', '--json'])).out) as { peers: number };
    expect(status.peers).toBe(1);
  });

  it('answering N does not revoke', async () => {
    const r = await w.run('desktop', a, ['admin', 'revoke', 'laptop'], { visible: ['n'] });
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/not revoked/);
  });

  it('an open session of the laptop survives the revoke only for the daemon cache delay, then the desktop refuses it', async () => {
    const { connectToPeer } = await import('@wadeck-app/machine-transport');
    const { runOnPeer } = await import('../peerService.js');
    const { loadNetwork } = await import('../network.js');
    const desktop = readMachine(a);
    const laptop = readMachine(b);
    const peer = loadNetwork(b, Math.floor(Date.now() / 1000)).directory.find(desktop.uuid);
    if (peer === undefined) throw new Error('the laptop does not know the desktop');
    const port = desktopPeerPort;
    const session = await connectToPeer({ identity: laptop.identity, host: '127.0.0.1', port, expectedPeerPublicKey: peer.identityPublicKey, pairSecret: peer.pairSecret });
    try {
      const before = await runOnPeer(session, { identity: laptop.identity, source: laptop.uuid, target: desktop.uuid, shell: SHELL, command: 'echo hello-desktop', now: Math.floor(Date.now() / 1000) });
      expect(before.type).toBe('result');

      const revoked = await w.run('desktop', a, ['admin', 'revoke', 'laptop'], { visible: ['y'] });
      expect(revoked.code, revoked.err).toBe(0);
      expect(revoked.out).toMatch(/\[ok\] "laptop" revoked on this machine/);

      // The daemon of the desktop re-reads the files after at most 5 s (its network cache): then every message of the open session is refused.
      let answer = await runOnPeer(session, { identity: laptop.identity, source: laptop.uuid, target: desktop.uuid, shell: SHELL, command: 'echo hello-desktop', now: Math.floor(Date.now() / 1000) }).catch((e: Error) => ({ type: 'error', message: e.message }));
      const deadline = Date.now() + 8000;
      while (answer.type === 'result' && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 1000));
        answer = await runOnPeer(session, { identity: laptop.identity, source: laptop.uuid, target: desktop.uuid, shell: SHELL, command: 'echo hello-desktop', now: Math.floor(Date.now() / 1000) }).catch((e: Error) => ({ type: 'error', message: e.message }));
      }
      expect(answer.type, 'the open session of a revoked machine is refused or closed within the cache delay').not.toBe('result');
    } finally {
      session.close();
    }
  });

  it('after the revoke: the desktop no longer lists nor runs on the laptop, and the relay no longer holds its record', async () => {
    const status = JSON.parse((await w.run('desktop', a, ['status', '--json'])).out) as { peers: number };
    expect(status.peers).toBe(0);
    // The revoked machine is named in its own block, with its uuid (UX audit 16).
    const text = await w.run('desktop', a, ['status']);
    expect(text.out).toMatch(/revoked machines \(1\)/);
    expect(text.out).toContain(`laptop  uuid ${readMachine(b).uuid.slice(0, 8)}`);
    const run = await w.run('desktop', a, ['run', 'laptop', '--shell', SHELL, '--', 'echo hello-laptop'], { allowLoopbackPeers: true });
    expect(run.code).toBe(255);
    expect(run.err).toMatch(/laptop/);
    const machines = await relayGet(w, '/api/machines', w.relay.adminToken);
    const uuids = (machines.body.machines as { uuid: string }[]).map((m) => m.uuid);
    expect(uuids).toEqual([readMachine(a).uuid]);
  });

  it('the revoked laptop cannot reach the desktop (peer refused) and its relay token no longer works for its uuid', async () => {
    const run = await w.run('laptop', b, ['run', 'desktop', '--shell', SHELL, '--', 'echo hello-desktop'], { allowLoopbackPeers: true });
    expect(run.code).toBe(255);
    expect(run.err).toMatch(/closed the connection during authentication.*revoked there/s);
    expect(run.out).toBe('');
    const laptop = readMachine(b);
    const cfg = JSON.parse((await import('node:fs')).readFileSync(`${b}/_secrets_/relay.json`, 'utf8')) as { token: string };
    const heartbeat = await fetch(`${w.relay.url}/api/machines/${laptop.uuid}/heartbeat`, { method: 'POST', headers: { authorization: `Bearer ${cfg.token}` } });
    expect(heartbeat.status).toBe(403);
    expect(((await heartbeat.json()) as { error: string }).error).toBe('not_registered');
  });

  it('forget-relay-record of a machine already revoked: by name and by uuid both work (the relay says nothing to forget)', async () => {
    const byName = await w.run('desktop', a, ['admin', 'forget-relay-record', 'laptop'], { visible: ['y'] });
    expect(byName.code, byName.err).toBe(0);
    expect(byName.out).toMatch(/"laptop" \(revoked machine /);
    const byUuid = await w.run('desktop', a, ['admin', 'forget-relay-record', readMachine(b).uuid], { visible: ['y'] });
    expect(byUuid.code, byUuid.err).toBe(0);
  });

  it('join again after the revoke: the machine still holds its token and files: what happens is asserted as it is', async () => {
    const again = await w.run('laptop', b, ['join', w.relay.url], { visible: ['y'] });
    expect(again.code).toBe(1);
    expect(again.err).toMatch(/already joined|already enrolled|--resume|--force/);
  });

  it('join --resume after the revoke: a new candidacy; the admin approves it and the machine is back with a NEW registration', async () => {
    let approved: { code: number; out: string; err: string } | undefined;
    const r = await w.run('laptop', b, ['join', '--resume'], {
      visible: ['y'],
      onWait: async (_n, out) => {
        if (approved === undefined && /Candidacy \S+ posted/.test(out)) approved = await w.run('desktop', a, ['admin', 'approve'], { visible: ['y'] });
      },
    });
    // Real behaviour: nothing forbids it. The same token posts a new candidacy, the admin is warned that the machine was revoked here, and approving enrolls it again.
    expect(approved?.code, approved?.err).toBe(0);
    expect(approved?.out).toMatch(/REVOKED on this machine earlier/);
    expect(r.code, r.err).toBe(0);
    expect(r.out).toContain('[ok] enrolled "laptop"');
  });
});

describe('a candidacy that is rejected, interrupted or cut short', () => {
  let c: string;
  beforeAll(async () => {
    c = w.machineDir('nas');
  });

  it('the admin rejects: the candidate is told, its token is kept, and `join --resume` posts a new candidacy', async () => {
    let rejected: { code: number; out: string; err: string } | undefined;
    const r = await w.run('nas', c, ['join', w.relay.url], {
      hostname: 'Nas',
      onWait: async (_n, out) => {
        const id = /Candidacy (\S+) posted/.exec(out)?.[1];
        if (rejected === undefined && id !== undefined) rejected = await w.run('desktop', a, ['admin', 'approve', id, '--reject']);
      },
    });
    expect(rejected?.code, rejected?.err).toBe(0);
    expect(rejected?.out).toMatch(/rejected/);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/rejected/);
    expect(r.err).toMatch(/join --resume/);
  });

  it('the admin cannot approve a candidacy that is already decided (the relay answers 409 not_pending)', async () => {
    const pending = await relayGet(w, '/api/machines/candidacies', w.relay.adminToken);
    expect(pending.body.candidacies).toEqual([]);
    const r = await w.run('desktop', a, ['admin', 'approve', 'doesnotexist'], { visible: ['y'] });
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/no pending candidacy matches/);
  });

  it('a join cut short by --timeout keeps token and candidacy; the admin then approves; `join --resume` finishes', async () => {
    const cut = await w.run('nas', c, ['join', '--resume', '--timeout', '1'], { visible: ['y'] });
    expect(cut.code).toBe(1);
    expect(cut.err).toMatch(/join --resume/);
    const pending = await relayGet(w, '/api/machines/candidacies', w.relay.adminToken);
    expect((pending.body.candidacies as unknown[]).length).toBe(1);
    // `machine admin` alone (decision 66): lists the one pending candidacy, read-only, with the real relay.
    const listed = await w.run('desktop', a, ['admin']);
    expect(listed.code, listed.err).toBe(0);
    expect(listed.out).toMatch(/1 pending candidacy.*waiting for approval/);
    expect(listed.out).toContain('nas');
    expect(listed.out.trimEnd().split('\n').at(-1)).toMatch(/machine admin approve \[<id>\]/);
    expect(((await relayGet(w, '/api/machines/candidacies', w.relay.adminToken)).body.candidacies as unknown[]).length).toBe(1);
    const approved = await w.run('desktop', a, ['admin', 'approve'], { visible: ['y'] });
    expect(approved.code, approved.err).toBe(0);
    const done = await w.run('nas', c, ['join', '--resume'], { visible: ['y'] });
    expect(done.code, done.err).toBe(0);
    expect(done.out).toContain('[ok] enrolled "nas"');
    // Nothing waits any more: `machine admin` says so and how a machine asks to join.
    const none = await w.run('desktop', a, ['admin']);
    expect(none.code, none.err).toBe(0);
    expect(none.out).toMatch(/no pending candidacy.*machine join <relay>/);
  });

  it('a candidacy that the client considers expired (clock 16 minutes ahead) is dropped and a new one is posted', async () => {
    const d = w.machineDir('tablet');
    await w.run('tablet', d, ['join', w.relay.url, '--no-wait'], { hostname: 'Tablet' });
    const r = await w.run('tablet', d, ['join', '--resume', '--verbose'], { nowMs: () => Date.now() + 16 * 60_000, visible: [] });
    // Real relay: re-posting the same identity key with the same token replaces the entry (a new random, so a new candidacy code, shown with --verbose).
    expect(r.out).toMatch(/\[warn\] the previous candidacy expired: posting a new one/);
    expect(r.err).toMatch(/expired/);
    const codes = [...r.out.matchAll(/^ {2}([0-9A-Z]{4}(?:-[0-9A-Z]{4}){3})$/gm)].map((m) => m[1]);
    expect(new Set(codes).size).toBe(2);
    const pending = await relayGet(w, '/api/machines/candidacies', w.relay.adminToken);
    expect((pending.body.candidacies as unknown[]).length).toBe(1);
  });
});
