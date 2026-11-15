import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readMachine } from '../identity.js';
import type { RunningDaemon } from '../daemonEntry.js';
import { SHELL, startWorld, type World } from './world.js';

// INIT and ONBOARDING against the REAL relay (server.js of poc-node, started by the helper of that repository): `npm run test:relay`.
// One story, in order: the first machine, a second machine, a command allowed on each, a command refused.
// Time is fake (the waits cost nothing); the relay, its HTTP, its limits and its stored data are real.

let w: World;
let a: string;
let b: string;
let daemonA: RunningDaemon;
let daemonB: RunningDaemon;

const lineAfter = (text: string, marker: RegExp): string => {
  const m = marker.exec(text);
  if (m === null) throw new Error(`"${marker}" not found in:\n${text}`);
  const code = /^\s{2}([A-Z0-9]{4}(?:-[A-Z0-9]{4})+)\s*$/m.exec(text.slice(m.index));
  if (code === null) throw new Error(`no code after "${marker}" in:\n${text}`);
  return code[1] as string;
};
const relayGet = async (path: string, token: string) => {
  const r = await fetch(`${w.relay.url}${path}`, { headers: { authorization: `Bearer ${token}` } });
  return { status: r.status, body: (await r.json()) as Record<string, unknown> };
};

beforeAll(async () => {
  w = await startWorld('onboarding');
  a = w.machineDir('desktop');
  b = w.machineDir('laptop');
});
afterAll(async () => {
  await w.stop();
});

describe('onboarding with the real relay', () => {
  it('help is printed without a configuration folder and without the relay', async () => {
    const r = await w.run('anyone', w.machineDir('empty'), ['--help']);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/machine setup <relay>/);
  });

  it('status before anything: says what to do, creates nothing', async () => {
    const r = await w.run('desktop', a, ['status']);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/machine init|machine setup|machine join/);
  });

  it('setup of the first machine: admin key, full-access code, device login approved in the relay console, self-approval, enrollment', async () => {
    const code = await w.relay.adminPairingCode();
    const r = await w.run('desktop', a, ['setup', w.relay.url], { hostname: 'Desktop', visible: [code] });
    expect(r.code, r.err).toBe(0);
    expect(r.out).toContain('[ok] admin key created');
    expect(r.out).toMatch(/\[ok\] admin token "[^"]+" saved for /);
    expect(r.out).toMatch(/\[ok\] relay access approved/);
    expect(r.out).toContain('[ok] enrolled "desktop"');
    expect(r.out + r.err).not.toContain('correct horse');
    // The relay holds no pending candidacy any more, and the machine is bound to the machine token it got from the device login.
    const pending = await relayGet('/api/machines/candidacies', w.relay.adminToken);
    expect(pending.status).toBe(200);
    expect(pending.body.candidacies).toEqual([]);
  });

  it('status and list of the first machine: enrolled, no peer, itself in the list', async () => {
    const status = JSON.parse((await w.run('desktop', a, ['status', '--json'])).out) as { enrolled: boolean; peers: number; problems: unknown[] };
    expect(status).toMatchObject({ enrolled: true, peers: 0, problems: [] });
    const list = await w.run('desktop', a, ['list']);
    expect(list.code).toBe(0);
    expect(list.out).toContain('desktop');
    await w.run('desktop', a, ['status']);
  });

  it('join of a second machine: device login, wait, the admin approves, the final codes are identical', async () => {
    let approved: { code: number; out: string; err: string } | undefined;
    const r = await w.run('laptop', b, ['join', w.relay.url], {
      hostname: 'Laptop',
      visible: ['y'],
      onWait: async (_n, out) => {
        if (approved === undefined && /Candidacy \S+ posted/.test(out)) approved = await w.run('desktop', a, ['admin', 'approve'], { visible: ['y'] });
      },
    });
    expect(approved, 'the admin approval ran while the new machine waited').toBeDefined();
    expect(approved?.code, approved?.err).toBe(0);
    expect(r.code, r.err).toBe(0);
    expect(r.out).toContain('[ok] enrolled "laptop"');
    const seenByAdmin = lineAfter(approved?.out ?? '', /Final code/);
    const seenByNewMachine = lineAfter(r.out, /Final code/);
    expect(seenByNewMachine).toBe(seenByAdmin);
  });

  it('status and list on both machines agree: one peer each', async () => {
    for (const [who, dir, other] of [['desktop', a, 'laptop'], ['laptop', b, 'desktop']] as const) {
      const status = JSON.parse((await w.run(who, dir, ['status', '--json'])).out) as { enrolled: boolean; peers: number; problems: unknown[] };
      expect(status, who).toMatchObject({ enrolled: true, peers: 1, problems: [] });
      const list = await w.run(who, dir, ['list']);
      expect(list.out, who).toContain(other);
    }
  });

  it('admin allow: a command for the laptop (through the relay inbox) and one for the desktop (installed here)', async () => {
    const forLaptop = await w.run('desktop', a, ['admin', 'allow', 'laptop', '--shell', SHELL, '--', 'echo hello-from-laptop'], { visible: ['y'] });
    expect(forLaptop.code, forLaptop.err).toBe(0);
    const forDesktop = await w.run('desktop', a, ['admin', 'allow', 'desktop', '--shell', SHELL, '--', 'echo hello-from-desktop'], { visible: ['y'] });
    expect(forDesktop.code, forDesktop.err).toBe(0);
    const uuidLaptop = readMachine(b).uuid;
    // The signed policy waits in the inbox of the laptop on the real relay until its daemon reads it.
    const inbox = await relayGet(`/api/machines/${uuidLaptop}/inbox`, w.relay.adminToken);
    expect(inbox.status).toBe(200);
    expect((inbox.body.documents as unknown[]).length).toBeGreaterThan(0);
  });

  it('the daemons start, publish their address record on the real relay and install what waited in the inbox', async () => {
    daemonB = await w.daemon(b);
    daemonA = await w.daemon(a);
    await daemonB.inbox?.runOnce();
    await daemonA.inbox?.runOnce();
    const machines = await relayGet('/api/machines', w.relay.adminToken);
    const uuids = (machines.body.machines as { uuid: string; online: boolean }[]).map((m) => m.uuid).sort();
    expect(uuids).toEqual([readMachine(a).uuid, readMachine(b).uuid].sort());
    const inbox = await relayGet(`/api/machines/${readMachine(b).uuid}/inbox`, w.relay.adminToken);
    expect((inbox.body.documents as unknown[]).length, w.daemonLog.join(' | ')).toBe(0);
    const status = JSON.parse((await w.run('laptop', b, ['status', '--json'])).out) as { policyVersion?: number };
    expect(status.policyVersion).toBeGreaterThan(0);
  });

  it('the first machine runs the allowed command on the second, and the second on the first (addresses come from the relay)', async () => {
    const toLaptop = await w.run('desktop', a, ['run', 'laptop', '--shell', SHELL, '--', 'echo hello-from-laptop'], { allowLoopbackPeers: true });
    expect(toLaptop.err).toBe('');
    expect(toLaptop.code).toBe(0);
    expect(toLaptop.out.trim()).toBe('hello-from-laptop');
    const toDesktop = await w.run('laptop', b, ['run', 'desktop', '--shell', SHELL, '--', 'echo hello-from-desktop'], { allowLoopbackPeers: true });
    expect(toDesktop.err).toBe('');
    expect(toDesktop.code).toBe(0);
    expect(toDesktop.out.trim()).toBe('hello-from-desktop');
  });

  it('a command that is not allowed is refused by the target, with the reason', async () => {
    const r = await w.run('desktop', a, ['run', 'laptop', '--shell', SHELL, '--', 'echo not-allowed'], { allowLoopbackPeers: true });
    expect(r.code).toBe(255);
    expect(r.err).toMatch(/refused by laptop/);
    expect(r.out).toBe('');
  });

  it('list with the relay: the peer is online with its published address', async () => {
    const r = await w.run('desktop', a, ['list'], { allowLoopbackPeers: true });
    expect(r.code).toBe(0);
    expect(r.out).toContain('laptop');
    expect(r.out).toMatch(/127\.0\.0\.1:\d+/);
    expect(r.out).toMatch(/online/);
  });
});
