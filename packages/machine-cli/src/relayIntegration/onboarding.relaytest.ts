import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readMachine } from '../identity.js';
import type { RunningDaemon } from '../daemonEntry.js';
import { SECRETS_DIRNAME } from '../paths.js';
import { writeRelayConfig } from '../relayStore.js';
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
  const code = /^\s{2}(\d{5}(?: \d{5}){4})\s*$/m.exec(text.slice(m.index));
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

  it('setup of the first machine: admin key, ONE machine-admin login confirmed in the relay console (no code copied, no second request), self-approval, enrollment', async () => {
    const r = await w.run('desktop', a, ['setup', w.relay.url], { hostname: 'Desktop', visible: [''] });
    expect(r.code, r.err).toBe(0);
    expect(r.out).toContain('[ok] admin key created');
    expect(r.out).toContain('MACHINE ADMIN: can approve machines, cannot manage tokens');
    expect(r.out).toMatch(/Compare this code with the one in the relay console \(the Tokens page lists the request "desktop", marked MACHINE ADMIN\), check that the source address is this computer, then approve\. If the console shows several codes, click this one\./);
    expect(r.out).toContain('[ok] machine admin access approved');
    expect(r.out).toMatch(/\[ok\] relay token "desktop" saved for \S+: it is the token of this machine and its admin token/);
    expect(r.out).toContain('[ok] enrolled "desktop"');
    // One code shown, one confirmation: no second login request, no full access, no old-relay fallback.
    expect(r.out.match(/^\s*[A-Z0-9]{4}-[A-Z0-9]{4}\s*$/gm)).toHaveLength(1);
    expect(r.out + r.err).not.toMatch(/FULL ACCESS|pairing code|\[warn\]/i);
    expect(r.out + r.err).not.toContain('correct horse');
    // The relay holds no pending candidacy any more.
    const pending = await relayGet('/api/machines/candidacies', w.relay.adminToken);
    expect(pending.status).toBe(200);
    expect(pending.body.candidacies).toEqual([]);
  });

  it('the saved token is ONE token for relay.json and relay-admin.json, scoped ["machine-admin"] on the real relay: it lists candidacies, and it gets 403 on token management', async () => {
    const admin = JSON.parse(readFileSync(join(a, '_secrets_', 'relay-admin.json'), 'utf8')) as { token: string; label: string };
    const machine = JSON.parse(readFileSync(join(a, '_secrets_', 'relay.json'), 'utf8')) as { token: string; label: string };
    expect(admin.token).toBe(machine.token);
    expect(admin.label).toBe('desktop');
    const whoami = await relayGet('/api/whoami', admin.token);
    expect(whoami.body.scopes).toEqual(['machine-admin']);
    // The admin calls of the machine network...
    expect((await relayGet('/api/machines/candidacies', admin.token)).status).toBe(200);
    // ...and nothing on the management of tokens, pairings, device logins, key-value, audit (the scope is machine rights only).
    for (const path of ['/api/tokens', '/api/device-login', '/api/key-value', '/api/audit-log']) {
      const refused = await relayGet(path, admin.token);
      expect(refused.status, path).toBe(403);
    }
    // The token never appears in what setup printed (checked above with the output) nor in a log file of this machine.
    // Not conditional: every command writes its trace, so the log folder must exist (else this check would prove nothing).
    expect(existsSync(join(a, 'logs')), 'the command log of the first machine').toBe(true);
    const logs = readdirSync(join(a, 'logs'));
    expect(logs.length).toBeGreaterThan(0);
    for (const entry of logs) expect(readFileSync(join(a, 'logs', entry), 'utf8')).not.toContain(admin.token);
  });

  it('admin login with --force on the real relay: a second machine-admin request ("desktop admin"), the admin token is replaced, the machine token stays', async () => {
    const before = readFileSync(join(a, '_secrets_', 'relay-admin.json'), 'utf8');
    const machineBefore = readFileSync(join(a, '_secrets_', 'relay.json'), 'utf8');
    const refused = await w.run('desktop', a, ['admin', 'login']);
    expect(refused.code).toBe(1);
    expect(refused.err).toMatch(/already holds an admin relay token/);
    const r = await w.run('desktop', a, ['admin', 'login', '--force']);
    expect(r.code, r.err).toBe(0);
    expect(r.out).toContain('MACHINE ADMIN');
    expect(r.out).not.toContain('FULL ACCESS');
    expect(r.out).toMatch(/marked MACHINE ADMIN/);
    expect(r.out).toMatch(/\[ok\] admin token "desktop admin[^"]*" saved for /);
    const after = JSON.parse(readFileSync(join(a, '_secrets_', 'relay-admin.json'), 'utf8')) as { token: string; label: string };
    expect(readFileSync(join(a, '_secrets_', 'relay-admin.json'), 'utf8')).not.toBe(before);
    expect(readFileSync(join(a, '_secrets_', 'relay.json'), 'utf8')).toBe(machineBefore);
    expect(after.label).toMatch(/^desktop admin/);
    expect((await relayGet('/api/whoami', after.token)).body.scopes).toEqual(['machine-admin']);
    expect((await relayGet('/api/machines/candidacies', after.token)).status).toBe(200);
  });

  it('admin login --full-access on the real relay is the explicit opt-in: FULL ACCESS shown, a [warn], a full-access token (scopes null) that can manage tokens', async () => {
    const adminFile = join(a, '_secrets_', 'relay-admin.json');
    const keep = readFileSync(adminFile, 'utf8');
    const r = await w.run('desktop', a, ['admin', 'login', '--full-access', '--force']);
    expect(r.code, r.err).toBe(0);
    expect(r.out).toContain('FULL ACCESS');
    expect(r.out).toMatch(/\[warn\] this admin token has FULL ACCESS: it can also manage tokens/);
    const full = JSON.parse(readFileSync(adminFile, 'utf8')) as { token: string };
    expect((await relayGet('/api/whoami', full.token)).body.scopes).toBeNull();
    expect((await relayGet('/api/tokens', full.token)).status).toBe(200);
    // Back to the machine-admin token for the rest of the story: the opt-in must not leak into it.
    writeFileSync(adminFile, keep);
  });

  it('status and list of the first machine: enrolled, no peer, itself in the list', async () => {
    const status = JSON.parse((await w.run('desktop', a, ['status', '--json'])).out) as { enrolled: boolean; peers: number; problems: unknown[] };
    expect(status).toMatchObject({ enrolled: true, peers: 0, problems: [] });
    const list = await w.run('desktop', a, ['list']);
    expect(list.code).toBe(0);
    expect(list.out).toContain('desktop');
    await w.run('desktop', a, ['status']);
  });

  it('join of a second machine: device login, wait, the admin approves, the security codes are identical', async () => {
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
    const seenByAdmin = lineAfter(approved?.out ?? '', /Security code of /);
    const seenByNewMachine = lineAfter(r.out, /Security code of /);
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
    // Decision 77: what the REAL relay stores is sealed. It accepted the version 2 envelope (it only checks to, id and size) and holds no command text.
    const stored = JSON.stringify(inbox.body.documents);
    expect(stored).toContain('"v":2');
    expect(stored).toContain('"sealed"');
    for (const forbidden of ['hello-from-laptop', 'echo ', '"shell"', '"defaults"', '"registration"']) expect(stored).not.toContain(forbidden);
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

  it('ping (the path to the relay) on the real relay: every step answers, the access level comes from the real /api/whoami, the loopback record is a warning', async () => {
    const r = await w.run('desktop', a, ['ping']);
    expect(r.code, r.err).toBe(0);
    expect(r.out).toMatch(/\[ok\] relay\.json: \S+ \(token labelled "desktop"\)/);
    // The real /api/version (public): a version string and an uptime, and a measured round trip.
    expect(r.out).toMatch(/\[ok\] relay reachable in [\d.]+ ms \(first request: includes DNS and TLS setup\), version \S+, up /);
    expect(r.out).toMatch(/\[ok\] token accepted in [\d.]+ ms, access level machine-admin \(can approve machines, cannot manage tokens\)/);
    expect(r.out).toContain('[ok] local daemon is running');
    // The test daemons advertise loopback, which peers refuse: said as a warning, not a failure.
    expect(r.err).toMatch(/\[warn\] address record published: 127\.0\.0\.1:\d+ \(seq \d+, .*Peers refuse every one of these addresses/);
    // The token never reaches the output.
    const token = (JSON.parse(readFileSync(join(a, SECRETS_DIRNAME, 'relay.json'), 'utf8')) as { token: string }).token;
    expect(r.out + r.err).not.toContain(token);
  });

  it('ping <machine> on the real relay: the address of the peer comes from its record, the mutual TLS channel opens, nothing is executed, the peer audits nothing', async () => {
    const auditBefore = existsSync(join(b, 'audit.log')) ? readFileSync(join(b, 'audit.log'), 'utf8') : '';
    const r = await w.run('desktop', a, ['ping', 'laptop', '--count', '3'], { allowLoopbackPeers: true });
    expect(r.err).toBe('');
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/\[ok\] address: 1 address\(es\) from the relay record of "laptop" \(seq \d+, .*the relay says online/);
    expect(r.out).toMatch(/\[ok\] peer: "laptop" proved the identity key pinned by its registration and the pair secret/);
    expect(r.out).toMatch(/3 attempts, 3 answered, 0 failed/);
    expect(r.out).toMatch(/nothing was executed on it/);
    const auditAfter = existsSync(join(b, 'audit.log')) ? readFileSync(join(b, 'audit.log'), 'utf8') : '';
    expect(auditAfter).toBe(auditBefore);
    // And the other way round, with --json.
    const back = await w.run('laptop', b, ['ping', 'desktop', '--json'], { allowLoopbackPeers: true });
    expect(back.code, back.err).toBe(0);
    expect(JSON.parse(back.out)).toMatchObject({ ok: true, executed: false, peer: { name: 'desktop' } });
  });

  it('ping on the real relay with a token the relay does not know: the real 401 is explained with the fix, and the token is not printed', async () => {
    const dir = w.machineDir('stranger');
    writeRelayConfig(dir, { relayUrl: w.relay.url, token: 'tok_not_a_real_token', label: 'stranger', claimedAt: new Date().toISOString() }, false);
    const r = await w.run('stranger', dir, ['ping']);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/\[fail\] the relay \S+ refused the stored token \(invalid or revoked\).*machine join/);
    expect(r.out + r.err).not.toContain('tok_not_a_real_token');
  });

  it('list with the relay: the peer is online with its published address', async () => {
    const r = await w.run('desktop', a, ['list'], { allowLoopbackPeers: true });
    expect(r.code).toBe(0);
    expect(r.out).toContain('laptop');
    expect(r.out).toMatch(/127\.0\.0\.1:\d+/);
    expect(r.out).toMatch(/online/);
  });

  it('the machine-admin token held by the first machine (and read by its daemon) sits in relay.json only: not in any other file, daemon log line, command output or error', async () => {
    const token = (JSON.parse(readFileSync(join(a, '_secrets_', 'relay.json'), 'utf8')) as { token: string }).token;
    const filesUnder = (from: string): string[] => readdirSync(from, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? filesUnder(join(from, e.name)) : [join(from, e.name)]));
    const holders = filesUnder(a).filter((file) => readFileSync(file, 'utf8').includes(token));
    // relay-admin.json holds the token of the later `admin login --force`, a different one: only relay.json may hold this token.
    expect(holders.map((f) => f.slice(a.length + 1).replace(/\\/g, '/'))).toEqual(['_secrets_/relay.json']);
    expect(w.daemonLog.length).toBeGreaterThan(0);
    expect(w.daemonLog.join('\n')).not.toContain(token);
    for (const entry of w.transcript) expect(`${entry.out}\n${entry.err}\n${entry.asked.join('\n')}`, entry.command).not.toContain(token);
  });
});
