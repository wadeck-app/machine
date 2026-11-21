import { REQUESTS_LIST_DOMAIN as CORE_DOMAIN, signRequestsList as coreSign, verifyRequestsList } from '@wadeck-app/machine-core';
import { describe, expect, it } from 'vitest';
import { newPair, uuid, webKeyFrom } from '../test-support/kit.js';
import { markLocked } from './signed.js';
import { REQUESTS_LIST_DOMAIN, newRequestsListBody, signRequestsList } from './requestsList.js';

// The read-only `requests-list` document of the Requests page, signed in the browser with the admin key (decision 74). The peer is machine-core:
// what is built and signed here must be accepted by its verifier, byte for byte.

const SOURCE = uuid();
const TARGET = uuid();
const NOW = Math.floor(Date.now() / 1000);

describe('requests-list document of the browser', () => {
  it('uses the domain of machine-core', () => {
    expect(REQUESTS_LIST_DOMAIN).toBe(CORE_DOMAIN);
  });

  it('is accepted by the verifier of the target when signed with the admin key', async () => {
    const admin = newPair();
    const signed = await signRequestsList(newRequestsListBody({ source: SOURCE, target: TARGET, limit: 50, now: NOW }), await webKeyFrom(admin));
    expect(verifyRequestsList(signed, { adminPublicKey: admin.publicKey, selfUuid: TARGET, peerUuid: SOURCE, now: NOW + 1 })).toMatchObject({ ok: true, body: { limit: 50, source: SOURCE, target: TARGET } });
  });

  it('gives the same signature as machine-core for the same body (Ed25519 is deterministic)', async () => {
    const admin = newPair();
    const body = newRequestsListBody({ source: SOURCE, target: TARGET, limit: 10, now: NOW });
    const web = await signRequestsList(body, await webKeyFrom(admin));
    expect(web.signature).toBe(coreSign(body, admin.privateKeyPkcs8).signature);
  });

  it('is refused by the verifier when signed by another key, or addressed to another machine', async () => {
    const admin = newPair();
    const other = await signRequestsList(newRequestsListBody({ source: SOURCE, target: TARGET, limit: 5, now: NOW }), await webKeyFrom(newPair()));
    expect(verifyRequestsList(other, { adminPublicKey: admin.publicKey, selfUuid: TARGET, peerUuid: SOURCE, now: NOW })).toMatchObject({ ok: false, reason: 'bad-signature' });
    const mine = await signRequestsList(newRequestsListBody({ source: SOURCE, target: TARGET, limit: 5, now: NOW }), await webKeyFrom(admin));
    expect(verifyRequestsList(mine, { adminPublicKey: admin.publicKey, selfUuid: uuid(), peerUuid: SOURCE, now: NOW })).toMatchObject({ ok: false, reason: 'wrong-target' });
  });

  it('has a fresh id and nonce each time and lives at most 60 seconds', () => {
    const a = newRequestsListBody({ source: SOURCE, target: TARGET, limit: 5, now: NOW });
    const b = newRequestsListBody({ source: SOURCE, target: TARGET, limit: 5, now: NOW });
    expect(a.id).not.toBe(b.id);
    expect(a.nonce).not.toBe(b.nonce);
    expect(a.expiresAt - a.issuedAt).toBeLessThanOrEqual(60);
  });

  it('refuses to build a body the peer would refuse: a limit outside 1..100, a source or target that is not a uuid', () => {
    expect(() => newRequestsListBody({ source: SOURCE, target: TARGET, limit: 0, now: NOW })).toThrow(/limit/);
    expect(() => newRequestsListBody({ source: SOURCE, target: TARGET, limit: 101, now: NOW })).toThrow(/limit/);
    expect(() => newRequestsListBody({ source: 'nope', target: TARGET, limit: 5, now: NOW })).toThrow(/source/);
    expect(() => newRequestsListBody({ source: SOURCE, target: 'nope', limit: 5, now: NOW })).toThrow(/target/);
  });

  it('refuses a locked key', async () => {
    const key = await webKeyFrom(newPair());
    markLocked(key);
    await expect(signRequestsList(newRequestsListBody({ source: SOURCE, target: TARGET, limit: 5, now: NOW }), key)).rejects.toThrow(/locked/);
  });
});
