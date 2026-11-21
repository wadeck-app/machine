import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startMachineDaemon } from './daemonEntry.js';
import { readMachine } from './identity.js';
import { cli, ok } from './testing.js';

// Revocation catch-up between peers, end to end through the command line and real daemons on loopback.
// A is the admin machine ("desktop"), C ("carol") and D ("dave") are peers of each other and of A. There is no relay: the
// revocation of D reaches nobody by itself, which is exactly the case the catch-up at connection time covers.

const SHELL = process.platform === 'win32' ? 'cmd' : 'sh';
const yes = async () => 'y';

let root: string;
let a: string;
let c: string;
let d: string;
let passphrase: string;
const pass = async () => passphrase;
const stoppers: Array<() => Promise<void>> = [];

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'machine-catchup-'));
  a = join(root, 'a');
  c = join(root, 'c');
  d = join(root, 'd');
  await ok(a, ['init', '--name', 'desktop']);
  await ok(c, ['init', '--name', 'carol']);
  await ok(d, ['init', '--name', 'dave']);
  const init = await ok(a, ['admin', 'init', '--generate']);
  passphrase = /passphrase[^\n]*\n\s*([A-Z0-9 -]{20,})/i.exec(init.err)?.[1]?.trim() ?? '';
  for (const [dir, name] of [[a, 'a'], [c, 'c'], [d, 'd']] as const) await ok(dir, ['peer', 'info', '--out', join(root, `${name}-info.json`)]);
  await ok(c, ['admin', 'pin', join(a, 'admin.json')]);
  await ok(d, ['admin', 'pin', join(a, 'admin.json')]);
  const dirs: Record<string, string> = { a, c, d };
  // One pair secret per pair: the second registration reuses the first bundle's secret.
  const pair = async (p: string, q: string) => {
    await ok(a, ['admin', 'register', join(root, `${q}-info.json`), '--out', join(root, `for-${p}-${q}.json`)], pass);
    await ok(a, ['admin', 'register', join(root, `${p}-info.json`), '--secret-from', join(root, `for-${p}-${q}.json`), '--out', join(root, `for-${q}-${p}.json`)], pass);
    await ok(dirs[p] as string, ['peer', 'import', join(root, `for-${p}-${q}.json`)]);
    await ok(dirs[q] as string, ['peer', 'import', join(root, `for-${q}-${p}.json`)]);
  };
  // The registration of D that A holds is the LAST one signed: a revocation covers the registrations whose serial (a timestamp) is at most the one A holds.
  await pair('c', 'd');
  await pair('a', 'c');
  await pair('a', 'd');
  // Carol allows `echo hello` to every peer.
  writeFileSync(join(root, 'draft-c.json'), JSON.stringify({ v: 1, target: readMachine(c).uuid, version: 1, baseVersion: 0, defaults: [{ shell: SHELL, command: 'echo hello' }], peers: {} }));
  await ok(a, ['admin', 'sign-policy', join(root, 'draft-c.json'), '--out', join(root, 'policy-c.json')], pass);
  await ok(c, ['policy', 'install', join(root, 'policy-c.json')]);
});
afterEach(async () => {
  while (stoppers.length > 0) await stoppers.pop()?.();
  rmSync(root, { recursive: true, force: true });
});

async function daemon(dir: string): Promise<string> {
  const running = await startMachineDaemon(dir, { port: 0, version: 'e2e', peerPort: 0, peerHost: '127.0.0.1' });
  stoppers.push(running.stop);
  return `127.0.0.1:${running.peerPort}`;
}

const runHello = (from: string, to: string, address: string) => cli(from, ['run', to, '--no-wait', '--address', address, '--shell', SHELL, '--', 'echo', 'hello']);
const revocationsOf = (dir: string): Array<{ uuid: string; serial: number }> => {
  const file = join(dir, 'revocations.json');
  return existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as { entries: Array<{ uuid: string; serial: number }> }).entries : [];
};

describe('revocation catch-up between peers', () => {
  it('C missed the revocation of D: A, who has it, connects to C, C installs it, and D can then no longer connect to C', async () => {
    const carol = await daemon(c);
    // Without a relay token the revocation reaches nobody: C still trusts D.
    const revoked = await cli(a, ['admin', 'revoke', 'dave'], pass, { ask: yes });
    expect(revoked.code, revoked.err).toBe(0);
    expect(revocationsOf(c)).toEqual([]);
    const before = await runHello(d, 'carol', carol);
    expect(before.code, before.err).toBe(0);

    const viaA = await runHello(a, 'carol', carol);
    expect(viaA.code, viaA.err).toBe(0);
    expect(viaA.out.trim()).toBe('hello');
    expect(revocationsOf(c).map((e) => e.uuid)).toEqual([readMachine(d).uuid]);

    // The daemon of C reloads its network: D is refused before any request.
    const after = await runHello(d, 'carol', carol);
    expect(after.code).toBe(255);
    expect(after.out).toBe('');
    expect(readFileSync(join(c, 'audit.log'), 'utf8')).toContain('revocation-catchup');
  });

  it('works the other way round: C, behind, connects to A (daemon) and installs the revocation A holds', async () => {
    const desktop = await daemon(a);
    const revoked = await cli(a, ['admin', 'revoke', 'dave'], pass, { ask: yes });
    expect(revoked.code, revoked.err).toBe(0);
    expect(revocationsOf(c)).toEqual([]);
    // A has no policy for C: the request itself is refused, but the catch-up comes first.
    const r = await runHello(c, 'desktop', desktop);
    expect(r.code).toBe(255);
    expect(revocationsOf(c).map((e) => e.uuid)).toEqual([readMachine(d).uuid]);
  });

  it('hands on every revocation of the admin, not only the last one signed', async () => {
    const carol = await daemon(c);
    const first = await cli(a, ['admin', 'revoke', 'dave'], pass, { ask: yes });
    expect(first.code, first.err).toBe(0);
    // A third machine revoked later: the list A holds must cover both.
    const e = join(root, 'e');
    await ok(e, ['init', '--name', 'erin']);
    await ok(e, ['peer', 'info', '--out', join(root, 'e-info.json')]);
    await ok(a, ['admin', 'register', join(root, 'e-info.json'), '--out', join(root, 'for-a-e.json')], pass);
    await ok(a, ['peer', 'import', join(root, 'for-a-e.json')]);
    const second = await cli(a, ['admin', 'revoke', 'erin'], pass, { ask: yes });
    expect(second.code, second.err).toBe(0);

    const viaA = await runHello(a, 'carol', carol);
    expect(viaA.code, viaA.err).toBe(0);
    expect(revocationsOf(c).map((e) => e.uuid).sort()).toEqual([readMachine(d).uuid, readMachine(e).uuid].sort());
  });

  it('sends nothing when both already hold the same revocations (nothing audited on the target)', async () => {
    const carol = await daemon(c);
    await cli(a, ['admin', 'revoke', 'dave'], pass, { ask: yes });
    await runHello(a, 'carol', carol);
    const log = readFileSync(join(c, 'audit.log'), 'utf8');
    const again = await runHello(a, 'carol', carol);
    expect(again.code, again.err).toBe(0);
    expect(again.err).toBe('');
    const catchups = (text: string) => text.split('\n').filter((l) => l.includes('revocation-catchup')).length;
    expect(catchups(readFileSync(join(c, 'audit.log'), 'utf8'))).toBe(catchups(log));
  });

  it('a corrupt revocation-seen.json never makes list or status fail: it is treated as empty and said so', async () => {
    writeFileSync(join(a, 'revocation-seen.json'), '{broken');
    const status = await ok(a, ['status', '--json']);
    expect((JSON.parse(status.out) as { problems: string[] }).problems.join('\n')).toMatch(/revocation-seen\.json.*(corrupt|invalid)/);
    const list = await cli(a, ['list', '--json']);
    expect(list.code, list.err).toBe(0);
    expect(list.err).toMatch(/revocation-seen\.json/);
  });

  it('shows per peer the revocation version last seen at the handshake, so the admin sees who is behind', async () => {
    const carol = await daemon(c);
    await cli(a, ['admin', 'revoke', 'dave'], pass, { ask: yes });
    const before = JSON.parse((await ok(a, ['list', '--json'])).out) as { peers: Array<{ name: string; revocationVersionSeen?: number }> };
    expect(before.peers.find((p) => p.name === 'carol')?.revocationVersionSeen).toBeUndefined();

    await runHello(a, 'carol', carol);
    const listed = JSON.parse((await ok(a, ['list', '--json'])).out) as { peers: Array<{ name: string; revocationVersionSeen?: number }> };
    // Carol announced version 0 (nothing held) at that handshake: behind.
    expect(listed.peers.find((p) => p.name === 'carol')?.revocationVersionSeen).toBe(0);
    const status = JSON.parse((await ok(a, ['status', '--json'])).out) as { revocationVersion: number; peersBehind: Array<{ name: string; revocationVersionSeen: number }> };
    expect(status.revocationVersion).toBeGreaterThan(0);
    expect(status.peersBehind.map((p) => p.name)).toEqual(['carol']);

    // The next handshake finds carol up to date.
    await runHello(a, 'carol', carol);
    const later = JSON.parse((await ok(a, ['status', '--json'])).out) as { revocationVersion: number; peersBehind: unknown[] };
    expect(later.peersBehind).toEqual([]);
    expect((await ok(a, ['list'])).out).toMatch(/carol[^\n]*\n?[^\n]*revocations: version \d+/);
  });
});
