import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildAddressRecord, newCandidacyRandom } from '@wadeck-app/machine-core';
import { startFakeRelay, type FakeRelay } from './fakeRelay.js';
import { readMachine } from './identity.js';
import { exportMachineInfo } from './network.js';
import { createRelayClient } from './relayClient.js';
import { cli, makeAdmin, ok, type TestAdmin } from './testing.js';

// `machine admin forget-relay-record <machine>`: the fix of the `not_owner` an address record write gets after a token rotation
// (relay-api.md, "Deployed limits"; distribution.md, "Ownership"): DELETE /api/machines/{uuid} with the admin relay token.

let root: string;
let adminDir: string;
let relay: FakeRelay;
let admin: TestAdmin;

const yes = async () => 'y';
const no = async () => 'n';
const dirOf = (name: string) => join(root, name);
const uuidOf = (name: string) => readMachine(dirOf(name)).uuid;
const asMachine = () => createRelayClient({ baseUrl: relay.url, token: relay.token });
const pass = async () => admin.passphrase;

async function enroll(name: string) {
  const info = exportMachineInfo(dirOf(name));
  const id = `cand-${name}`;
  relay.addCandidacy(id, { name: info.name, hostname: 'h', identityPublicKey: info.identityPublicKey, random: newCandidacyRandom(), uuid: info.uuid });
  const r = await cli(adminDir, ['admin', 'approve', id, '--relay', relay.url], pass, { ask: yes });
  if (r.code !== 0) throw new Error(`approve failed: ${r.err}`);
}

async function publishRecord(name: string) {
  const self = readMachine(dirOf(name));
  await asMachine().putRecord(self.uuid, buildAddressRecord({ uuid: self.uuid, addresses: [{ host: '10.0.0.5', port: 47921 }], seq: 1, issuedAt: Math.floor(Date.now() / 1000) }, self.identity.privateKeyPkcs8));
}

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'machine-forget-'));
  adminDir = dirOf('desktop');
  for (const name of ['desktop', 'laptop']) {
    mkdirSync(dirOf(name));
    await ok(dirOf(name), ['init', '--name', name]);
  }
  relay = await startFakeRelay();
  admin = makeAdmin(adminDir);
  await ok(adminDir, ['admin', 'login', '87654321', '--full-access', '--relay', relay.url]);
  await enroll('laptop');
  // The relay bound the uuid of laptop to its token when the candidacy of that token was approved.
  relay.setOwner(uuidOf('laptop'), relay.token);
});
afterEach(async () => {
  await relay.close();
  rmSync(root, { recursive: true, force: true });
});

describe('machine admin forget-relay-record', () => {
  it('removes the record, the owner binding and the inbox of the machine on the relay, after a y/N, with the admin relay token', async () => {
    await publishRecord('laptop');
    expect(await asMachine().getMachine(uuidOf('laptop'))).toBeDefined();
    const r = await cli(adminDir, ['admin', 'forget-relay-record', 'laptop'], undefined, { ask: yes });
    expect(r.code, r.err).toBe(0);
    expect(await asMachine().getMachine(uuidOf('laptop'))).toBeUndefined();
    const del = relay.requests.filter((q) => q.method === 'DELETE' && q.path === `/api/machines/${uuidOf('laptop')}`);
    expect(del).toHaveLength(1);
    expect(del[0]?.authorization).toBe(`Bearer ${relay.adminToken}`);
    expect(r.out).toMatch(/the relay forgot/);
    expect(r.out).toContain(uuidOf('laptop'));
    // What happens next is said: the binding is gone too (deployed relay), so the machine does NOT publish again by itself.
    expect(r.out).not.toMatch(/publishes again by itself/);
    expect(r.out).toMatch(/not registered|approved again/);
    expect(r.out).toContain('machine join --resume');
    expect(r.out).toMatch(/machine admin approve/);
    expect(r.out).toContain('machine admin distribute');
  });

  it('the binding goes with the record: the machine is not_registered afterwards until a new candidacy is approved (rebind)', async () => {
    await publishRecord('laptop');
    const rotated = createRelayClient({ baseUrl: relay.url, token: relay.addMachineToken() });
    const self = readMachine(dirOf('laptop'));
    const record = buildAddressRecord({ uuid: self.uuid, addresses: [{ host: '10.0.0.6', port: 1 }], seq: 2, issuedAt: Math.floor(Date.now() / 1000) }, self.identity.privateKeyPkcs8);
    await expect(rotated.putRecord(self.uuid, record)).rejects.toMatchObject({ code: 'not_owner' });
    const r = await cli(adminDir, ['admin', 'forget-relay-record', 'laptop'], undefined, { ask: yes });
    expect(r.code, r.err).toBe(0);
    await expect(rotated.putRecord(self.uuid, record)).rejects.toMatchObject({ code: 'not_registered' });
    await expect(asMachine().putRecord(self.uuid, record)).rejects.toMatchObject({ code: 'not_registered' });
  });

  it('asks first: a "no" removes nothing and exits 1 with what was not done', async () => {
    await publishRecord('laptop');
    const r = await cli(adminDir, ['admin', 'forget-relay-record', 'laptop'], undefined, { ask: no });
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/not removed.*Nothing was deleted/s);
    expect(await asMachine().getMachine(uuidOf('laptop'))).toBeDefined();
    expect(relay.requests.some((q) => q.method === 'DELETE')).toBe(false);
  });

  it('without a terminal it refuses and says nothing was deleted', async () => {
    const r = await cli(adminDir, ['admin', 'forget-relay-record', 'laptop'], undefined, {
      ask: async () => {
        throw new Error('no terminal');
      },
    });
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/no terminal/);
    expect(r.err).toMatch(/Nothing was deleted/);
  });

  it('accepts a uuid the directory does not know (a machine that was revoked or removed)', async () => {
    const stranger = '11111111-2222-4333-8444-555555555555';
    const r = await cli(adminDir, ['admin', 'forget-relay-record', stranger], undefined, { ask: yes });
    expect(r.code, r.err).toBe(0);
    expect(relay.requests.some((q) => q.method === 'DELETE' && q.path === `/api/machines/${stranger}`)).toBe(true);
  });

  it('an unknown name is exit 3 (reference), nothing is sent', async () => {
    const r = await cli(adminDir, ['admin', 'forget-relay-record', 'nobody'], undefined, { ask: yes });
    expect(r.code).toBe(3);
    expect(r.err).toMatch(/nobody/);
    expect(relay.requests.some((q) => q.method === 'DELETE')).toBe(false);
  });

  it('without an admin relay token it says how to get one', async () => {
    const lone = dirOf('lone');
    mkdirSync(lone);
    await ok(lone, ['init', '--name', 'lone']);
    const r = await cli(lone, ['admin', 'forget-relay-record', '11111111-2222-4333-8444-555555555555'], undefined, { ask: yes });
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/no admin relay token/);
    expect(r.err).toMatch(/machine admin login/);
  });

  it('a refused admin token (machine token stored) says so with the fix, not a generic 403', async () => {
    relay.force(`/api/machines/${uuidOf('laptop')}`, 403, { success: false, error: 'scope_denied', message: 'needs full access' }, {}, 'DELETE');
    const r = await cli(adminDir, ['admin', 'forget-relay-record', 'laptop'], undefined, { ask: yes });
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/plain machine token/);
    expect(r.err).toMatch(/machine admin login/);
  });

  it('--json prints one JSON document', async () => {
    const r = await cli(adminDir, ['admin', 'forget-relay-record', 'laptop', '--json'], undefined, { ask: yes });
    expect(r.code, r.err).toBe(0);
    expect(JSON.parse(r.out)).toEqual({ forgot: uuidOf('laptop'), name: 'laptop' });
  });

  it('takes exactly one machine', async () => {
    expect((await cli(adminDir, ['admin', 'forget-relay-record'], undefined, { ask: yes })).code).toBe(2);
    expect((await cli(adminDir, ['admin', 'forget-relay-record', 'a', 'b'], undefined, { ask: yes })).code).toBe(2);
  });

  it('is in the help: for machines that are gone (and the too_many_machines limit), not the first-writer story', async () => {
    const r = await cli(adminDir, ['--help']);
    expect(r.out).toMatch(/admin forget-relay-record <machine\|uuid>/);
    expect(r.out).toMatch(/too_many_machines/);
    expect(r.out).toMatch(/are gone/);
    expect(r.out).not.toMatch(/first token that wrote/);
  });
});
