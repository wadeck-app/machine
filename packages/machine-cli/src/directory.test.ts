import { randomBytes } from 'node:crypto';
import { generateSigningKeyPair, keyId, signRegistration, type RegistrationBody } from '@wadeck-app/machine-core';
import { describe, expect, it } from 'vitest';
import { buildDirectory } from './directory.js';

const NOW = 1_800_000_000;
const SELF = '1b4e28ba-2fa1-4d3b-a3f4-0123456789ab';

const admin = generateSigningKeyPair();

function registered(uuid: string, name: string, over: Partial<RegistrationBody> = {}, signWith = admin) {
  const identity = generateSigningKeyPair();
  const body: RegistrationBody = {
    v: 1,
    uuid,
    name,
    identityPublicKey: identity.publicKey,
    serial: 1,
    validFrom: NOW - 100,
    validTo: NOW + 100_000,
    adminKeyId: keyId(admin.publicKey),
    ...over,
  };
  return { identity, entry: { registration: signRegistration(body, signWith.privateKeyPkcs8), pairSecret: randomBytes(32) } };
}

const ctx = { adminPublicKey: admin.publicKey, now: NOW, revocations: [], selfUuid: SELF };

describe('buildDirectory', () => {
  it('finds a peer by the key it presents, with its pair secret', () => {
    const laptop = registered('9c5d1e2f-3a4b-4c6d-8e7f-abcdef012345', 'laptop');
    const dir = buildDirectory([laptop.entry], ctx);
    expect(dir.lookup(laptop.identity.publicKey)).toEqual({ peerId: '9c5d1e2f-3a4b-4c6d-8e7f-abcdef012345', name: 'laptop', pairSecret: laptop.entry.pairSecret });
    expect(dir.machines()).toEqual([{ uuid: '9c5d1e2f-3a4b-4c6d-8e7f-abcdef012345', name: 'laptop' }]);
    expect(dir.problems).toEqual([]);
  });

  it('does not know an unregistered key', () => {
    expect(buildDirectory([], ctx).lookup(generateSigningKeyPair().publicKey)).toBeUndefined();
  });

  it('leaves out, and reports, a registration signed by another admin', () => {
    const stranger = generateSigningKeyPair();
    const bad = registered('9c5d1e2f-3a4b-4c6d-8e7f-abcdef012345', 'laptop', {}, stranger);
    const dir = buildDirectory([bad.entry], ctx);
    expect(dir.lookup(bad.identity.publicKey)).toBeUndefined();
    expect(dir.problems[0]).toMatch(/laptop.*(admin|signature)/i);
  });

  it('leaves out, and reports, an expired and a revoked registration', () => {
    const old = registered('9c5d1e2f-3a4b-4c6d-8e7f-abcdef012345', 'old', { validFrom: NOW - 1000, validTo: NOW - 500 });
    const gone = registered('8d6e2f30-4b5c-4d7e-9f80-bcdef0123456', 'gone');
    const dir = buildDirectory([old.entry, gone.entry], { ...ctx, revocations: [{ uuid: '8d6e2f30-4b5c-4d7e-9f80-bcdef0123456', serial: 1 }] });
    expect(dir.machines()).toEqual([]);
    expect(dir.problems.join('\n')).toMatch(/old.*expired/);
    expect(dir.problems.join('\n')).toMatch(/gone.*revoked/);
  });

  it('leaves out this machine itself', () => {
    const me = registered(SELF, 'me');
    expect(buildDirectory([me.entry], ctx).machines()).toEqual([]);
  });

  it('refuses two registrations that claim the same key, because one key must mean one machine', () => {
    const a = registered('9c5d1e2f-3a4b-4c6d-8e7f-abcdef012345', 'a');
    const b = registered('8d6e2f30-4b5c-4d7e-9f80-bcdef0123456', 'b', { identityPublicKey: a.identity.publicKey });
    const dir = buildDirectory([a.entry, b.entry], ctx);
    expect(dir.lookup(a.identity.publicKey)).toBeUndefined();
    expect(dir.problems.join('\n')).toMatch(/same (identity )?key/i);
  });

  it('refuses a pair secret of the wrong size, naming the machine', () => {
    const a = registered('9c5d1e2f-3a4b-4c6d-8e7f-abcdef012345', 'a');
    const dir = buildDirectory([{ ...a.entry, pairSecret: randomBytes(5) }], ctx);
    expect(dir.lookup(a.identity.publicKey)).toBeUndefined();
    expect(dir.problems[0]).toMatch(/a.*pair secret/);
  });
});

describe('buildDirectory (review hardening)', () => {
  it('reports a null or malformed registration entry and still loads the others', () => {
    const good = registered('9c5d1e2f-3a4b-4c6d-8e7f-abcdef012345', 'good');
    const dir = buildDirectory([{ registration: null as never, pairSecret: randomBytes(32) }, { registration: 5 as never, pairSecret: randomBytes(32) }, good.entry], ctx);
    expect(dir.lookup(good.identity.publicKey)).toBeDefined();
    expect(dir.problems).toHaveLength(2);
  });

  it('keeps only the highest serial for a uuid registered twice, and says the other was superseded', () => {
    const uuid = '9c5d1e2f-3a4b-4c6d-8e7f-abcdef012345';
    const older = registered(uuid, 'laptop', { serial: 1 });
    const newer = registered(uuid, 'laptop', { serial: 2 });
    const dir = buildDirectory([older.entry, newer.entry], ctx);
    expect(dir.lookup(newer.identity.publicKey)).toBeDefined();
    expect(dir.lookup(older.identity.publicKey)).toBeUndefined();
    expect(dir.machines()).toHaveLength(1);
    expect(dir.problems.join('\n')).toMatch(/laptop.*superseded/);
  });
});
