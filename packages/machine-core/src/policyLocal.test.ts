import { describe, expect, it } from 'vitest';
import { signingInput } from './canonical.js';
import { generateSigningKeyPair, keyId, verifyBytes } from './keys.js';
import { applyPolicy, LOCAL_POLICY_DOMAIN, POLICY_DOMAIN, signPolicy, type PolicyBody } from './policy.js';
import { nextPolicyBody } from './policyEdit.js';
import { verifyDocument } from './signed.js';

// Hard rule 4 as amended (policy mode): a machine in mode `local` accepts policies signed by its OWN policy key, in the domain
// `machine/policy-local/v1`; a machine in mode `admin` accepts only the admin key, in `machine/policy/v1`.

const NOW = 1_800_000_000;
const TARGET = '6f1c2d3e-4a5b-4c6d-8e7f-0a1b2c3d4e5f';
const PEER = '0a1b2c3d-4e5f-4a6b-9c7d-8e9f0a1b2c3d';

const bodyFor = (signer: { publicKey: string }, extra: Partial<PolicyBody> = {}): PolicyBody => ({
  v: 1,
  target: TARGET,
  version: 1,
  baseVersion: 0,
  adminKeyId: keyId(signer.publicKey),
  issuedAt: NOW,
  notBefore: NOW - 60,
  notAfter: NOW + 3600,
  defaults: [{ shell: 'sh', command: 'uptime' }],
  peers: {},
  ...extra,
});

const state = { version: 0, highestSeen: 0 };

describe('domain separation of the local policy signature', () => {
  it('uses a domain string different from the admin one', () => {
    expect(LOCAL_POLICY_DOMAIN).toBe('machine/policy-local/v1');
    expect(LOCAL_POLICY_DOMAIN).not.toBe(POLICY_DOMAIN);
  });

  it('with the SAME private key, a local signature never verifies as an admin one, and the other way round', () => {
    const key = generateSigningKeyPair();
    const body = bodyFor(key);
    const local = signPolicy(body, key.privateKeyPkcs8, 'local');
    const admin = signPolicy(body, key.privateKeyPkcs8);
    expect(local.signature).not.toBe(admin.signature);
    expect(verifyDocument(POLICY_DOMAIN, body as never, key.publicKey, local.signature)).toBe(false);
    expect(verifyDocument(LOCAL_POLICY_DOMAIN, body as never, key.publicKey, admin.signature)).toBe(false);
    expect(verifyDocument(LOCAL_POLICY_DOMAIN, body as never, key.publicKey, local.signature)).toBe(true);
    expect(verifyDocument(POLICY_DOMAIN, body as never, key.publicKey, admin.signature)).toBe(true);
    // The signed bytes begin with the domain: nothing but the domain tells the two apart.
    expect(verifyBytes(key.publicKey, signingInput(POLICY_DOMAIN, body as never), local.signature)).toBe(false);
  });

  it('applyPolicy in mode admin refuses a policy signed by a local key, even when the key id is claimed as the admin one', () => {
    const admin = generateSigningKeyPair();
    const local = generateSigningKeyPair();
    // Forged: the local key signs a body that claims the admin key id.
    const forged = signPolicy(bodyFor(admin), local.privateKeyPkcs8, 'local');
    expect(applyPolicy(state, forged, { adminPublicKey: admin.publicKey, now: NOW, targetUuid: TARGET })).toMatchObject({ ok: false, reason: 'bad-signature' });
    // Honest: the body names the local key id.
    const honest = signPolicy(bodyFor(local), local.privateKeyPkcs8, 'local');
    const refused = applyPolicy(state, honest, { adminPublicKey: admin.publicKey, now: NOW, targetUuid: TARGET });
    expect(refused).toMatchObject({ ok: false, reason: 'wrong-admin-key' });
    expect((refused as { message: string }).message).toMatch(/machine policy local/);
  });

  it('applyPolicy in mode local refuses an admin-signed policy with the delegate advice, and a forged one by its signature', () => {
    const admin = generateSigningKeyPair();
    const local = generateSigningKeyPair();
    const ctx = { mode: 'local' as const, adminPublicKey: admin.publicKey, localPublicKey: local.publicKey, now: NOW, targetUuid: TARGET };
    const adminSigned = signPolicy(bodyFor(admin), admin.privateKeyPkcs8);
    const refused = applyPolicy(state, adminSigned, ctx);
    expect(refused).toMatchObject({ ok: false, reason: 'wrong-mode' });
    expect((refused as { message: string }).message).toBe('this machine manages its own allow list (machine policy delegate to give it back to the admin)');
    // Forged: the admin key signs a body that claims the local key id, in the admin domain.
    expect(applyPolicy(state, signPolicy(bodyFor(local), admin.privateKeyPkcs8), ctx)).toMatchObject({ ok: false, reason: 'bad-signature' });
    // Signed in the admin domain with the local key itself.
    expect(applyPolicy(state, signPolicy(bodyFor(local), local.privateKeyPkcs8), ctx)).toMatchObject({ ok: false, reason: 'bad-signature' });
  });
});

describe('the verifier is chosen by the mode', () => {
  it('mode local accepts the local signature, bound to this machine', () => {
    const admin = generateSigningKeyPair();
    const local = generateSigningKeyPair();
    const ctx = { mode: 'local' as const, adminPublicKey: admin.publicKey, localPublicKey: local.publicKey, now: NOW, targetUuid: TARGET };
    const signed = signPolicy(bodyFor(local), local.privateKeyPkcs8, 'local');
    expect(applyPolicy(state, signed, ctx)).toEqual({ ok: true, body: signed.body });
    const other = signPolicy(bodyFor(local, { target: PEER }), local.privateKeyPkcs8, 'local');
    expect(applyPolicy(state, other, ctx)).toMatchObject({ ok: false, reason: 'wrong-target' });
  });

  it('mode local without a pinned local key fails loudly, never falls back to the admin key', () => {
    const admin = generateSigningKeyPair();
    const signed = signPolicy(bodyFor(admin), admin.privateKeyPkcs8);
    const result = applyPolicy(state, signed, { mode: 'local', adminPublicKey: admin.publicKey, now: NOW, targetUuid: TARGET });
    expect(result).toMatchObject({ ok: false, reason: 'invalid-admin-key' });
    expect((result as { message: string }).message).toMatch(/local policy key/);
  });

  it('mode admin (explicit) accepts the admin signature', () => {
    const admin = generateSigningKeyPair();
    const signed = signPolicy(bodyFor(admin), admin.privateKeyPkcs8);
    expect(applyPolicy(state, signed, { mode: 'admin', adminPublicKey: admin.publicKey, now: NOW, targetUuid: TARGET }).ok).toBe(true);
  });
});

describe('rollback protection is the same in local mode (T-16)', () => {
  it('refuses a stale base, a replay and a lower version', () => {
    const admin = generateSigningKeyPair();
    const local = generateSigningKeyPair();
    const ctx = { mode: 'local' as const, adminPublicKey: admin.publicKey, localPublicKey: local.publicKey, now: NOW, targetUuid: TARGET };
    const v2 = signPolicy(bodyFor(local, { version: 2, baseVersion: 1 }), local.privateKeyPkcs8, 'local');
    expect(applyPolicy({ version: 2, highestSeen: 2 }, v2, ctx)).toMatchObject({ ok: false, reason: 'stale-base' });
    expect(applyPolicy({ version: 1, highestSeen: 3 }, v2, ctx)).toMatchObject({ ok: false, reason: 'rollback' });
    expect(applyPolicy({ version: 1, highestSeen: 1 }, v2, ctx).ok).toBe(true);
  });
});

describe('per-peer edits of the next policy (policy allow --peer)', () => {
  const ctx = { target: TARGET, adminKeyId: '0'.repeat(32), now: NOW };
  const entry = (command: string) => ({ shell: 'sh' as const, command });

  it('creates an own list for the peer seeded with the defaults, so the peer keeps what it could run', () => {
    const first = nextPolicyBody(undefined, ctx, { kind: 'allow', entry: entry('uptime') });
    if (!first.changed) throw new Error('expected a change');
    const edit = nextPolicyBody(first.body, ctx, { kind: 'allow', entry: entry('df -h'), peer: PEER });
    if (!edit.changed) throw new Error('expected a change');
    expect(edit.body.defaults).toEqual([entry('uptime')]);
    expect(edit.body.peers[PEER]).toEqual([entry('uptime'), entry('df -h')]);
    expect(edit.added).toEqual([entry('df -h')]);
    expect(edit.seededPeerList).toBe(true);
  });

  it('adds to an existing own list without seeding again, and says already-allowed on a repeat', () => {
    const seeded = nextPolicyBody(undefined, ctx, { kind: 'allow', entry: entry('df -h'), peer: PEER });
    if (!seeded.changed) throw new Error('expected a change');
    expect(seeded.body.peers[PEER]).toEqual([entry('df -h')]);
    const again = nextPolicyBody(seeded.body, ctx, { kind: 'allow', entry: entry('ls'), peer: PEER });
    if (!again.changed) throw new Error('expected a change');
    expect(again.seededPeerList).toBe(false);
    expect(nextPolicyBody(seeded.body, ctx, { kind: 'allow', entry: entry('df -h'), peer: PEER })).toEqual({ changed: false, reason: 'already-allowed' });
  });

  it('removes from the own list of the peer only, and leaves the defaults alone', () => {
    const a = nextPolicyBody(undefined, ctx, { kind: 'allow', entry: entry('uptime') });
    if (!a.changed) throw new Error('x');
    const b = nextPolicyBody(a.body, ctx, { kind: 'allow', entry: entry('df -h'), peer: PEER });
    if (!b.changed) throw new Error('x');
    const c = nextPolicyBody(b.body, ctx, { kind: 'remove', command: 'df -h', peer: PEER });
    if (!c.changed) throw new Error('x');
    expect(c.body.defaults).toEqual([entry('uptime')]);
    expect(c.body.peers[PEER]).toEqual([entry('uptime')]);
    expect(nextPolicyBody(c.body, ctx, { kind: 'remove', command: 'nothing', peer: PEER })).toEqual({ changed: false, reason: 'not-allowed' });
  });
});
