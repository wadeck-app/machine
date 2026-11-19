import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { newCandidacyRandom } from '@wadeck-app/machine-core';
import { startFakeRelay, type FakeRelay } from './fakeRelay.js';
import { readMachine } from './identity.js';
import { exportMachineInfo, resolveRevokedMachine, revokedMachines } from './network.js';
import { cli, makeAdmin, ok, type TestAdmin } from './testing.js';

// UX audit 16: after a revoke the name is gone from the directory. A revoked machine is still found by its name (the registration
// stays in peers.json) or by its uuid, `machine status` lists it with its uuid and when the revocation was installed here.

let root: string;
let adminDir: string;
let relay: FakeRelay;
let admin: TestAdmin;

const yes = async () => 'y';
const pass = async () => admin.passphrase;
const dirOf = (name: string) => join(root, name);
const uuidOf = (name: string) => readMachine(dirOf(name)).uuid;
const deletes = () => relay.requests.filter((q) => q.method === 'DELETE').map((q) => q.path);
// The revoke itself removes the machine from the relay: what a later command deletes is what comes after this count.
let deletedBefore = 0;
const deletedSince = () => deletes().slice(deletedBefore);

async function enroll(dir: string, id: string) {
  const info = exportMachineInfo(dir);
  relay.addCandidacy(id, { name: info.name, hostname: 'h', identityPublicKey: info.identityPublicKey, random: newCandidacyRandom(), uuid: info.uuid });
  const r = await cli(adminDir, ['admin', 'approve', id, '--relay', relay.url], pass, { ask: yes });
  if (r.code !== 0) throw new Error(`approve failed: ${r.err}`);
}
const revoke = async (name: string) => {
  const r = await cli(adminDir, ['admin', 'revoke', name], pass, { ask: yes });
  if (r.code !== 0) throw new Error(`revoke failed: ${r.err}`);
  deletedBefore = deletes().length;
};

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'machine-revoked-'));
  adminDir = dirOf('desktop');
  for (const name of ['desktop', 'laptop']) {
    mkdirSync(dirOf(name));
    await ok(dirOf(name), ['init', '--name', name]);
  }
  relay = await startFakeRelay();
  admin = makeAdmin(adminDir);
  await ok(adminDir, ['admin', 'login', '87654321', '--full-access', '--relay', relay.url]);
  await enroll(dirOf('laptop'), 'cand-laptop');
});
afterEach(async () => {
  await relay.close();
  rmSync(root, { recursive: true, force: true });
});

describe('revoked machines are still named', () => {
  it('revokedMachines: name, uuid, serial and the time the revocation was installed on this machine', async () => {
    expect(revokedMachines(adminDir)).toEqual([]);
    const before = Math.floor(Date.now() / 1000);
    await revoke('laptop');
    const [entry] = revokedMachines(adminDir);
    expect(entry).toMatchObject({ uuid: uuidOf('laptop'), name: 'laptop' });
    expect(entry?.serial).toBeGreaterThan(0);
    expect(entry?.installedAt).toBeGreaterThanOrEqual(before);
    expect(entry?.installedAt).toBeLessThanOrEqual(Math.floor(Date.now() / 1000) + 1);
  });

  it('resolveRevokedMachine: by name, by uuid, by uuid prefix; an unknown reference says nothing matched', async () => {
    await revoke('laptop');
    const uuid = uuidOf('laptop');
    expect(resolveRevokedMachine(adminDir, 'laptop', {})).toMatchObject({ ok: true, machine: { uuid } });
    expect(resolveRevokedMachine(adminDir, 'LAPTOP', {})).toMatchObject({ ok: true, machine: { uuid } });
    expect(resolveRevokedMachine(adminDir, uuid, {})).toMatchObject({ ok: true, machine: { uuid } });
    expect(resolveRevokedMachine(adminDir, uuid.slice(0, 8), {})).toMatchObject({ ok: true, machine: { uuid } });
    expect(resolveRevokedMachine(adminDir, 'nobody', {})).toMatchObject({ ok: false, reason: 'none' });
  });

  it('forget-relay-record by name after a revoke: deletes the uuid on the relay and says the machine is revoked', async () => {
    await revoke('laptop');
    const r = await cli(adminDir, ['admin', 'forget-relay-record', 'laptop'], undefined, { ask: yes });
    expect(r.code, r.err).toBe(0);
    expect(deletedSince()).toEqual([`/api/machines/${uuidOf('laptop')}`]);
    expect(r.out).toMatch(/"laptop" \(revoked/);
    // The advice for a machine that is still in use (distribute its documents again) does not apply to a revoked one.
    expect(r.out).toMatch(/stays revoked on this machine/);
    expect(r.out).not.toMatch(/admin distribute/);
    expect(r.err).not.toMatch(/no machine is registered yet/);
  });

  it('forget-relay-record by a uuid prefix works too, and --json carries the name', async () => {
    await revoke('laptop');
    const r = await cli(adminDir, ['admin', 'forget-relay-record', uuidOf('laptop').slice(0, 8), '--json'], undefined, { ask: yes });
    expect(r.code, r.err).toBe(0);
    expect(JSON.parse(r.out)).toEqual({ forgot: uuidOf('laptop'), name: 'laptop' });
  });

  it('two revoked machines with the same name: refused, both uuids listed, nothing deleted', async () => {
    await revoke('laptop');
    mkdirSync(dirOf('laptop2'));
    await ok(dirOf('laptop2'), ['init', '--name', 'laptop']);
    await enroll(dirOf('laptop2'), 'cand-laptop2');
    await revoke('laptop');
    const r = await cli(adminDir, ['admin', 'forget-relay-record', 'laptop'], undefined, { ask: yes });
    expect(r.code).toBe(3);
    expect(r.err).toContain(uuidOf('laptop'));
    expect(r.err).toContain(uuidOf('laptop2'));
    expect(r.err).toMatch(/give the uuid/);
    expect(deletedSince()).toHaveLength(0);
  });

  it('an unknown name says which kinds of machine the command takes and where to list them', async () => {
    await revoke('laptop');
    const r = await cli(adminDir, ['admin', 'forget-relay-record', 'nobody'], undefined, { ask: yes });
    expect(r.code).toBe(3);
    expect(r.err).toMatch(/revoked machine/);
    expect(r.err).toMatch(/machine status/);
    expect(deletedSince()).toHaveLength(0);
  });

  it('admin distribute takes a revoked machine by name as well', async () => {
    await revoke('laptop');
    const r = await cli(adminDir, ['admin', 'distribute', 'laptop'], pass, { ask: yes });
    expect(r.code, r.err).toBe(0);
    // The revocation is sent again: the revoked machine is removed from the relay once more.
    expect(deletedSince()).toEqual([`/api/machines/${uuidOf('laptop')}`]);
  });
});

describe('machine status lists the revoked machines apart', () => {
  it('no revoked machine: no block', async () => {
    const r = await ok(adminDir, ['status']);
    expect(r.out).not.toMatch(/revoked machines/);
    expect(JSON.parse((await ok(adminDir, ['status', '--json'])).out)).not.toHaveProperty('revoked');
  });

  it('after a revoke: a separate block with name, short uuid and when, never the full uuid line of a trusted peer; --json has the full uuid', async () => {
    await revoke('laptop');
    const r = await ok(adminDir, ['status']);
    const uuid = uuidOf('laptop');
    expect(r.out).toMatch(/enrolled, 0 peer\(s\)/);
    // Named in its own block, not also as a warning about a broken registration.
    expect(r.out).not.toMatch(/\[warn\].*registration revoked/);
    expect(r.out).toMatch(/revoked machines \(1\)/);
    expect(r.out).toContain(`laptop  uuid ${uuid.slice(0, 8)}`);
    expect(r.out).toMatch(/revocation installed here (now|\d+ (s|min) ago) \(\d\d:\d\d\)/);
    expect(r.out).not.toMatch(/20\d\d-\d\d-\d\dT/);
    expect(r.out).toContain('machine admin forget-relay-record laptop');
    const json = JSON.parse((await ok(adminDir, ['status', '--json'])).out) as { revoked: { uuid: string; name: string; serial: number; installedAt: number }[] };
    expect(json.revoked).toHaveLength(1);
    expect(json.revoked[0]).toMatchObject({ uuid, name: 'laptop' });
    expect(typeof json.revoked[0]?.installedAt).toBe('number');
  });
});
