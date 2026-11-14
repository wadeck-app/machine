import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateSigningKeyPair, keyId, signPolicy, signRegistration, signRevocation, type PolicyBody, type RegistrationBody } from '@wadeck-app/machine-core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { exportMachineInfo, installPolicy, installRevocation, loadNetwork, registerMachine, importPeer } from './network.js';
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
