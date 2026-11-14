import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildAddressRecord, verifyAddressRecord, generateSigningKeyPair, type AddressEntry, type SignedAddressRecord } from '@wadeck-app/machine-core';
import type { AdvertisedAddresses } from './addressDiscovery.js';
import { REFRESH_SECONDS, addressStateFile, createAddressPublisher, type AddressPublisher } from './addressPublisher.js';
import { startFakeRelay, type FakeRelay } from './fakeRelay.js';
import { initMachine, readMachine } from './identity.js';
import { createRelayClient } from './relayClient.js';

let root: string;
let dir: string;
let relay: FakeRelay;
let now: number;
let logs: string[];
let enrolled: boolean;
let advertised: AdvertisedAddresses;

const START = 1_800_000_000;
/** Seqs start above the clock (a fresh state must start above anything an older life published): the n-th publication at the start time. */
const S = (n: number) => START + n;
const A: AddressEntry[] = [{ host: '192.168.1.20', port: 47921 }];
const B: AddressEntry[] = [{ host: '192.168.1.20', port: 47921 }, { host: '10.0.0.7', port: 47921 }];
const discovered = (addresses: AddressEntry[]): AdvertisedAddresses => ({ source: 'discovered', addresses });

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'machine-publisher-'));
  dir = join(root, 'laptop');
  initMachine(dir, 'laptop');
  relay = await startFakeRelay();
  relay.setClock(() => now);
  now = START;
  logs = [];
  enrolled = true;
  advertised = discovered(A);
});

afterEach(async () => {
  await relay.close();
  rmSync(root, { recursive: true, force: true });
});

const self = () => readMachine(dir);
const puts = () => relay.requests.filter((r) => r.method === 'PUT' && r.path === `/api/machines/${self().uuid}`);
const gets = () => relay.requests.filter((r) => r.method === 'GET' && r.path === `/api/machines/${self().uuid}`);
const stateSeq = () => (JSON.parse(readFileSync(addressStateFile(dir), 'utf8')) as { seq: number }).seq;

function publisher(options: { token?: string; configDir?: string } = {}): AddressPublisher {
  const configDir = options.configDir ?? dir;
  return createAddressPublisher({
    configDir,
    self: readMachine(configDir),
    client: createRelayClient({ baseUrl: relay.url, token: options.token ?? relay.token }),
    now: () => now,
    log: (line) => logs.push(line),
    addresses: () => advertised,
    isEnrolled: () => enrolled,
  });
}

const onRelay = async () => createRelayClient({ baseUrl: relay.url, token: relay.token }).getMachine(self().uuid);
const verifyOnRelay = async (): Promise<{ seq: number; hosts: string[] }> => {
  const entry = await onRelay();
  if (!entry) throw new Error('no record on the relay');
  const r = verifyAddressRecord(entry.record, { uuid: self().uuid, identityPublicKey: self().identity.publicKey }, now);
  if (!r.ok) throw new Error(`record on the relay does not verify: ${r.message}`);
  return { seq: r.body.seq, hosts: r.body.addresses.map((a) => `${a.host}:${a.port}`) };
};

describe('address publisher', () => {
  it('publishes a record signed by the identity key, with a seq above the clock and the advertised addresses', async () => {
    await publisher().tick();
    expect(await verifyOnRelay()).toEqual({ seq: S(1), hosts: ['192.168.1.20:47921'] });
    expect(logs.join('\n')).toContain(`address record published (seq ${S(1)}): 192.168.1.20:47921`);
  });

  it('writes the seq under _secrets_/address-state.json and the first PUT binds the inbox to this token', async () => {
    await publisher().tick();
    expect(addressStateFile(dir)).toContain('_secrets_');
    expect(stateSeq()).toBe(S(1));
    // The inbox of this machine can now be read with its token (not_owner before).
    await expect(createRelayClient({ baseUrl: relay.url, token: relay.token }).listInbox(self().uuid)).resolves.toEqual([]);
  });

  it('does nothing while the set is unchanged (no PUT, and no GET after the first publication)', async () => {
    const p = publisher();
    await p.tick();
    const requestsBefore = relay.requests.length;
    now += 60;
    await p.tick();
    now += 60;
    await p.tick();
    expect(relay.requests.length).toBe(requestsBefore);
  });

  it('publishes again with a higher seq when the address set changes', async () => {
    const p = publisher();
    await p.tick();
    advertised = discovered(B);
    now += 60;
    await p.tick();
    expect(await verifyOnRelay()).toEqual({ seq: S(61), hosts: ['192.168.1.20:47921', '10.0.0.7:47921'] });
    expect(stateSeq()).toBe(S(61));
    expect(puts()).toHaveLength(2);
  });

  it('publishes again after 7 days without a change, so that the record never reaches the 30 days of expiry', async () => {
    const p = publisher();
    await p.tick();
    now += REFRESH_SECONDS - 1;
    await p.tick();
    expect(puts()).toHaveLength(1);
    now += 1;
    await p.tick();
    expect(puts()).toHaveLength(2);
    expect((await verifyOnRelay()).seq).toBe(S(REFRESH_SECONDS + 1));
    expect(REFRESH_SECONDS).toBe(7 * 86_400);
  });

  it('a restart continues after the stored seq: a seq is never reused', async () => {
    await publisher().tick();
    advertised = discovered(B);
    await publisher().tick();
    expect(stateSeq()).toBe(S(2));
    // A third daemon start, same addresses: a fresh record anyway, seq 3.
    await publisher().tick();
    expect((await verifyOnRelay()).seq).toBe(S(3));
  });

  it('a lost state file cannot make the new record lose against what peers already saw: seqs start above the clock', async () => {
    await publisher().tick();
    advertised = discovered(B);
    const old = (await onRelay())?.record as SignedAddressRecord;
    await publisher().tick();
    rmSync(addressStateFile(dir));
    // Later: the relay serves an OLDER record of this machine (a stale copy), and the peers hold a higher seq than that copy.
    now = START + 100;
    await createRelayClient({ baseUrl: relay.url, token: relay.adminToken }).putRecord(self().uuid, old);
    const peerHeld = { seq: START + 50, signature: 'whatever' };
    await publisher().tick();
    const entry = await onRelay();
    const checked = verifyAddressRecord(entry?.record, { uuid: self().uuid, identityPublicKey: self().identity.publicKey }, now, peerHeld);
    expect(checked.ok, checked.ok ? '' : checked.message).toBe(true);
    expect(stateSeq()).toBeGreaterThan(START + 100);
  });

  it('the seq is above max(state, relay, clock): a state ahead of the clock keeps counting, never goes back', async () => {
    await publisher().tick();
    writeFileSync(addressStateFile(dir), JSON.stringify({ v: 1, seq: START + 10_000 }));
    advertised = discovered(B);
    await publisher().tick();
    expect(stateSeq()).toBe(START + 10_001);
  });

  it('a record that cannot be built (over 2 KiB) burns no seq and never touches the state file', async () => {
    const longName = `${'a'.repeat(60)}.${'b'.repeat(60)}.${'c'.repeat(60)}.${'d'.repeat(60)}`;
    advertised = discovered(Array.from({ length: 8 }, (_, i) => ({ host: `${i}${longName}`, port: 47921 })));
    const p = publisher();
    await p.tick();
    expect(existsSync(addressStateFile(dir))).toBe(false);
    expect(logs.join(' | ')).toMatch(/2048|too large|advertise fewer/);
    expect(puts()).toHaveLength(0);
  });

  it('does not adopt the seq of a record on the relay that this machine did not sign (a relay cannot burn the counter), and says so', async () => {
    const stranger = generateSigningKeyPair();
    const forged = buildAddressRecord({ uuid: self().uuid, addresses: A, seq: 900, issuedAt: now }, stranger.privateKeyPkcs8);
    await createRelayClient({ baseUrl: relay.url, token: relay.adminToken }).putRecord(self().uuid, forged);
    await publisher().tick();
    expect(await verifyOnRelay()).toMatchObject({ seq: S(1) });
    expect(logs.join('\n')).toMatch(/not signed by this machine/);
  });

  it('writes the new seq BEFORE the PUT, and retries the very same record after a failure (no seq burned)', async () => {
    const p = publisher();
    relay.force(`/api/machines/${self().uuid}`, 500, { success: false, error: 'store_unavailable', message: 'down' }, {}, 'PUT');
    await p.tick();
    expect(stateSeq()).toBe(S(1));
    expect(await onRelay()).toBeUndefined();
    now += 60;
    await p.tick();
    expect(stateSeq()).toBe(S(1));
    expect(await verifyOnRelay()).toMatchObject({ seq: S(1) });
    expect(JSON.stringify(puts()[0]?.body)).toBe(JSON.stringify(puts()[1]?.body));
  });

  it('after a failure with an address change in between, the new set gets a new seq', async () => {
    const p = publisher();
    relay.force(`/api/machines/${self().uuid}`, 500, { success: false, error: 'store_unavailable', message: 'down' }, {}, 'PUT');
    await p.tick();
    advertised = discovered(B);
    now += 60;
    await p.tick();
    expect(await verifyOnRelay()).toEqual({ seq: S(61), hosts: ['192.168.1.20:47921', '10.0.0.7:47921'] });
  });

  it('a 412 reloads the etag (and the seq) and retries once', async () => {
    const p = publisher();
    await p.tick();
    advertised = discovered(B);
    // Someone (a second daemon of the same machine, an admin) changed the record meanwhile: the etag no longer matches.
    const meanwhile = buildAddressRecord({ uuid: self().uuid, addresses: [{ host: '10.9.9.9', port: 1 }], seq: S(100), issuedAt: now }, self().identity.privateKeyPkcs8);
    await createRelayClient({ baseUrl: relay.url, token: relay.token }).putRecord(self().uuid, meanwhile);
    now += 60;
    await p.tick();
    // Our record won, with a seq above the one that was there.
    expect(await verifyOnRelay()).toEqual({ seq: S(101), hosts: ['192.168.1.20:47921', '10.0.0.7:47921'] });
    expect(puts().length).toBeGreaterThanOrEqual(3);
    expect(stateSeq()).toBe(S(101));
  });

  it('a 412 that persists is a failure said once, never a loop (one retry only)', async () => {
    const p = publisher();
    await p.tick();
    advertised = discovered(B);
    const path = `/api/machines/${self().uuid}`;
    relay.force(path, 412, { success: false, error: 'precondition_failed', message: 'x', currentEtag: '99' }, {}, 'PUT');
    relay.force(path, 412, { success: false, error: 'precondition_failed', message: 'x', currentEtag: '99' }, {}, 'PUT');
    now += 60;
    await p.tick();
    expect(puts()).toHaveLength(3);
    expect(logs.filter((l) => /changed on the relay/.test(l))).toHaveLength(1);
  });

  describe('not_owner (token rotation)', () => {
    it('says once, loudly, what happened and the exact fix, and tries again at every round', async () => {
      relay.setOwner(self().uuid, 'tok_old');
      await createRelayClient({ baseUrl: relay.url, token: relay.adminToken }).putRecord(self().uuid, buildAddressRecord({ uuid: self().uuid, addresses: A, seq: 1, issuedAt: now }, self().identity.privateKeyPkcs8));
      const before = puts().length;
      const p = publisher();
      await p.tick();
      now += 60;
      await p.tick();
      now += 60;
      await p.tick();
      const lines = logs.filter((l) => /not_owner/.test(l));
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain('machine admin forget-relay-record');
      expect(lines[0]).toMatch(/inbox/);
      expect(lines[0]).toContain(self().uuid);
      // No backoff for a state: every round tries again.
      expect(puts().length - before).toBe(3);
    });

    it('recovers by itself once the admin removed the old record, and says so', async () => {
      relay.setOwner(self().uuid, 'tok_old');
      const p = publisher();
      await p.tick();
      await createRelayClient({ baseUrl: relay.url, token: relay.adminToken }).deleteMachine(self().uuid);
      now += 60;
      await p.tick();
      expect((await verifyOnRelay()).seq).toBeGreaterThanOrEqual(S(1));
      expect(logs.join('\n')).toMatch(/address record published/);
      expect(logs.join('\n')).toMatch(/owns its address record again|is published again/);
      // A later rotation is said again.
      logs.length = 0;
      relay.setOwner(self().uuid, 'tok_newer');
      advertised = discovered(B);
      now += 60;
      await p.tick();
      expect(logs.filter((l) => /not_owner/.test(l))).toHaveLength(1);
    });
  });

  describe('relay trouble (never a crash, one warning per distinct message)', () => {
    it('429 honours Retry-After, sends nothing during the wait and one warning', async () => {
      const p = publisher();
      const path = `/api/machines/${self().uuid}`;
      relay.force(path, 429, { success: false, error: 'rate_limited', message: 'slow' }, { 'Retry-After': '300' }, 'PUT');
      await p.tick();
      const count = relay.requests.length;
      now += 299;
      await p.tick();
      expect(relay.requests.length).toBe(count);
      now += 1;
      await p.tick();
      expect(puts()).toHaveLength(2);
      expect(logs.filter((l) => /rate limiting/.test(l))).toHaveLength(1);
      expect((await verifyOnRelay()).seq).toBe(S(1));
    });

    it('5xx backs off 60, 120, 240 s and caps at 600 s; the same message is said once; success says it works again', async () => {
      const p = publisher();
      const path = `/api/machines/${self().uuid}`;
      for (let i = 0; i < 6; i++) relay.force(path, 503, { success: false, error: 'store_unavailable', message: 'down' }, {}, 'PUT');
      const attemptAt: number[] = [];
      const before = () => puts().length;
      // Walk the clock one second at a time: an attempt is a new PUT.
      for (let t = 0; t < 2400 && attemptAt.length < 6; t++) {
        const n = before();
        await p.tick();
        if (puts().length > n) attemptAt.push(now - START);
        now += 1;
      }
      expect(attemptAt.slice(0, 6)).toEqual([0, 60, 180, 420, 900, 1500]);
      expect(logs.filter((l) => /failed \(503\)/.test(l))).toHaveLength(1);
      // The next attempt succeeds: said once.
      for (let i = 0; i < 700 && puts().length < 7; i++) {
        await p.tick();
        now += 1;
      }
      expect(logs.filter((l) => /address record: the relay is working again|published again after/.test(l)).length).toBe(1);
      expect((await verifyOnRelay()).seq).toBe(S(1));
    });

    it('an unreachable relay is a warning, not an exception', async () => {
      const p = publisher();
      await relay.close();
      await expect(p.tick()).resolves.toBeUndefined();
      expect(logs.join('\n')).toMatch(/address record/);
      expect(logs.join('\n')).toMatch(/cannot reach the relay/);
      // Restart the fake for afterEach.
      relay = await startFakeRelay();
    });

    it('a 401 is said once with the fix (the stored token is refused)', async () => {
      const p = publisher({ token: 'tok_wrong' });
      await p.tick();
      expect(logs.filter((l) => /machine join/.test(l))).toHaveLength(1);
    });
  });

  describe('when nothing can be published', () => {
    it('not enrolled: no request at all, said once', async () => {
      enrolled = false;
      const p = publisher();
      await p.tick();
      await p.tick();
      expect(relay.requests).toHaveLength(0);
      expect(logs.filter((l) => /not enrolled/.test(l))).toHaveLength(1);
      // Enrolled later: it publishes.
      enrolled = true;
      await p.tick();
      expect((await verifyOnRelay()).seq).toBe(S(1));
    });

    it('no address: no publication, a loud warning once per distinct reason, and the record already on the relay is left alone', async () => {
      advertised = { source: 'discovered', addresses: [], problem: 'no network address was found on this machine' };
      const p = publisher();
      await p.tick();
      await p.tick();
      expect(relay.requests).toHaveLength(0);
      expect(logs.filter((l) => /no network address was found/.test(l))).toHaveLength(1);
      expect(logs[0]).toMatch(/address record NOT published/);
      advertised = { source: 'discovered', addresses: [], problem: 'another reason' };
      await p.tick();
      expect(logs.filter((l) => /another reason/.test(l))).toHaveLength(1);
      advertised = discovered(A);
      await p.tick();
      expect((await verifyOnRelay()).seq).toBe(S(1));
    });

    it('a corrupt address-state.json stops the publication with the file name and the fix, never resets the counter silently', async () => {
      mkdirSync(join(dir, '_secrets_'), { recursive: true });
      writeFileSync(addressStateFile(dir), '{not json');
      const p = publisher();
      await expect(p.tick()).resolves.toBeUndefined();
      expect(relay.requests).toHaveLength(0);
      expect(logs.join('\n')).toContain('address-state.json');
      expect(logs.join('\n')).toMatch(/Delete it/);
    });

    it('a state file of the wrong shape is refused as well', async () => {
      mkdirSync(join(dir, '_secrets_'), { recursive: true });
      writeFileSync(addressStateFile(dir), JSON.stringify({ v: 1, seq: -3 }));
      await publisher().tick();
      expect(relay.requests).toHaveLength(0);
      expect(logs.join('\n')).toMatch(/address-state\.json is corrupt or invalid/);
    });
  });

  it('a truncation warning of the discovery is said loudly, once, and the record is still published', async () => {
    advertised = { source: 'discovered', addresses: A, warning: '11 network addresses were found, only 8 fit' };
    const p = publisher();
    await p.tick();
    advertised = { source: 'discovered', addresses: B, warning: '11 network addresses were found, only 8 fit' };
    now += 60;
    await p.tick();
    expect(logs.filter((l) => /address record: .*only 8 fit/.test(l))).toHaveLength(1);
    expect((await verifyOnRelay()).seq).toBe(S(61));
  });

  it('never puts the token in a log line', async () => {
    relay.setOwner(self().uuid, 'tok_old');
    await publisher().tick();
    expect(logs.join('\n')).not.toContain(relay.token);
  });
});
