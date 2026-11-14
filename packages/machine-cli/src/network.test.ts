import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateSigningKeyPair, keyId, mergeRevocations, revocationDigest, signPolicy, signRegistration, signRevocation, type PolicyBody, type RegistrationBody } from '@wadeck-app/machine-core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { exportMachineInfo, installPolicy, installRevocation, loadNetwork, readRevocationSeen, recordRevocationSeen, registerMachine, importPeer, revocationState, signAndInstallRevocation } from './network.js';
import { adminInit, signPolicyFile, unlockAdminKey } from './admin.js';
import { initMachine } from './identity.js';

const NOW = 1_800_000_000;
let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'machine-network-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function twoMachines() {
  const adminDir = mkdtempSync(join(tmpdir(), 'machine-network-admin-'));
  const peerDir = mkdtempSync(join(tmpdir(), 'machine-network-peer-'));
  return { adminDir, peerDir };
}

describe('manual enrollment (file based, before the relay exists)', () => {
  it('registers a machine from its info and imports it on another machine, which then trusts it', async () => {
    const { adminDir, peerDir } = twoMachines();
    try {
      // The admin machine (a) and a second machine (b).
      const a = initMachine(adminDir, 'desktop');
      const admin = adminInit(adminDir);
      const b = initMachine(peerDir, 'laptop');

      const info = exportMachineInfo(peerDir);
      expect(info).toMatchObject({ uuid: b.uuid, name: 'laptop', identityPublicKey: b.identity.publicKey });
      expect(JSON.stringify(info)).not.toContain(Buffer.from(b.identity.privateKeyPkcs8).toString('base64url'));

      // The admin registers b. The bundle carries the signed registration and the pair secret between a and b.
      const bundle = await registerMachine(adminDir, info, { now: NOW, prompt: async () => admin.passphrase, validForDays: 365 });
      expect(bundle.registration.body.uuid).toBe(b.uuid);
      expect(bundle.pairSecret).toMatch(/^[A-Za-z0-9_-]{43}$/);

      // a loads b from the bundle: a pinned the admin key itself, so it can verify.
      importPeer(adminDir, bundle, { now: NOW });
      const net = loadNetwork(adminDir, NOW);
      expect(net.directory.lookup(b.identity.publicKey)).toMatchObject({ peerId: b.uuid, name: 'laptop' });
      expect(net.directory.problems).toEqual([]);
      expect(a.uuid).not.toBe(b.uuid);
    } finally {
      rmSync(adminDir, { recursive: true, force: true });
      rmSync(peerDir, { recursive: true, force: true });
    }
  });

  it('refuses to import a bundle signed by another admin than the pinned one, and stores nothing', () => {
    const stranger = generateSigningKeyPair();
    initMachine(dir, 'desktop');
    adminInit(dir);
    const peer = generateSigningKeyPair();
    const body: RegistrationBody = {
      v: 1,
      uuid: '9c5d1e2f-3a4b-4c6d-8e7f-abcdef012345',
      name: 'laptop',
      identityPublicKey: peer.publicKey,
      serial: 1,
      validFrom: NOW - 10,
      validTo: NOW + 1000,
      adminKeyId: keyId(stranger.publicKey),
    };
    const bundle = { registration: signRegistration(body, stranger.privateKeyPkcs8), pairSecret: Buffer.alloc(32, 1).toString('base64url') };
    expect(() => importPeer(dir, bundle, { now: NOW })).toThrow(/admin/);
    expect(existsSync(join(dir, '_secrets_', 'peers.json'))).toBe(false);
  });

  it('refuses a bundle whose pair secret is not 32 bytes', () => {
    initMachine(dir, 'desktop');
    const admin = adminInit(dir);
    expect(admin.adminKeyId).toBeTruthy();
    const bundle = { registration: {} as never, pairSecret: 'short' };
    expect(() => importPeer(dir, bundle, { now: NOW })).toThrow(/pair secret/);
  });

  it('keeps the pair secrets only under _secrets_', async () => {
    const { adminDir, peerDir } = twoMachines();
    try {
      initMachine(adminDir, 'desktop');
      const admin = adminInit(adminDir);
      initMachine(peerDir, 'laptop');
      const bundle = await registerMachine(adminDir, exportMachineInfo(peerDir), { now: NOW, prompt: async () => admin.passphrase, validForDays: 30 });
      importPeer(adminDir, bundle, { now: NOW });
      expect(readFileSync(join(adminDir, '_secrets_', 'peers.json'), 'utf8')).toContain(bundle.pairSecret);
      for (const f of ['state.json', 'admin.json']) {
        if (existsSync(join(adminDir, f))) expect(readFileSync(join(adminDir, f), 'utf8')).not.toContain(bundle.pairSecret);
      }
    } finally {
      rmSync(adminDir, { recursive: true, force: true });
      rmSync(peerDir, { recursive: true, force: true });
    }
  });
});

describe('installPolicy', () => {
  it('installs a policy signed by the pinned admin for this machine, and loadNetwork returns it', async () => {
    const self = initMachine(dir, 'desktop');
    const admin = adminInit(dir);
    const draft = join(dir, 'draft.json');
    writeFileSync(draft, JSON.stringify({ v: 1, target: self.uuid, version: 1, baseVersion: 0, defaults: [{ shell: 'cmd', command: 'ipconfig' }], peers: {} }));
    const { signed } = await signPolicyFile(dir, draft, { now: NOW, prompt: async () => admin.passphrase });
    installPolicy(dir, signed, { now: NOW });
    expect(loadNetwork(dir, NOW).policy?.defaults).toEqual([{ shell: 'cmd', command: 'ipconfig' }]);
  });

  it('refuses a policy for another machine and keeps the previous one', async () => {
    const self = initMachine(dir, 'desktop');
    const admin = adminInit(dir);
    const ok = join(dir, 'ok.json');
    writeFileSync(ok, JSON.stringify({ v: 1, target: self.uuid, version: 1, baseVersion: 0, defaults: [{ shell: 'cmd', command: 'ipconfig' }], peers: {} }));
    installPolicy(dir, (await signPolicyFile(dir, ok, { now: NOW, prompt: async () => admin.passphrase })).signed, { now: NOW });
    const other = join(dir, 'other.json');
    writeFileSync(other, JSON.stringify({ v: 1, target: '9c5d1e2f-3a4b-4c6d-8e7f-abcdef012345', version: 2, baseVersion: 1, defaults: [], peers: {} }));
    const wrong = (await signPolicyFile(dir, other, { now: NOW, prompt: async () => admin.passphrase })).signed;
    expect(() => installPolicy(dir, wrong, { now: NOW })).toThrow(/another machine|target/);
    expect(loadNetwork(dir, NOW).policy?.version).toBe(1);
  });

  it('refuses a policy signed by someone else', () => {
    const self = initMachine(dir, 'desktop');
    adminInit(dir);
    const stranger = generateSigningKeyPair();
    const body: PolicyBody = {
      v: 1,
      target: self.uuid,
      version: 1,
      baseVersion: 0,
      adminKeyId: keyId(stranger.publicKey),
      issuedAt: NOW,
      notBefore: NOW - 10,
      notAfter: NOW + 1000,
      defaults: [{ shell: 'cmd', command: 'format c:' }],
      peers: {},
    };
    expect(() => installPolicy(dir, signPolicy(body, stranger.privateKeyPkcs8), { now: NOW })).toThrow(/admin/);
    expect(loadNetwork(dir, NOW).policy).toBeUndefined();
  });
});

describe('installRevocation', () => {
  it('installs an admin-signed revocation and the directory then leaves the machine out', async () => {
    const { adminDir, peerDir } = twoMachines();
    try {
      initMachine(adminDir, 'desktop');
      const admin = adminInit(adminDir);
      const b = initMachine(peerDir, 'laptop');
      const bundle = await registerMachine(adminDir, exportMachineInfo(peerDir), { now: NOW, prompt: async () => admin.passphrase, validForDays: 30 });
      importPeer(adminDir, bundle, { now: NOW });
      expect(loadNetwork(adminDir, NOW).directory.lookup(b.identity.publicKey)).toBeDefined();

      // The admin key signs a revocation list: here with the key material of a fresh unlock.
      const pair = await unlockAdminKey(adminDir, async () => admin.passphrase);
      const revocation = signRevocation({ v: 1, adminKeyId: keyId(pair.publicKey), issuedAt: NOW, entries: [{ uuid: b.uuid, serial: bundle.registration.body.serial }] }, pair.privateKeyPkcs8);
      installRevocation(adminDir, revocation);
      const net = loadNetwork(adminDir, NOW);
      expect(net.directory.lookup(b.identity.publicKey)).toBeUndefined();
      expect(net.directory.problems.join('\n')).toMatch(/laptop.*revoked/);
    } finally {
      rmSync(adminDir, { recursive: true, force: true });
      rmSync(peerDir, { recursive: true, force: true });
    }
  });
});

describe('loadNetwork', () => {
  it('on a machine with no admin key says so, with an empty directory and no policy', () => {
    initMachine(dir, 'desktop');
    const net = loadNetwork(dir, NOW);
    expect(net.enrolled).toBe(false);
    expect(net.directory.machines()).toEqual([]);
    expect(net.policy).toBeUndefined();
  });

  it('names the file when peers.json is corrupt instead of trusting nobody silently', () => {
    initMachine(dir, 'desktop');
    adminInit(dir);
    writeFileSync(join(dir, '_secrets_', 'peers.json'), '{broken');
    expect(() => loadNetwork(dir, NOW)).toThrow(/peers\.json.*(corrupt|invalid)/);
  });
});

describe('revocation catch-up state', () => {
  const X = '6f1c2d3e-4a5b-4c6d-8e7f-0a1b2c3d4e5f';
  const Y = '9c5d1e2f-3a4b-4c6d-8e7f-abcdef012345';
  const Z = '0a1b2c3d-4e5f-4a6b-9c7d-8e9f0a1b2c3d';
  type Entries = Array<{ uuid: string; serial: number }>;
  const sorted = (e: Entries): Entries => [...e].sort((p, q) => (p.uuid < q.uuid ? -1 : 1));
  async function admin() {
    initMachine(dir, 'desktop');
    const a = adminInit(dir);
    const pair = await unlockAdminKey(dir, async () => a.passphrase);
    return { pair, sign: (list: Entries, at: number) => signRevocation({ v: 1, adminKeyId: keyId(pair.publicKey), issuedAt: at, entries: sorted(list) }, pair.privateKeyPkcs8) };
  }

  it('is empty at version 0 before any list was installed', () => {
    initMachine(dir, 'desktop');
    adminInit(dir);
    const state = revocationState(dir);
    expect(state).toMatchObject({ version: 0, lists: [], digest: revocationDigest([]) });
  });

  it('keeps every installed signed list, the highest issuedAt as the version and the digest of the merged entries', async () => {
    const { sign } = await admin();
    const first = sign([{ uuid: X, serial: 3 }], NOW);
    installRevocation(dir, first);
    expect(revocationState(dir)).toMatchObject({ version: NOW, lists: [first], digest: revocationDigest([{ uuid: X, serial: 3 }]) });
  });

  it('keeps two lists that each cover something the other lacks (two admin machines), and prunes a list fully covered by the others', async () => {
    const { sign } = await admin();
    const l1 = sign([{ uuid: X, serial: 3 }], NOW);
    const l2 = sign([{ uuid: Y, serial: 1 }], NOW + 5);
    installRevocation(dir, l1);
    installRevocation(dir, l2);
    expect(revocationState(dir).lists).toHaveLength(2);
    const both = sign([{ uuid: X, serial: 3 }, { uuid: Y, serial: 1 }], NOW + 10);
    installRevocation(dir, both);
    expect(revocationState(dir).lists).toEqual([both]);
  });

  it('prunes by uuid AND serial: a list that revokes a machine at a higher serial is not covered by one that revokes it lower', async () => {
    const { sign } = await admin();
    const low = sign([{ uuid: X, serial: 2 }], NOW);
    const high = sign([{ uuid: X, serial: 5 }], NOW + 1);
    installRevocation(dir, high);
    installRevocation(dir, low);
    // low is covered by high (same uuid, higher serial): pruned. high is never covered by low.
    expect(revocationState(dir).lists).toEqual([high]);
    const lower = sign([{ uuid: X, serial: 1 }, { uuid: Y, serial: 1 }], NOW + 2);
    installRevocation(dir, lower);
    expect(revocationState(dir).lists).toHaveLength(2);
  });

  it('always merges a verified list whatever its issuedAt: an older list adds its entries', async () => {
    const { sign } = await admin();
    const newer = sign([{ uuid: X, serial: 3 }], NOW + 100);
    const older = sign([{ uuid: Y, serial: 1 }], NOW);
    installRevocation(dir, newer);
    const r = installRevocation(dir, older);
    expect(r.changed).toBe(true);
    expect(revocationState(dir).digest).toBe(revocationDigest(sorted([{ uuid: X, serial: 3 }, { uuid: Y, serial: 1 }])));
    expect(revocationState(dir).version).toBe(NOW + 100);
  });

  it('deduplicates by signature: installing the same list twice changes nothing', async () => {
    const { sign } = await admin();
    const l = sign([{ uuid: X, serial: 3 }], NOW);
    installRevocation(dir, l);
    const again = installRevocation(dir, l);
    expect(again.changed).toBe(false);
    expect(revocationState(dir).lists).toEqual([l]);
  });

  it('refuses a list dated more than one day in the future when the caller gives its clock, and merges nothing', async () => {
    const { sign } = await admin();
    const future = sign([{ uuid: X, serial: 3 }], NOW + 2 * 86_400);
    expect(() => installRevocation(dir, future, { now: NOW })).toThrow(/revocation refused \(future\).*in the future/);
    expect(revocationState(dir).lists).toEqual([]);
    expect(() => installRevocation(dir, sign([{ uuid: X, serial: 3 }], NOW + 3600), { now: NOW })).not.toThrow();
  });

  it('stores only the canonical { body, signature }: unknown top-level fields are dropped', async () => {
    const { sign } = await admin();
    const l = sign([{ uuid: X, serial: 3 }], NOW);
    installRevocation(dir, { ...l, junk: 'x'.repeat(5000) } as never);
    const stored = JSON.parse(readFileSync(join(dir, 'revocation-lists.json'), 'utf8')) as { lists: Array<Record<string, unknown>> };
    expect(Object.keys(stored.lists[0] as object)).toEqual(['body', 'signature']);
  });

  it('keeps at most 32 lists, dropping the oldest', async () => {
    const { sign } = await admin();
    for (let i = 0; i < 34; i++) {
      // Distinct machines: no list is covered by the others.
      const uuid = `6f1c2d3e-4a5b-4c6d-8e7f-${i.toString(16).padStart(12, '0')}`;
      installRevocation(dir, sign([{ uuid, serial: 1 }], NOW + i));
    }
    const lists = revocationState(dir).lists;
    expect(lists).toHaveLength(32);
    expect(Math.min(...lists.map((l) => l.body.issuedAt))).toBe(NOW + 2);
  });

  it('refuses a stored list that does not match its admin signature, naming the file', async () => {
    const { sign } = await admin();
    const l = sign([{ uuid: X, serial: 3 }], NOW);
    installRevocation(dir, l);
    const file = join(dir, 'revocation-lists.json');
    writeFileSync(file, JSON.stringify({ v: 1, lists: [{ ...l, body: { ...l.body, entries: [] } }] }));
    expect(() => revocationState(dir)).toThrow(/revocation-lists\.json.*signature/);
  });

  it('serves the same state object until a file changes (no re-verification per handshake)', async () => {
    const { sign } = await admin();
    installRevocation(dir, sign([{ uuid: X, serial: 3 }], NOW));
    const one = revocationState(dir);
    expect(revocationState(dir)).toBe(one);
    installRevocation(dir, sign([{ uuid: Y, serial: 3 }], NOW + 1));
    expect(revocationState(dir)).not.toBe(one);
  });

  it('runs an install under a cross-process lock: a second install in the read-to-write window is refused, nothing is lost', async () => {
    const { sign } = await admin();
    const l1 = sign([{ uuid: X, serial: 3 }], NOW);
    const l2 = sign([{ uuid: Y, serial: 1 }], NOW + 1);
    let nested: unknown;
    installRevocation(dir, l1, {
      afterRead: () => {
        try {
          installRevocation(dir, l2, { lockTimeoutMs: 100 });
        } catch (e) {
          nested = e;
        }
      },
    });
    expect((nested as Error).message).toMatch(/revocations\.json\.lock.*(held|another)/s);
    // The loser retries after the lock is gone and the first write is still there (re-read inside the lock).
    installRevocation(dir, l2);
    expect(revocationState(dir).digest).toBe(revocationDigest(sorted([{ uuid: X, serial: 3 }, { uuid: Y, serial: 1 }])));
  });

  it('signs inside the lock from what is installed at that moment', async () => {
    const { sign } = await admin();
    installRevocation(dir, sign([{ uuid: X, serial: 3 }], NOW));
    const result = signAndInstallRevocation(dir, ({ entries, version }) => {
      expect(entries).toEqual([{ uuid: X, serial: 3 }]);
      return sign(mergeRevocations(entries, [{ uuid: Z, serial: 1 }]), version + 1);
    });
    expect(result.signed.body.entries.map((e) => e.uuid).sort()).toEqual([X, Z].sort());
    expect(revocationState(dir).lists).toEqual([result.signed]);
  });

  it('records the revocation version and digest a peer announced at its last handshake', () => {
    initMachine(dir, 'desktop');
    expect(readRevocationSeen(dir)).toEqual({});
    recordRevocationSeen(dir, X, { version: 42, digest: 'a'.repeat(64) }, NOW);
    recordRevocationSeen(dir, Y, { version: 7, digest: 'b'.repeat(64) }, NOW + 1);
    recordRevocationSeen(dir, X, { version: 43, digest: 'c'.repeat(64) }, NOW + 2);
    expect(readRevocationSeen(dir)).toEqual({ [X]: { version: 43, digest: 'c'.repeat(64), at: NOW + 2 }, [Y]: { version: 7, digest: 'b'.repeat(64), at: NOW + 1 } });
  });

  it('treats a corrupt seen-versions file as empty with a warning naming it: list and status never fail on it', () => {
    initMachine(dir, 'desktop');
    writeFileSync(join(dir, 'revocation-seen.json'), '{broken');
    const warnings: string[] = [];
    expect(readRevocationSeen(dir, (m) => warnings.push(m))).toEqual({});
    expect(warnings.join('\n')).toMatch(/revocation-seen\.json.*(corrupt|invalid)/);
    recordRevocationSeen(dir, X, { version: 1, digest: 'a'.repeat(64) }, NOW, (m) => warnings.push(m));
    expect(readRevocationSeen(dir)).toEqual({ [X]: { version: 1, digest: 'a'.repeat(64), at: NOW } });
  });
});
