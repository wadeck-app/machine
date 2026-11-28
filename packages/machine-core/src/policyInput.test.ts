import { describe, expect, it } from 'vitest';
import { generateSigningKeyPair, keyId } from './keys.js';
import { applyPolicy, assertPolicyBody, authorize, hasInputEntry, policyBodyVersion, signPolicy, type PolicyBody, type PolicyEntry } from './policy.js';
import { nextPolicyBody, nextPolicyBodyRemoveMany, nextPolicyBodyRenewMany } from './policyEdit.js';
import { newRequest, signRequest, verifyRequest, type RequestBody } from './request.js';
import { inputDigest } from './stdinInput.js';

// Policy entries that declare an input on stdin (stdin-input.md, decision 114): a new body version (3) that older readers refuse by name.

const NOW = 1_800_000_000;
const TARGET = '6f1c2d3e-4a5b-4c6d-8e7f-0a1b2c3d4e5f';
const PEER = '0a1b2c3d-4e5f-4a6b-9c7d-8e9f0a1b2c3d';
const KEY = keyId(generateSigningKeyPair().publicKey);
const INPUT = { format: 'json', maxBytes: 65536, chars: ['letters', 'digits', 'space', 'json'] } as const;

const withInput = (command = 'task remote-call', input: PolicyEntry['input'] = { ...INPUT, chars: [...INPUT.chars] }): PolicyEntry => ({ shell: 'sh', command, input });
const plain = (command: string): PolicyEntry => ({ shell: 'sh', command });
const body = (defaults: PolicyEntry[], over: Partial<PolicyBody> = {}): PolicyBody => ({ v: 3, target: TARGET, version: 1, baseVersion: 0, adminKeyId: KEY, issuedAt: NOW, notBefore: NOW - 60, notAfter: NOW + 3600, defaults, peers: {}, ...over });
const ctx = { target: TARGET, adminKeyId: KEY, now: NOW };

describe('the policy body with an input declaration is version 3', () => {
  it('reads a v3 body with an input entry, exact or typed', () => {
    expect(() => assertPolicyBody(body([withInput(), { shell: 'sh', template: 'task call <op:enum(get|add)>', input: { ...INPUT, chars: [...INPUT.chars] } }]))).not.toThrow();
  });
  it('a v1 or v2 body cannot hold an input and says which version to use', () => {
    expect(() => assertPolicyBody(body([withInput()], { v: 1 }))).toThrow(/input.*version 3/);
    expect(() => assertPolicyBody(body([withInput()], { v: 2 }))).toThrow(/input.*version 3/);
  });
  it('a reader that knows versions 1 and 2 refuses version 3 loudly and names `machine cli update`', () => {
    expect(() => assertPolicyBody(body([withInput()]), { readsUpTo: 2 })).toThrow(/unsupported version 3.*machine cli update/);
  });
  it('version 4 does not exist', () => {
    expect(() => assertPolicyBody(body([], { v: 4 as never }))).toThrow(/unsupported version 4.*machine cli update/);
  });
  it('a malformed declaration is refused at load, naming the list', () => {
    expect(() => assertPolicyBody(body([withInput('x', { format: 'json', maxBytes: 10, chars: ['letters'] })]))).toThrow(/json family.*defaults|defaults.*json family/);
    expect(() => assertPolicyBody(body([withInput('x', { format: 'text', maxBytes: 600_000, chars: ['letters'] })]))).toThrow(/maxBytes.*defaults/);
    expect(() => assertPolicyBody(body([{ shell: 'sh', command: 'x', input: undefined } as never]))).toThrow(/input.*omitted/);
  });
  it('the entry that is identical but for its input is a duplicate (one entry per shell and text)', () => {
    expect(() => assertPolicyBody(body([withInput('same'), plain('same')]))).toThrow(/duplicate/);
  });
  it('policyBodyVersion: 1 exact, 2 typed or renewed, 3 input', () => {
    expect(policyBodyVersion([[plain('a')]])).toBe(1);
    expect(policyBodyVersion([[{ shell: 'sh', template: 'a <n:int(1,2)>' }]])).toBe(2);
    expect(policyBodyVersion([[plain('a')], [withInput()]])).toBe(3);
    expect(hasInputEntry([[plain('a')]])).toBe(false);
  });
  it('is signed and applied like any policy (the signature covers the declaration)', () => {
    const pair = generateSigningKeyPair();
    const b = body([withInput()], { adminKeyId: keyId(pair.publicKey) });
    const signed = signPolicy(b, pair.privateKeyPkcs8);
    const applied = applyPolicy({ version: 0, highestSeen: 0 }, signed, { adminPublicKey: pair.publicKey, now: NOW, targetUuid: TARGET });
    expect(applied.ok).toBe(true);
    const widened = { ...signed, body: { ...signed.body, defaults: [withInput('task remote-call', { ...INPUT, maxBytes: 524288, chars: [...INPUT.chars] })] } };
    const r = applyPolicy({ version: 0, highestSeen: 0 }, widened, { adminPublicKey: pair.publicKey, now: NOW, targetUuid: TARGET });
    expect(r).toMatchObject({ ok: false, reason: 'bad-signature' });
  });
});

describe('authorize returns the entry with its declaration', () => {
  it('the matched entry carries the input; an entry without one carries none', () => {
    const b = body([withInput('task remote-call'), plain('uptime')]);
    const a = authorize(b, PEER, { shell: 'sh', command: 'task remote-call' }, NOW, () => 0);
    expect(a).toMatchObject({ allowed: true, entry: { input: { format: 'json' } } });
    const u = authorize(b, PEER, { shell: 'sh', command: 'uptime' }, NOW, () => 0);
    expect(u.allowed && u.entry.input).toBeUndefined();
  });
});

describe('editing a policy with an input declaration', () => {
  it('builds a version 3 body when an entry declares input, version 1 when none does', () => {
    const edit = nextPolicyBody(undefined, ctx, { kind: 'allow', entry: withInput() });
    expect(edit.changed && edit.body.v).toBe(3);
    const plainEdit = nextPolicyBody(undefined, ctx, { kind: 'allow', entry: plain('uptime') });
    expect(plainEdit.changed && plainEdit.body.v).toBe(1);
  });
  it('removing the only input entry brings the version back (nothing needs version 3)', () => {
    const first = nextPolicyBody(undefined, ctx, { kind: 'allow', entry: withInput() });
    if (!first.changed) throw new Error('unreachable');
    const removed = nextPolicyBody(first.body, ctx, { kind: 'remove', command: 'task remote-call' });
    expect(removed.changed && removed.body.v).toBe(1);
    const many = nextPolicyBodyRemoveMany(first.body, ctx, [{ index: 1, shell: 'sh', text: 'task remote-call' }]);
    expect(many.body.v).toBe(1);
  });
  it('allowing the same command with another declaration REPLACES it (the declaration is what the entry authorizes), it is not "already allowed"', () => {
    const first = nextPolicyBody(undefined, ctx, { kind: 'allow', entry: withInput() });
    if (!first.changed) throw new Error('unreachable');
    const wider = withInput('task remote-call', { ...INPUT, maxBytes: 131072, chars: [...INPUT.chars] });
    const second = nextPolicyBody(first.body, ctx, { kind: 'allow', entry: wider });
    expect(second.changed).toBe(true);
    if (!second.changed) throw new Error('unreachable');
    expect(second.body.defaults).toHaveLength(1);
    expect(second.body.defaults[0]?.input?.maxBytes).toBe(131072);
    expect(second.renewed).toHaveLength(1);
    // the same declaration again is nothing to sign
    expect(nextPolicyBody(second.body, ctx, { kind: 'allow', entry: wider })).toEqual({ changed: false, reason: 'already-allowed' });
    // dropping the declaration is also a change
    const dropped = nextPolicyBody(second.body, ctx, { kind: 'allow', entry: plain('task remote-call') });
    expect(dropped.changed && dropped.body.defaults[0]?.input).toBeUndefined();
  });
  it('a renewal of an entry keeps its declaration', () => {
    const first = nextPolicyBody(undefined, ctx, { kind: 'allow', entry: { ...withInput(), limits: { maxCalls: 2 } } });
    if (!first.changed) throw new Error('unreachable');
    const renewed = nextPolicyBodyRenewMany(first.body, ctx, [{ index: 1, shell: 'sh', text: 'task remote-call' }], { maxCalls: 5 });
    expect(renewed.body.defaults[0]?.input?.format).toBe('json');
    expect(renewed.body.v).toBe(3);
  });
});

describe('the signed request carries the size and the hash of the payload', () => {
  const payload = new TextEncoder().encode('{"op":"get"}');
  const verifyCtx = (publicKey: string) => ({ sourcePublicKey: publicKey, selfUuid: TARGET, now: NOW + 1 });
  it('has an `input` key (10 keys, 11 with an ask) and verifies', () => {
    const source = generateSigningKeyPair();
    const digest = inputDigest(payload);
    const b = newRequest({ source: PEER, target: TARGET, shell: 'sh', command: 'task remote-call', now: NOW, input: digest });
    expect(Object.keys(b)).toHaveLength(10);
    expect(b.input).toEqual(digest);
    expect(verifyRequest(signRequest(b, source.privateKeyPkcs8), verifyCtx(source.publicKey))).toMatchObject({ ok: true, body: { input: digest } });
    const both = newRequest({ source: PEER, target: TARGET, shell: 'sh', command: 'x', now: NOW, input: digest, ask: { times: 1 } });
    expect(Object.keys(both)).toHaveLength(11);
    expect(verifyRequest(signRequest(both, source.privateKeyPkcs8), verifyCtx(source.publicKey)).ok).toBe(true);
  });
  it('a request without input keeps its 9 keys (an older target still reads it)', () => {
    expect(Object.keys(newRequest({ source: PEER, target: TARGET, shell: 'sh', command: 'x', now: NOW }))).toHaveLength(9);
  });
  it('the declared size and hash cannot be edited after signing', () => {
    const source = generateSigningKeyPair();
    const b = newRequest({ source: PEER, target: TARGET, shell: 'sh', command: 'x', now: NOW, input: inputDigest(payload) });
    const signed = signRequest(b, source.privateKeyPkcs8);
    const edited = { ...signed, body: { ...signed.body, input: { ...signed.body.input, bytes: 3 } } };
    expect(verifyRequest(edited, verifyCtx(source.publicKey))).toMatchObject({ ok: false, reason: 'bad-signature' });
  });
  it.each([
    ['not an object', 'x'],
    ['negative size', { bytes: -1, sha256: 'a'.repeat(64) }],
    ['fractional size', { bytes: 1.5, sha256: 'a'.repeat(64) }],
    ['size above the ceiling', { bytes: 524289, sha256: 'a'.repeat(64) }],
    ['uppercase hash', { bytes: 1, sha256: 'A'.repeat(64) }],
    ['short hash', { bytes: 1, sha256: 'a'.repeat(63) }],
    ['extra key', { bytes: 1, sha256: 'a'.repeat(64), x: 1 }],
  ])('refuses %s as malformed', (_n, input) => {
    const source = generateSigningKeyPair();
    const b = { ...newRequest({ source: PEER, target: TARGET, shell: 'sh', command: 'x', now: NOW }), input } as unknown as RequestBody;
    // The shape is judged before the signature: a body that cannot even be canonicalized (a fraction) is refused the same way.
    expect(verifyRequest({ body: b, signature: 'x' }, verifyCtx(source.publicKey))).toMatchObject({ ok: false, reason: 'malformed' });
  });
});
