import { describe, expect, it } from 'vitest';
import { buildAddressRecord, generateSigningKeyPair, type AddressEntry } from '@wadeck-app/machine-core';
import type { PeerSession } from '@wadeck-app/machine-transport';
import { NotInitializedError } from './errors.js';
import { AllAddressesFailedError, PeerAddressError } from './peerAddresses.js';
import type { Connected, PeerTarget } from './peerConnect.js';
import { explainConnectFailure, pingPeer, pingRelay, type PeerPingDeps, type RelayPingDeps } from './ping.js';
import { WakeError } from './wakeConnect.js';
import { RelayError, type RelayClient, type RelayWhoami } from './relayClient.js';
import type { CatchUpReport } from './revocationSync.js';

// The two forms of `machine ping`, with every collaborator injected: each branch of each check is reached by a fake, none by the network.

const NOW = 1_800_000_000;
const SELF_UUID = '11111111-1111-4111-8111-111111111111';
const PEER_UUID = '22222222-2222-4222-8222-222222222222';
const TOKEN = 'SECRET-TOKEN-VALUE';
const keys = generateSigningKeyPair();

function recordOf(addresses: AddressEntry[], issuedAt = NOW - 3600, seq = 12) {
  return buildAddressRecord({ uuid: SELF_UUID, addresses, seq, issuedAt }, keys.privateKeyPkcs8);
}

const relayError = (status: number, message: string, code?: string) => new RelayError({ status, message, ...(code ? { code } : {}) });

interface RelayWorld {
  deps: RelayPingDeps;
  calls: string[];
}

function relayWorld(over: { client?: Partial<RelayClient>; deps?: Partial<RelayPingDeps> } = {}): RelayWorld {
  const calls: string[] = [];
  let tick = 0;
  const client: Partial<RelayClient> = {
    getVersion: async () => (calls.push('version'), { version: '2026.11.14-144', uptimeSeconds: 3 * 86_400 }),
    whoami: async (): Promise<RelayWhoami> => (calls.push('whoami'), { scopes: ['machine'], label: 'desktop' }),
    getMachines: async () => (calls.push('machines'), []),
    getMachine: async () => (calls.push('machine'), { uuid: SELF_UUID, record: recordOf([{ host: '192.168.1.20', port: 47921 }]), lastSeen: NOW - 20, online: true }),
    ...over.client,
  };
  const deps: RelayPingDeps = {
    now: () => NOW,
    clock: () => (tick += 12.5),
    readRelay: () => ({ relayUrl: 'https://relay.example', token: TOKEN, label: 'desktop', claimedAt: '2026-11-14T10:00:00.000Z' }),
    client: () => client as RelayClient,
    self: () => ({ uuid: SELF_UUID, name: 'desktop', publicKey: keys.publicKey }),
    daemonRunning: async () => true,
    ...over.deps,
  };
  return { deps, calls };
}

const text = (r: { checks: Array<{ status: string; message: string }> }) => r.checks.map((c) => `[${c.status}] ${c.message}`).join('\n');

describe('machine ping (relay form)', () => {
  it('everything passes: one line per step, exit-worthy ok, and the token never appears', async () => {
    const w = relayWorld();
    const r = await pingRelay(w.deps);
    expect(r.ok).toBe(true);
    expect(r.checks.map((c) => [c.id, c.status])).toEqual([
      ['relay-config', 'ok'],
      ['relay', 'ok'],
      ['token', 'ok'],
      ['daemon', 'ok'],
      ['address-record', 'ok'],
    ]);
    const all = text(r);
    expect(all).toContain('https://relay.example');
    expect(all).toMatch(/reachable in 12\.5 ms/);
    expect(all).toContain('version 2026.11.14-144');
    expect(all).toContain('up 3 days');
    expect(all).toMatch(/access level machine\b/);
    expect(all).toContain('192.168.1.20:47921');
    expect(all).toContain('seq 12');
    expect(all).not.toContain(TOKEN);
    // Version first (public), then whoami, then the record: the order of the steps.
    expect(w.calls).toEqual(['version', 'whoami', 'machine']);
  });

  it('names the access level of a machine-admin token', async () => {
    const r = await pingRelay(relayWorld({ client: { whoami: async () => ({ scopes: ['machine-admin'] }) } }).deps);
    expect(r.ok).toBe(true);
    expect(text(r)).toContain('machine-admin (can approve machines, cannot manage tokens)');
  });

  it('warns, without failing, when the token is full access (it can manage tokens) and says how to replace it', async () => {
    const r = await pingRelay(relayWorld({ client: { whoami: async () => ({ scopes: null }) } }).deps);
    expect(r.ok).toBe(true);
    const token = r.checks.find((c) => c.id === 'token');
    expect(token?.status).toBe('warn');
    expect(token?.message).toMatch(/FULL ACCESS.*manage tokens/);
    expect(token?.message).toMatch(/machine join --force|machine admin login/);
  });

  it('fails when the token has no machine scope: the relay would refuse every machine call', async () => {
    const r = await pingRelay(relayWorld({ client: { whoami: async () => ({ scopes: ['queue'] }) } }).deps);
    expect(r.ok).toBe(false);
    expect(r.checks.find((c) => c.id === 'token')?.message).toMatch(/\["queue"\].*no "machine" scope.*machine join/s);
  });

  it('no relay.json: says machine join <relay>, skips the relay steps (and says so) but still checks the daemon', async () => {
    const w = relayWorld({ deps: { readRelay: () => undefined } });
    const r = await pingRelay(w.deps);
    expect(r.ok).toBe(false);
    expect(r.checks.find((c) => c.id === 'relay-config')?.message).toMatch(/has not joined a relay.*machine join <relay>/);
    expect(r.checks.find((c) => c.id === 'skipped')?.status).toBe('info');
    expect(r.checks.find((c) => c.id === 'daemon')?.status).toBe('ok');
    expect(w.calls).toEqual([]);
  });

  it('a corrupt relay.json is reported with the message of the reader (it names the file and the fix)', async () => {
    const r = await pingRelay(
      relayWorld({
        deps: {
          readRelay: () => {
            throw new Error('X/relay.json is corrupt or invalid (not valid JSON): delete it and run `machine join <code>` again');
          },
        },
      }).deps,
    );
    expect(r.ok).toBe(false);
    expect(r.checks[0]?.message).toMatch(/relay\.json is corrupt.*machine join/);
  });

  it('relay unreachable: the client message (cause and fix), then token and record are skipped', async () => {
    const w = relayWorld({ client: { getVersion: async () => { throw relayError(0, 'cannot reach the relay https://relay.example (getaddrinfo ENOTFOUND): check your connection and the URL (--relay <url>), then try again'); } } });
    const r = await pingRelay(w.deps);
    expect(r.ok).toBe(false);
    expect(r.checks.find((c) => c.id === 'relay')?.message).toMatch(/cannot reach the relay.*ENOTFOUND/);
    expect(r.checks.map((c) => c.id)).toEqual(['relay-config', 'relay', 'skipped', 'daemon']);
    expect(w.calls).toEqual([]);
  });

  it('a relay without /api/version answers but is not identified: a warning that points at the URL, the other steps go on', async () => {
    const r = await pingRelay(relayWorld({ client: { getVersion: async () => undefined } }).deps);
    expect(r.ok).toBe(true);
    const relay = r.checks.find((c) => c.id === 'relay');
    expect(relay?.status).toBe('warn');
    expect(relay?.message).toMatch(/no \/api\/version.*URL/);
  });

  it('a refused token (401): the client message, the record is skipped', async () => {
    const r = await pingRelay(relayWorld({ client: { whoami: async () => { throw relayError(401, 'the relay https://relay.example refused the stored token (invalid or revoked): run `machine join <code>` again with a new code from the admin'); } } }).deps);
    expect(r.ok).toBe(false);
    expect(r.checks.find((c) => c.id === 'token')?.message).toMatch(/refused the stored token.*machine join/);
    expect(r.checks.find((c) => c.id === 'address-record')).toBeUndefined();
    expect(text(r)).not.toContain(TOKEN);
  });

  it('a relay without /api/whoami: the token is checked with the machine list, the access level is said to be unknown (warning)', async () => {
    const w = relayWorld({ client: { whoami: async () => undefined } });
    const r = await pingRelay(w.deps);
    expect(r.ok).toBe(true);
    const token = r.checks.find((c) => c.id === 'token');
    expect(token?.status).toBe('warn');
    expect(token?.message).toMatch(/accepted.*no \/api\/whoami.*access level cannot be shown/);
    expect(w.calls).toContain('machines');
  });

  it('a relay without /api/whoami and a token the machine list refuses: fail with the client message', async () => {
    const r = await pingRelay(relayWorld({ client: { whoami: async () => undefined, getMachines: async () => { throw relayError(403, 'the relay refused this request (403): the token may lack the "machine" scope'); } } }).deps);
    expect(r.ok).toBe(false);
    expect(r.checks.find((c) => c.id === 'token')?.message).toMatch(/lack the "machine" scope/);
  });

  it('the local daemon is not running: fail, with both ways to start it and the reason it matters', async () => {
    const r = await pingRelay(relayWorld({ deps: { daemonRunning: async () => false } }).deps);
    expect(r.ok).toBe(false);
    const d = r.checks.find((c) => c.id === 'daemon');
    expect(d?.message).toMatch(/not running.*machine startup enable.*machine daemon/s);
    expect(d?.message).toMatch(/publishes this machine's address and receives commands/);
  });

  it('a daemon status that cannot be read is a failure with its message, never a silent pass', async () => {
    const r = await pingRelay(relayWorld({ deps: { daemonRunning: async () => { throw new Error('cannot read port.json'); } } }).deps);
    expect(r.checks.find((c) => c.id === 'daemon')).toMatchObject({ status: 'fail' });
    expect(text(r)).toContain('cannot read port.json');
  });

  it('no identity yet: the record step fails with the message that says machine setup / join', async () => {
    const r = await pingRelay(relayWorld({ deps: { self: () => { throw new NotInitializedError(); } } }).deps);
    expect(r.ok).toBe(false);
    expect(r.checks.find((c) => c.id === 'address-record')?.message).toMatch(/machine setup <relay>/);
  });

  it('no address record on the relay: fail, it is the daemon that publishes it', async () => {
    const r = await pingRelay(relayWorld({ client: { getMachine: async () => undefined } }).deps);
    expect(r.ok).toBe(false);
    expect(r.checks.find((c) => c.id === 'address-record')?.message).toMatch(/no address record.*daemon.*machine startup enable/s);
  });

  it('this machine is not approved on the relay (403 not_registered): the client message', async () => {
    const r = await pingRelay(relayWorld({ client: { getMachine: async () => { throw relayError(403, 'the relay does not know this machine as approved (not_registered): this machine is not approved yet: run machine join and ask the admin to approve it', 'not_registered'); } } }).deps);
    expect(r.checks.find((c) => c.id === 'address-record')?.message).toMatch(/not approved yet/);
  });

  it('a record that does not verify against this machine key is a failure naming the cause', async () => {
    const other = generateSigningKeyPair();
    const forged = buildAddressRecord({ uuid: SELF_UUID, addresses: [{ host: '10.0.0.9', port: 1 }], seq: 3, issuedAt: NOW - 10 }, other.privateKeyPkcs8);
    const r = await pingRelay(relayWorld({ client: { getMachine: async () => ({ uuid: SELF_UUID, record: forged, lastSeen: NOW, online: true }) } }).deps);
    expect(r.ok).toBe(false);
    expect(r.checks.find((c) => c.id === 'address-record')?.message).toMatch(/signature does not match/);
  });

  it('a record older than the 7 days of the republish is a warning: the daemon is not refreshing it', async () => {
    const old = recordOf([{ host: '192.168.1.20', port: 47921 }], NOW - 9 * 86_400);
    const r = await pingRelay(relayWorld({ client: { getMachine: async () => ({ uuid: SELF_UUID, record: old, lastSeen: NOW - 20, online: true }) } }).deps);
    expect(r.ok).toBe(true);
    const rec = r.checks.find((c) => c.id === 'address-record');
    expect(rec?.status).toBe('warn');
    expect(rec?.message).toMatch(/older than 7 days/);
  });

  it('the relay says this machine is offline: a warning (the record itself is fine)', async () => {
    const r = await pingRelay(relayWorld({ client: { getMachine: async () => ({ uuid: SELF_UUID, record: recordOf([{ host: '192.168.1.20', port: 47921 }]), lastSeen: NOW - 900, online: false }) } }).deps);
    expect(r.ok).toBe(true);
    const rec = r.checks.find((c) => c.id === 'address-record');
    expect(rec?.status).toBe('warn');
    expect(rec?.message).toMatch(/offline.*heartbeat/);
  });

  it('every published address is one that peers refuse (loopback): a warning that says so', async () => {
    const loop = recordOf([{ host: '127.0.0.1', port: 47921 }]);
    const r = await pingRelay(relayWorld({ client: { getMachine: async () => ({ uuid: SELF_UUID, record: loop, lastSeen: NOW, online: true }) } }).deps);
    const rec = r.checks.find((c) => c.id === 'address-record');
    expect(rec?.status).toBe('warn');
    expect(rec?.message).toMatch(/peers refuse.*--advertise/is);
  });
});

// ---------------------------------------------------------------------------------------------------------------------

const fakeSession = (): PeerSession & { closed: number } => {
  const s = { peerPublicKey: 'k', peerId: 'k', send: () => undefined, next: async () => ({}), closed: 0, close() { s.closed += 1; } };
  return s as unknown as PeerSession & { closed: number };
};

const target = (over: Partial<PeerTarget> = {}): PeerTarget => ({ source: 'relay', addresses: [{ host: '192.168.1.30', port: 47921 }], refused: [], online: true, lastSeen: NOW - 20, seq: 4, issuedAt: NOW - 7200, ...over });

const report = (over: Partial<CatchUpReport> = {}): CatchUpReport => ({ peerSupportsCatchUp: true, installed: false, sent: false, warnings: [], helloRoundTripMs: 6.3, inSync: true, peerDigest: 'abcd'.repeat(16), peerVersion: 7, ...over });

interface PeerWorld {
  deps: PeerPingDeps;
  said: string[];
  warned: string[];
  sessions: Array<PeerSession & { closed: number }>;
  sleeps: number[];
  connects: number;
  catchUps: number;
}

function peerWorld(over: Partial<PeerPingDeps> = {}): PeerWorld {
  const w: PeerWorld = { deps: undefined as never, said: [], warned: [], sessions: [], sleeps: [], connects: 0, catchUps: 0 };
  let tick = 0;
  w.deps = {
    name: 'laptop',
    uuid: PEER_UUID,
    registration: { serial: 2, adminKeyId: 'ab5e0000000000000000000000000000', validTo: NOW + 86_400 * 30 },
    count: 1,
    now: () => NOW,
    // Every reading advances 10 ms: a handshake (two readings) is always 10 ms.
    clock: () => (tick += 10),
    sleep: async (ms) => void w.sleeps.push(ms),
    resolveTarget: async () => target(),
    connect: async (t, onAttempt) => {
      w.connects += 1;
      onAttempt(t.addresses[0] as AddressEntry);
      const session = fakeSession();
      w.sessions.push(session);
      return { session, address: t.addresses[0] as AddressEntry, failures: [] } satisfies Connected;
    },
    catchUp: async () => (w.catchUps += 1, report()),
    say: (line) => w.said.push(line),
    warn: (line) => w.warned.push(line),
    ...over,
  };
  return w;
}

describe('machine ping <machine>', () => {
  it('one round: resolves, connects, shows handshake and hello times, the registration and the revocation state, executes nothing', async () => {
    const w = peerWorld();
    const r = await pingPeer(w.deps);
    expect(r.ok).toBe(true);
    expect(r.executed).toBe(false);
    expect(r.rounds).toHaveLength(1);
    expect(r.rounds[0]).toMatchObject({ n: 1, ok: true, address: '192.168.1.30:47921', handshakeMs: 10, helloMs: 6.3 });
    const out = w.said.join('\n');
    expect(out).toContain('"laptop"');
    expect(out).toContain('admin key ab5e');
    expect(out).toContain('serial 2');
    expect(out).toMatch(/seq 4/);
    expect(out).toContain('192.168.1.30:47921');
    expect(out).toMatch(/handshake 10(\.0)? ms/);
    expect(out).toMatch(/hello 6\.3 ms/);
    expect(out).toMatch(/revocation lists.*same/);
    expect(out).toMatch(/nothing was executed/);
    expect(w.sessions[0]?.closed).toBe(1);
  });

  it('pinned addresses: says they come from connections.json and that the relay record was not used', async () => {
    const w = peerWorld({ resolveTarget: async () => ({ source: 'pinned', addresses: [{ host: '192.168.1.40', port: 47921 }], refused: [] }) });
    const r = await pingPeer(w.deps);
    expect(r.ok).toBe(true);
    expect(r.target?.source).toBe('pinned');
    expect(w.said.join('\n')).toMatch(/\[ok\] address: pinned 192\.168\.1\.40:47921 \(connections\.json, `machine peer connect laptop --show`; the relay was not asked\)/);
  });

  it('a failed wake is told in its own words, not explained as a connection failure', async () => {
    const w = peerWorld({
      connect: async () => {
        throw new WakeError('no answer from "laptop" after 90 s and 8 packets (4 unicast, 4 broadcast). Wake-on-LAN gives no acknowledgement');
      },
    });
    const r = await pingPeer(w.deps);
    expect(r.ok).toBe(false);
    expect(r.rounds[0]?.error).toBe('no answer from "laptop" after 90 s and 8 packets (4 unicast, 4 broadcast). Wake-on-LAN gives no acknowledgement');
    expect(w.said.join('\n')).toMatch(/\[fail\] ping 1\/1: no answer from "laptop" after 90 s/);
  });

  it('--address: says the relay was not asked', async () => {
    const w = peerWorld({ resolveTarget: async () => ({ source: 'override', addresses: [{ host: '127.0.0.1', port: 5555 }], refused: [] }) });
    const r = await pingPeer(w.deps);
    expect(r.ok).toBe(true);
    expect(w.said.join('\n')).toMatch(/--address 127\.0\.0\.1:5555.*relay was not asked/);
  });

  it('addresses the relay refused (loopback in a record) are reported as warnings, the rest is tried', async () => {
    const w = peerWorld({ resolveTarget: async () => target({ refused: ['127.0.0.1:47921 refused: loopback'] }) });
    await pingPeer(w.deps);
    expect(w.warned.join('\n')).toContain('127.0.0.1:47921 refused: loopback');
  });

  it('the relay says the peer is offline: a warning, the addresses are tried anyway', async () => {
    const w = peerWorld({ resolveTarget: async () => target({ online: false, lastSeen: NOW - 7200 }) });
    const r = await pingPeer(w.deps);
    expect(r.ok).toBe(true);
    expect(w.warned.join('\n')).toMatch(/relay says "laptop" is offline.*trying/);
  });

  it('no record on the relay: the failure is the message of the resolver (the machine startup enable hint), nothing was connected', async () => {
    const w = peerWorld({ resolveTarget: async () => { throw new PeerAddressError('the relay has no address record for "laptop" (u): no record published yet. On "laptop" run `machine startup enable`'); } });
    const r = await pingPeer(w.deps);
    expect(r.ok).toBe(false);
    expect(w.said.join('\n')).toMatch(/\[fail\] address: the relay has no address record.*machine startup enable/);
    expect(w.connects).toBe(0);
  });

  it('the relay is not configured and no --address: the resolver message is the failure', async () => {
    const w = peerWorld({ resolveTarget: async () => { throw new PeerAddressError('no address known for "laptop": pass --address <host:port>, or join a relay'); } });
    const r = await pingPeer(w.deps);
    expect(r.ok).toBe(false);
    expect(w.said.join('\n')).toMatch(/pass --address/);
  });

  it('a relay error while fetching the record (not a PeerAddressError) is also reported, never thrown', async () => {
    const w = peerWorld({ resolveTarget: async () => { throw relayError(0, 'cannot reach the relay https://relay.example (x): check your connection'); } });
    const r = await pingPeer(w.deps);
    expect(r.ok).toBe(false);
    expect(w.said.join('\n')).toMatch(/\[fail\] address: cannot reach the relay/);
  });

  it('no address answers: one line per address with its own cause and fix', async () => {
    const attempts = [
      { address: { host: '10.0.0.7', port: 47921 }, reason: 'cannot reach 10.0.0.7:47921: connect ECONNREFUSED 10.0.0.7:47921', kind: 'unreachable' as const },
      { address: { host: '192.168.1.20', port: 47921 }, reason: 'no answer from 192.168.1.20:47921 within 3000 ms: check that the peer machine is running and reachable', kind: 'timeout' as const },
    ];
    const w = peerWorld({
      resolveTarget: async () => target({ addresses: attempts.map((a) => a.address) }),
      connect: async () => { throw new AllAddressesFailedError('could not connect to any of the 2 address(es)', attempts); },
    });
    const r = await pingPeer(w.deps);
    expect(r.ok).toBe(false);
    const out = w.said.join('\n');
    expect(out).toMatch(/\[fail\] ping 1\/1: no address of "laptop" answered/);
    expect(out).toMatch(/10\.0\.0\.7:47921: .*ECONNREFUSED.*nothing listens/is);
    expect(out).toMatch(/192\.168\.1\.20:47921: no answer.*firewall/s);
    expect(r.rounds[0]?.attempts).toEqual(attempts.map((a) => ({ address: `${a.address.host}:${a.address.port}`, reason: expect.any(String) })));
  });

  it('a handshake the peer refused (it closed the connection during authentication): not registered, revoked, clock, pair secret', async () => {
    const w = peerWorld({ connect: async () => { throw new Error('192.168.1.30:47921 closed the connection during authentication (connection closed): this machine is probably not registered there, was revoked there, or the pair secret differs; check the peer log'); } });
    const r = await pingPeer(w.deps);
    expect(r.ok).toBe(false);
    const out = w.said.join('\n');
    expect(out).toMatch(/not registered there.*revoked.*clock/s);
    expect(out).toMatch(/machine cli logs/);
  });

  it('another machine answers at that address (the key presented is not the pinned one)', async () => {
    const w = peerWorld({ connect: async () => { throw new Error('192.168.1.30:47921 presented key AAA but the pinned registration says BBB: refusing to talk to an unregistered machine'); } });
    await pingPeer(w.deps);
    expect(w.said.join('\n')).toMatch(/another machine.*answers at this address.*--address/is);
  });

  it('a wrong pair secret says who sends it again', async () => {
    const w = peerWorld({ connect: async () => { throw new Error('192.168.1.30:47921 failed the pair secret proof: the pair secret differs, re-run the pairing from the admin console'); } });
    await pingPeer(w.deps);
    expect(w.said.join('\n')).toMatch(/machine admin distribute laptop/);
  });

  it('a timeout of the handshake is explained (firewall, wrong address, peer off)', async () => {
    const w = peerWorld({ connect: async () => { throw new Error('no answer from 192.168.1.30:47921 within 10000 ms: check that the peer machine is running and reachable'); } });
    await pingPeer(w.deps);
    expect(w.said.join('\n')).toMatch(/firewall/);
  });

  it('the hello is not answered (timeout): the round fails, the session is closed', async () => {
    const w = peerWorld({ catchUp: async () => { throw new Error('no answer to the revocation hello within 10000 ms: the peer may be busy or run an incompatible version'); } });
    const r = await pingPeer(w.deps);
    expect(r.ok).toBe(false);
    expect(w.said.join('\n')).toMatch(/no answer to the revocation hello/);
    expect(w.sessions[0]?.closed).toBe(1);
  });

  it('the peer turns out revoked: the round fails with the message, nothing else is claimed', async () => {
    const w = peerWorld({ catchUp: async () => { throw new Error('laptop (u) is revoked: the admin\'s revocation lists cover it, so nothing was sent to it. Ask the admin which machine replaces it'); } });
    const r = await pingPeer(w.deps);
    expect(r.ok).toBe(false);
    expect(w.said.join('\n')).toMatch(/is revoked/);
  });

  it('an older peer build (no catch-up): the handshake is still a success, the hello answer is its refusal and the warning says to update it', async () => {
    const w = peerWorld({ catchUp: async () => report({ peerSupportsCatchUp: false, inSync: undefined, peerDigest: undefined, warnings: ['laptop does not support revocation catch-up (older machine build): update it'] }) });
    const r = await pingPeer(w.deps);
    expect(r.ok).toBe(true);
    expect(w.warned.join('\n')).toMatch(/older machine build/);
    expect(w.said.join('\n')).toMatch(/revocation lists.*not supported/);
  });

  it('the lists differed: says what was installed here and what was sent there', async () => {
    const w = peerWorld({ catchUp: async () => report({ inSync: false, installed: true, sent: true }) });
    await pingPeer(w.deps);
    const out = w.said.join('\n');
    expect(out).toMatch(/differed/);
    expect(out).toMatch(/installed here/);
    expect(out).toMatch(/sent to "laptop"/);
  });

  it('--count 3: three connections one second apart (no wait after the last), statistics like ping', async () => {
    const w = peerWorld({ count: 3 });
    const r = await pingPeer(w.deps);
    expect(r.ok).toBe(true);
    expect(w.connects).toBe(3);
    expect(w.sleeps).toEqual([1000, 1000]);
    expect(r.summary).toMatchObject({ sent: 3, ok: 3, failed: 0, handshake: { count: 3, min: 10, avg: 10, max: 10 }, hello: { count: 3, min: 6.3, avg: 6.3, max: 6.3 } });
    const out = w.said.join('\n');
    expect(out).toMatch(/3 attempts, 3 answered, 0 failed/);
    expect(out).toMatch(/handshake\s+min\/avg\/max = 10\/10\/10 ms/);
    expect(out).toMatch(/hello\s+min\/avg\/max = 6\.3\/6\.3\/6\.3 ms/);
    expect(w.sessions.every((s) => s.closed === 1)).toBe(true);
  });

  it('--count 10: the hello is sent in the first 4 rounds only (the peer rate-limits revocation exchanges), the other rounds measure the handshake', async () => {
    const w = peerWorld({ count: 10 });
    const r = await pingPeer(w.deps);
    expect(r.ok).toBe(true);
    expect(w.catchUps).toBe(4);
    expect(r.rounds.filter((x) => x.helloMs !== undefined)).toHaveLength(4);
    expect(r.summary.handshake?.count).toBe(10);
    expect(r.summary.hello?.count).toBe(4);
    expect(w.said.join('\n')).toMatch(/hello is sent in the first 4 rounds/);
  });

  it('--count 3 with one failing round: the others still run, the report is not ok, the statistics cover the answered rounds', async () => {
    let n = 0;
    const w = peerWorld({
      count: 3,
      connect: async (t, onAttempt) => {
        n += 1;
        if (n === 2) throw new Error('cannot reach 192.168.1.30:47921: connect ECONNREFUSED');
        onAttempt(t.addresses[0] as AddressEntry);
        return { session: fakeSession(), address: t.addresses[0] as AddressEntry, failures: [] };
      },
    });
    const r = await pingPeer(w.deps);
    expect(r.ok).toBe(false);
    expect(r.summary).toMatchObject({ sent: 3, ok: 2, failed: 1 });
    expect(w.said.join('\n')).toMatch(/3 attempts, 2 answered, 1 failed/);
  });

  it('every round failing prints no statistics (there is no time to average)', async () => {
    const w = peerWorld({ count: 2, connect: async () => { throw new Error('cannot reach x: connect ECONNREFUSED'); } });
    const r = await pingPeer(w.deps);
    expect(r.summary.handshake).toBeUndefined();
    expect(w.said.join('\n')).not.toMatch(/min\/avg\/max/);
  });

  it('an earlier address that failed before the one that answered is reported with its cause, and its time is not in the handshake time', async () => {
    let tick = 0;
    const w = peerWorld({
      clock: () => (tick += 1000),
      connect: async (t, onAttempt) => {
        onAttempt({ host: '10.0.0.7', port: 1 });
        onAttempt(t.addresses[0] as AddressEntry);
        return { session: fakeSession(), address: t.addresses[0] as AddressEntry, failures: ['10.0.0.7:1: no answer from 10.0.0.7:1 within 3000 ms'] };
      },
    });
    const r = await pingPeer(w.deps);
    expect(r.ok).toBe(true);
    // The two clock readings around the LAST attempt only.
    expect(r.rounds[0]?.handshakeMs).toBe(1000);
    expect(w.warned.join('\n')).toMatch(/10\.0\.0\.7:1: no answer.*connected through 192\.168\.1\.30:47921/);
  });
});

describe('explainConnectFailure', () => {
  const addr = { host: '10.0.0.7', port: 47921 };
  it('keeps the original reason first and adds one fix', () => {
    const e = explainConnectFailure('cannot reach 10.0.0.7:47921: connect ECONNREFUSED 10.0.0.7:47921', addr, 'laptop');
    expect(e.startsWith('cannot reach 10.0.0.7:47921: connect ECONNREFUSED')).toBe(true);
    expect(e).toMatch(/nothing listens on that port/i);
  });
  it.each([
    ['getaddrinfo ENOTFOUND relay.invalid', /does not resolve/],
    ['connect EHOSTUNREACH 10.0.0.7:47921', /no route/],
    ['connect ENETUNREACH', /no route/],
    ['read ECONNRESET', /reset/],
    ['connect ETIMEDOUT 10.0.0.7:47921', /timed out/],
    ['frame is not valid JSON (x): the peer runs an incompatible version', /incompatible/],
  ])('%s', (reason, expected) => {
    expect(explainConnectFailure(reason, addr, 'laptop')).toMatch(expected);
  });
  it('an unknown reason is returned unchanged plus the pointer to the peer log', () => {
    const e = explainConnectFailure('something new', addr, 'laptop');
    expect(e.startsWith('something new')).toBe(true);
    expect(e).toMatch(/machine cli logs/);
  });
});
