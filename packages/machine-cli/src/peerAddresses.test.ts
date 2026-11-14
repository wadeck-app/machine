import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildAddressRecord, generateSigningKeyPair, type AddressEntry, type SignedAddressRecord } from '@wadeck-app/machine-core';
import { startFakeRelay, type FakeRelay } from './fakeRelay.js';
import { readMachine } from './identity.js';
import { loadNetwork } from './network.js';
import { PeerAddressError, commitRecords, forgetPeerRecord, connectFirst, describeAddress, peerRecordsFile, readPeerRecords, resolvePeerAddresses, lookupPeerPresence } from './peerAddresses.js';
import { createRelayClient, type RelayClient } from './relayClient.js';
import { provision } from './testing.js';

let root: string;
let a: string;
let b: string;
let relay: FakeRelay;
let now: number;
let publisher: RelayClient;
let admin: RelayClient;

const A1: AddressEntry[] = [{ host: '192.168.1.20', port: 47921 }];
const A2: AddressEntry[] = [{ host: '10.0.0.7', port: 47921 }, { host: '192.168.1.20', port: 47921 }];

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'machine-peer-addr-'));
  a = join(root, 'a');
  b = join(root, 'b');
  mkdirSync(a);
  mkdirSync(b);
  await provision(root, a, b, []);
  relay = await startFakeRelay();
  now = Math.floor(Date.now() / 1000);
  relay.setClock(() => now);
  // The admin approved laptop with this token: the relay bound its uuid to it (ownership bound at approval).
  relay.setOwner(laptop().uuid, relay.token);
  publisher = createRelayClient({ baseUrl: relay.url, token: relay.token });
  admin = createRelayClient({ baseUrl: relay.url, token: relay.adminToken });
});
afterEach(async () => {
  await relay.close();
  rmSync(root, { recursive: true, force: true });
});

const laptop = () => readMachine(b);
/** The record machine B would publish. `key` signs it (default: B's real identity key). */
const record = (seq: number, addresses: AddressEntry[] = A1, options: { key?: Uint8Array; issuedAt?: number; uuid?: string } = {}): SignedAddressRecord =>
  buildAddressRecord({ uuid: options.uuid ?? laptop().uuid, addresses, seq, issuedAt: options.issuedAt ?? now }, options.key ?? laptop().identity.privateKeyPkcs8);
const publish = (r: SignedAddressRecord) => publisher.putRecord(laptop().uuid, r);
const peerOf = () => {
  const peer = loadNetwork(a, now).directory.find(laptop().uuid);
  if (!peer) throw new Error('laptop is not a trusted peer of desktop');
  return { uuid: peer.peerId, name: peer.name, identityPublicKey: peer.identityPublicKey };
};
const resolve = () => resolvePeerAddresses(a, peerOf(), publisher, now);
const refused = async (): Promise<PeerAddressError> => {
  try {
    await resolve();
  } catch (e) {
    expect(e).toBeInstanceOf(PeerAddressError);
    return e as PeerAddressError;
  }
  throw new Error('expected the resolution to fail');
};

describe('resolvePeerAddresses', () => {
  it('verifies the record against the registration of the peer and returns the addresses in the published order', async () => {
    await publish(record(1, A2));
    const r = await resolve();
    expect(r.addresses).toEqual(A2);
    expect(r.seq).toBe(1);
    expect(r.online).toBe(true);
  });

  it('remembers the highest seq of the peer in peer-records.json (a public state file, not under _secrets_)', async () => {
    await publish(record(3));
    await resolve();
    expect(peerRecordsFile(a)).not.toContain('_secrets_');
    expect(readPeerRecords(a)[laptop().uuid]).toMatchObject({ seq: 3, addresses: A1 });
  });

  it('accepts a higher seq and updates the state', async () => {
    await publish(record(1));
    await resolve();
    await publish(record(2, A2));
    expect((await resolve()).addresses).toEqual(A2);
    expect(readPeerRecords(a)[laptop().uuid]?.seq).toBe(2);
  });

  it('accepts the same record again (idempotent)', async () => {
    await publish(record(4));
    await resolve();
    await expect(resolve()).resolves.toMatchObject({ seq: 4 });
  });

  it('refuses a rollback (an older record served by the relay), says both seq values, how to bypass, and keeps the state', async () => {
    await publish(record(5, A2));
    await resolve();
    await admin.putRecord(laptop().uuid, record(4, A1));
    const e = await refused();
    expect(e.message).toMatch(/seq 4/);
    expect(e.message).toMatch(/seq 5/);
    expect(e.message).toContain('--address');
    // The way out is per peer and after a check outside the relay; deleting the whole file is never advised.
    expect(e.message).toContain('machine peer forget-record laptop');
    expect(e.message).toMatch(/out of band|outside the relay/);
    expect(e.message).not.toMatch(/[Dd]elete/);
    expect(e.message).not.toContain('peer-records.json');
    expect(readPeerRecords(a)[laptop().uuid]?.seq).toBe(5);
  });

  it('refuses the same seq with other content', async () => {
    await publish(record(5, A1));
    await resolve();
    await admin.putRecord(laptop().uuid, record(5, A2));
    expect((await refused()).message).toMatch(/same as the last record seen/);
  });

  it('refuses a record signed by another key (a thief of the relay token, or a lying relay) and remembers nothing', async () => {
    const stranger = generateSigningKeyPair();
    await publish(record(1, [{ host: '10.66.66.66', port: 1 }], { key: stranger.privateKeyPkcs8 }));
    const e = await refused();
    expect(e.message).toMatch(/registered identity key/);
    expect(e.message).toContain('laptop');
    expect(readPeerRecords(a)[laptop().uuid]).toBeUndefined();
  });

  it('refuses a record that belongs to another machine (the relay serves the record of C under the uuid of B)', async () => {
    // Served as-is by the relay under the uuid of B: its body names another uuid.
    const other = '11111111-2222-4333-8444-555555555555';
    relay.force(`/api/machines/${laptop().uuid}`, 200, { uuid: laptop().uuid, record: record(1, A1, { uuid: other }), lastSeen: now, online: true, etag: '1' }, {}, 'GET');
    expect((await refused()).message).toMatch(new RegExp(`written for machine ${other}`));
  });

  it('refuses a record from the future and one older than 30 days', async () => {
    await publish(record(1, A1, { issuedAt: now + 3600 }));
    expect((await refused()).message).toMatch(/in the future.*clock/s);
    await admin.putRecord(laptop().uuid, record(2, A1, { issuedAt: now - 31 * 86_400 }));
    expect((await refused()).message).toMatch(/more than 30 days ago/);
  });

  it('says there is no record, and what to do, when the relay knows nothing of the peer', async () => {
    const e = await refused();
    expect(e.message).toMatch(/no address record for "laptop"/);
    // Calm: a registered machine is not listed by the relay until its daemon has published; nothing is broken.
    expect(e.message).toMatch(/no record published yet/);
    expect(e.message).not.toMatch(/has not published one/);
    expect(e.message).toContain('--address');
  });

  it('a relay that cannot be reached is named, with the way around it', async () => {
    await relay.close();
    const e = await refused();
    expect(e.message).toMatch(/cannot reach the relay/);
    expect(e.message).toContain('--address');
    relay = await startFakeRelay();
  });

  it('a relay that says the peer is offline is a fact to report, not a refusal', async () => {
    await publish(record(1));
    now += 600;
    const r = await resolve();
    expect(r.online).toBe(false);
    expect(r.addresses).toEqual(A1);
  });

  it('a damaged peer-records.json is a loud error naming the file and the fix, never an empty state', async () => {
    writeFileSync(peerRecordsFile(a), '{oops');
    await publish(record(1));
    const e = await refused();
    expect(e.message).toContain('peer-records.json');
    expect(e.message).toMatch(/Delete it/);
  });

  it('keeps one entry per peer and never lets one peer use the seq of another', async () => {
    await publish(record(9));
    await resolve();
    expect(Object.keys(readPeerRecords(a))).toEqual([laptop().uuid]);
  });
});

describe('lookupPeerPresence (machine list)', () => {
  it('returns, for every peer, its verified addresses and what the relay says about presence, with one request', async () => {
    await publish(record(2, A2));
    const before = relay.requests.length;
    const [row] = await lookupPeerPresence(a, [peerOf()], publisher, now);
    expect(row).toMatchObject({ uuid: laptop().uuid, addresses: A2, online: true, source: 'relay' });
    expect(relay.requests.length - before).toBe(1);
    expect(readPeerRecords(a)[laptop().uuid]?.seq).toBe(2);
  });

  it('a peer without a record is reported as such, not as a failure of the others', async () => {
    const [row] = await lookupPeerPresence(a, [peerOf()], publisher, now);
    expect(row).toMatchObject({ uuid: laptop().uuid, problem: expect.stringMatching(/no record published yet/) });
    expect(row?.problem).not.toMatch(/has not published one|error|failed/i);
    expect(row?.source).toBe('none');
  });

  it('a record that does not verify is a problem line for that peer only; the last known addresses are kept', async () => {
    await publish(record(2, A2));
    await lookupPeerPresence(a, [peerOf()], publisher, now);
    await admin.putRecord(laptop().uuid, record(1, A1));
    const [row] = await lookupPeerPresence(a, [peerOf()], publisher, now);
    expect(row?.problem).toMatch(/seq 1/);
    expect(row?.addresses).toEqual(A2);
    expect(row?.source).toBe('last-known');
  });

  it('an unreachable relay throws one RelayError for the caller to turn into a warning line', async () => {
    await publish(record(1));
    await lookupPeerPresence(a, [peerOf()], publisher, now);
    await relay.close();
    await expect(lookupPeerPresence(a, [peerOf()], publisher, now)).rejects.toThrow(/cannot reach the relay/);
    relay = await startFakeRelay();
  });
});

describe('connectFirst', () => {
  const fakeSession = (label: string) => ({ label }) as unknown as import('@wadeck-app/machine-transport').PeerSession;

  it('tries the addresses in order and the first that completes wins', async () => {
    const tried: string[] = [];
    const r = await connectFirst(A2, async (address) => {
      tried.push(describeAddress(address));
      return fakeSession(describeAddress(address));
    });
    expect(tried).toEqual(['10.0.0.7:47921']);
    expect(r.address).toEqual(A2[0]);
    expect(r.failures).toEqual([]);
  });

  it('goes on after a refusal and reports every failure with its reason', async () => {
    const r = await connectFirst(A2, async (address) => {
      if (address.host === '10.0.0.7') throw new Error('cannot reach 10.0.0.7:47921: connect ECONNREFUSED');
      return fakeSession('second');
    });
    expect(r.address).toEqual(A2[1]);
    expect(r.failures).toEqual(['10.0.0.7:47921: cannot reach 10.0.0.7:47921: connect ECONNREFUSED']);
  });

  it('when none works the error lists every address and every reason, and the way around the relay', async () => {
    await expect(
      connectFirst(A2, async (address) => {
        throw new Error(`no answer from ${describeAddress(address)} within 3000 ms`);
      }),
    ).rejects.toThrow(/10\.0\.0\.7:47921: no answer from 10\.0\.0\.7:47921 within 3000 ms.*192\.168\.1\.20:47921: no answer/s);
  });

  it('writes an IPv6 address in brackets', () => {
    expect(describeAddress({ host: '2001:db8::1', port: 7 })).toBe('[2001:db8::1]:7');
    expect(describeAddress({ host: 'a.example', port: 7 })).toBe('a.example:7');
  });
});

describe('state file shape', () => {
  it('is written as { v: 1, peers } and read back strictly', async () => {
    await publish(record(1));
    await resolve();
    const raw = JSON.parse(readFileSync(peerRecordsFile(a), 'utf8')) as { v: number; peers: Record<string, unknown> };
    expect(raw.v).toBe(1);
    expect(Object.keys(raw.peers)).toEqual([laptop().uuid]);
    writeFileSync(peerRecordsFile(a), JSON.stringify({ v: 1, peers: { [laptop().uuid]: { seq: 'x' } } }));
    expect(() => readPeerRecords(a)).toThrow(/peer-records\.json is corrupt or invalid/);
  });
});

describe('destination rules for the addresses of a record (a peer, or a relay lying, must not aim this machine at itself or at the metadata service)', () => {
  const MIXED: AddressEntry[] = [
    { host: '127.0.0.1', port: 47921 },
    { host: '169.254.169.254', port: 80 },
    { host: '::ffff:127.0.0.1', port: 47921 },
    { host: '0.0.0.0', port: 47921 },
    { host: 'fe80::1', port: 47921 },
    { host: '192.168.1.20', port: 47921 },
  ];

  it('keeps the usable addresses and names every refused one with its reason', async () => {
    await publish(record(1, MIXED));
    const r = await resolve();
    expect(r.addresses).toEqual([{ host: '192.168.1.20', port: 47921 }]);
    expect(r.refused).toHaveLength(5);
    expect(r.refused.join('\n')).toMatch(/127\.0\.0\.1:47921.*loopback/);
    expect(r.refused.join('\n')).toMatch(/169\.254\.169\.254:80.*link-local/);
    expect(r.refused.join('\n')).toMatch(/::ffff:127\.0\.0\.1.*loopback/);
    expect(r.refused.join('\n')).toMatch(/0\.0\.0\.0.*unspecified/);
    expect(r.refused.join('\n')).toMatch(/fe80::1.*link-local/);
  });

  it('says so, with every reason and the way around, when ALL addresses are refused', async () => {
    await publish(record(1, MIXED.slice(0, 2)));
    const e = await refused();
    expect(e.message).toMatch(/all 2 addresses/);
    expect(e.message).toMatch(/loopback/);
    expect(e.message).toMatch(/link-local/);
    expect(e.message).toContain('--address');
  });

  it('the record itself is still accepted and remembered (only the use of the address is refused)', async () => {
    await publish(record(4, MIXED.slice(0, 1)));
    await refused();
    expect(readPeerRecords(a)[laptop().uuid]?.seq).toBe(4);
  });

  it('tests can allow local addresses (never reachable from the command line)', async () => {
    await publish(record(1, MIXED.slice(0, 1)));
    const r = await resolvePeerAddresses(a, peerOf(), publisher, now, { allowLocal: true });
    expect(r.addresses).toEqual([{ host: '127.0.0.1', port: 47921 }]);
    expect(r.refused).toEqual([]);
  });

  it('machine list shows only the usable addresses and a problem line for the others', async () => {
    await publish(record(1, MIXED));
    const [row] = await lookupPeerPresence(a, [peerOf()], publisher, now);
    expect(row?.addresses).toEqual([{ host: '192.168.1.20', port: 47921 }]);
    expect(row?.problem).toMatch(/5 address\(es\) refused/);
  });
});

describe('commitRecords and forgetPeerRecord', () => {
  const entry = (seq: number) => ({ seq, signature: `sig${seq}`, addresses: A1, issuedAt: now, seenAt: now });
  const X = '11111111-2222-4333-8444-555555555555';
  const Y = '66666666-7777-4888-8999-000000000000';

  it('merges into what is on disk: the peer of another writer is kept, a lower seq never replaces a higher one', () => {
    commitRecords(a, { [X]: entry(5) });
    commitRecords(a, { [Y]: entry(2), [X]: entry(3) });
    const all = readPeerRecords(a);
    expect(all[X]?.seq).toBe(5);
    expect(all[Y]?.seq).toBe(2);
  });

  it('writes once for the whole batch and leaves no lock file', async () => {
    commitRecords(a, { [X]: entry(1), [Y]: entry(1) });
    const { readdirSync } = await import('node:fs');
    expect(readdirSync(a).filter((f) => f.includes('.lock') || f.endsWith('.tmp'))).toEqual([]);
    expect(Object.keys(readPeerRecords(a)).sort()).toEqual([X, Y].sort());
  });

  it('forgetPeerRecord removes one peer only and says whether there was one', () => {
    commitRecords(a, { [X]: entry(5), [Y]: entry(2) });
    expect(forgetPeerRecord(a, X)).toBe(true);
    expect(forgetPeerRecord(a, X)).toBe(false);
    expect(Object.keys(readPeerRecords(a))).toEqual([Y]);
  });

  it('after a forget, the next record of that peer is accepted whatever its seq', async () => {
    await publish(record(5));
    await resolve();
    await admin.putRecord(laptop().uuid, record(2, A2));
    await refused();
    forgetPeerRecord(a, laptop().uuid);
    expect((await resolve()).seq).toBe(2);
  });
});
