import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { generateSigningKeyPair } from './keys.js';
import { ReplayCache, newRequest, signRequest, verifyRequest, type RequestBody } from './request.js';
import { signDocument } from './signed.js';

const SOURCE = '1b4e28ba-2fa1-4d3b-a3f4-0123456789ab';
const TARGET = '9c5d1e2f-3a4b-4c6d-8e7f-abcdef012345';
const NOW = 1_800_000_000;

function setup() {
  const source = generateSigningKeyPair();
  const body = newRequest({ source: SOURCE, target: TARGET, shell: 'cmd', command: 'ipconfig', now: NOW });
  return { source, body, signed: signRequest(body, source.privateKeyPkcs8) };
}

const ctx = (publicKey: string, over: Partial<{ now: number; selfUuid: string }> = {}) => ({ sourcePublicKey: publicKey, selfUuid: TARGET, now: NOW + 1, ...over });

describe('newRequest', () => {
  it('has a fresh id and nonce each time and a short lifetime', () => {
    const a = newRequest({ source: SOURCE, target: TARGET, shell: 'sh', command: 'ls', now: NOW });
    const b = newRequest({ source: SOURCE, target: TARGET, shell: 'sh', command: 'ls', now: NOW });
    expect(a.id).not.toBe(b.id);
    expect(a.nonce).not.toBe(b.nonce);
    expect(a.expiresAt - a.issuedAt).toBeLessThanOrEqual(60);
  });
});

describe('verifyRequest', () => {
  // The caller's ask (decision 96): an optional key of the SIGNED body, like the planned detach of detached-jobs.md; an older target refuses a 10-key body as malformed (fail closed).
  const askSigned = (ask: unknown) => {
    const source = generateSigningKeyPair();
    const body = { ...newRequest({ source: SOURCE, target: TARGET, shell: 'cmd', command: 'ipconfig', now: NOW }), ask } as unknown as RequestBody;
    return { source, signed: signRequest(body, source.privateKeyPkcs8) };
  };

  it('carries the ask of the caller in the signed body (10 keys) and returns it', () => {
    const source = generateSigningKeyPair();
    const body = newRequest({ source: SOURCE, target: TARGET, shell: 'cmd', command: 'ipconfig', now: NOW, ask: { times: 3, why: 'rerun' } });
    expect(Object.keys(body)).toHaveLength(10);
    const r = verifyRequest(signRequest(body, source.privateKeyPkcs8), ctx(source.publicKey));
    expect(r).toMatchObject({ ok: true, body: { ask: { times: 3, why: 'rerun' } } });
  });

  it('a body without an ask keeps its 9 keys (an older target still reads it)', () => {
    expect(Object.keys(setup().body)).toHaveLength(9);
  });

  it('an ask edited after signing is a bad signature', () => {
    const source = generateSigningKeyPair();
    const signed = signRequest(newRequest({ source: SOURCE, target: TARGET, shell: 'cmd', command: 'ipconfig', now: NOW, ask: { times: 1 } }), source.privateKeyPkcs8);
    const edited = { ...signed, body: { ...signed.body, ask: { for: 'permanent' } } };
    expect(verifyRequest(edited, ctx(source.publicKey))).toMatchObject({ ok: false, reason: 'bad-signature' });
  });

  it.each([
    ['times above the maximum', { times: 10001 }, /times.*1 to 10000/],
    ['a duration above 365 days', { for: '999d' }, /365 days/],
    ['times and for together', { times: 2, for: '1h' }, /only one of times and for/],
    ['a why with a control character', { why: 'a\u001b[2Jb' }, /printable ASCII/],
    ['an unknown key', { times: 1, extra: true }, /extra/],
    ['an empty ask', {}, /nothing/],
  ])('refuses at once, signed correctly, an ask with %s, naming the fix (never clamped)', (_name, ask, message) => {
    const { source, signed } = askSigned(ask);
    const r = verifyRequest(signed, ctx(source.publicKey));
    expect(r).toMatchObject({ ok: false, reason: 'bad-ask' });
    expect((r as { message: string }).message).toMatch(message);
    expect((r as { message: string }).message).toMatch(/machine run/);
  });

  it('an ask that is not an object is malformed', () => {
    const { source, signed } = askSigned('please');
    expect(verifyRequest(signed, ctx(source.publicKey))).toMatchObject({ ok: false, reason: 'malformed' });
  });

  it('accepts a request signed by the source key for this target', () => {
    const { source, signed } = setup();
    const r = verifyRequest(signed, ctx(source.publicKey));
    expect(r).toMatchObject({ ok: true });
  });

  it('refuses a request signed by another key', () => {
    const { signed } = setup();
    const other = generateSigningKeyPair();
    expect(verifyRequest(signed, ctx(other.publicKey))).toMatchObject({ ok: false, reason: 'bad-signature' });
  });

  it('refuses a request edited after signing, such as another command', () => {
    const { source, signed } = setup();
    const edited = { ...signed, body: { ...signed.body, command: 'format c:' } };
    expect(verifyRequest(edited, ctx(source.publicKey))).toMatchObject({ ok: false, reason: 'bad-signature' });
  });

  it('refuses a request meant for another machine (replay to a different target)', () => {
    const { source, signed } = setup();
    expect(verifyRequest(signed, ctx(source.publicKey, { selfUuid: SOURCE }))).toMatchObject({ ok: false, reason: 'wrong-target' });
  });

  it('refuses an expired request and a request from the future, beyond the clock skew', () => {
    const { source, signed } = setup();
    expect(verifyRequest(signed, ctx(source.publicKey, { now: signed.body.expiresAt + 31 }))).toMatchObject({ ok: false, reason: 'expired' });
    expect(verifyRequest(signed, ctx(source.publicKey, { now: signed.body.issuedAt - 31 }))).toMatchObject({ ok: false, reason: 'not-yet-valid' });
    expect(verifyRequest(signed, ctx(source.publicKey, { now: signed.body.issuedAt - 20 }))).toMatchObject({ ok: true });
  });

  it('refuses a request whose validity is longer than the maximum, even if correctly signed', () => {
    const { source } = setup();
    const long: RequestBody = { ...newRequest({ source: SOURCE, target: TARGET, shell: 'sh', command: 'ls', now: NOW }), expiresAt: NOW + 3600 };
    expect(verifyRequest(signRequest(long, source.privateKeyPkcs8), ctx(source.publicKey))).toMatchObject({ ok: false, reason: 'lifetime-too-long' });
  });

  it('refuses a malformed request without throwing', () => {
    const { source } = setup();
    for (const junk of [null, 5, 'x', {}, { body: {}, signature: 1 }, { body: { v: 2 }, signature: 'x' }]) {
      expect(verifyRequest(junk as never, ctx(source.publicKey))).toMatchObject({ ok: false, reason: 'malformed' });
    }
  });

  it('refuses an unknown shell or an unlaunchable command', () => {
    const { source } = setup();
    const bad = { ...newRequest({ source: SOURCE, target: TARGET, shell: 'sh', command: 'ls', now: NOW }), shell: 'zsh' } as unknown as RequestBody;
    expect(verifyRequest(signRequest(bad, source.privateKeyPkcs8), ctx(source.publicKey))).toMatchObject({ ok: false, reason: 'malformed' });
    const newline = newRequest({ source: SOURCE, target: TARGET, shell: 'sh', command: 'ls\nrm x', now: NOW });
    expect(verifyRequest(signRequest(newline, source.privateKeyPkcs8), ctx(source.publicKey))).toMatchObject({ ok: false, reason: 'malformed' });
  });

  it('does not accept a signature made for another document type (domain separation)', () => {
    const { source, body } = setup();
    const forged = { body, signature: signDocument('machine/policy/v1', body as never, source.privateKeyPkcs8) };
    expect(verifyRequest(forged, ctx(source.publicKey))).toMatchObject({ ok: false, reason: 'bad-signature' });
  });

  it('reports a broken pinned key as a result, not an exception', () => {
    const { signed } = setup();
    expect(verifyRequest(signed, ctx('not-a-key'))).toMatchObject({ ok: false });
  });
});

describe('ReplayCache', () => {
  it('accepts a nonce once and refuses its replay', () => {
    const cache = new ReplayCache(100);
    expect(cache.accept(SOURCE, 'n1', NOW + 60, NOW)).toEqual({ ok: true });
    expect(cache.accept(SOURCE, 'n1', NOW + 60, NOW + 1)).toMatchObject({ ok: false, reason: 'replay' });
  });

  it('scopes nonces per source', () => {
    const cache = new ReplayCache(100);
    expect(cache.accept(SOURCE, 'n1', NOW + 60, NOW).ok).toBe(true);
    expect(cache.accept(randomUUID(), 'n1', NOW + 60, NOW).ok).toBe(true);
  });

  it('forgets a nonce once its request has expired: it can no longer be replayed anyway', () => {
    const cache = new ReplayCache(100);
    cache.accept(SOURCE, 'n1', NOW + 60, NOW);
    expect(cache.accept(SOURCE, 'n2', NOW + 200, NOW + 100).ok).toBe(true);
    expect(cache.size()).toBe(1);
  });

  it('fails closed when full of live entries instead of forgetting one that could be replayed', () => {
    const cache = new ReplayCache(2);
    cache.accept(SOURCE, 'a', NOW + 60, NOW);
    cache.accept(SOURCE, 'b', NOW + 60, NOW);
    expect(cache.accept(SOURCE, 'c', NOW + 60, NOW)).toMatchObject({ ok: false, reason: 'busy' });
    expect(cache.accept(SOURCE, 'a', NOW + 60, NOW)).toMatchObject({ ok: false, reason: 'replay' });
  });
});
