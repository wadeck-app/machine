import { keyId as coreKeyId, signDocument, verifyDocument, type Json } from '@wadeck-app/machine-core';
import { describe, expect, it } from 'vitest';
import { newPair, pkcs8FromSeed, prng, randomJson, webKeyFrom } from '../test-support/kit.js';
import { decodeBase64urlStrict } from './base64url.js';
import { keyId, tryKeyId } from './keys.js';
import { signBody, verifyBody } from './signed.js';

const DOMAIN = 'machine/test/v1';

describe('signBody / verifyBody against machine-core', () => {
  it('RFC 8032 test vector 1 (empty message) through the WebCrypto key import used here', async () => {
    const seed = Buffer.from('9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60', 'hex');
    const key = await crypto.subtle.importKey('pkcs8', pkcs8FromSeed(seed) as BufferSource, 'Ed25519', false, ['sign']);
    const signature = Buffer.from(await crypto.subtle.sign('Ed25519', key, new Uint8Array(0))).toString('hex');
    expect(signature.startsWith('e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e06522490155')).toBe(true);
  });

  it('100 random cases: sign here verifies in machine-core, sign in machine-core verifies here, and the signatures are byte-identical (Ed25519 is deterministic)', async () => {
    const rand = prng(7);
    const pair = newPair();
    const key = await webKeyFrom(pair);
    const raw = decodeBase64urlStrict(pair.publicKey, 32, 'k');
    for (let i = 0; i < 100; i++) {
      const body = { n: i, v: randomJson(rand) } as Json;
      const web = await signBody(DOMAIN, body, key);
      expect(verifyDocument(DOMAIN, body, pair.publicKey, web.signature)).toBe(true);
      const core = signDocument(DOMAIN, body, pair.privateKeyPkcs8);
      expect(web.signature).toBe(core);
      expect(await verifyBody(DOMAIN, { body, signature: core }, raw)).toBe(true);
    }
  });

  it('domain separation: a signature for one domain does not verify under another, on both sides', async () => {
    const pair = newPair();
    const key = await webKeyFrom(pair);
    const raw = decodeBase64urlStrict(pair.publicKey, 32, 'k');
    const web = await signBody(DOMAIN, { a: 1 }, key);
    expect(await verifyBody('machine/other/v1', web, raw)).toBe(false);
    expect(verifyDocument('machine/other/v1', web.body, pair.publicKey, web.signature)).toBe(false);
  });

  it('verifyBody never throws: altered body, other key, malformed signature, malformed key are all just false', async () => {
    const pair = newPair();
    const key = await webKeyFrom(pair);
    const raw = decodeBase64urlStrict(pair.publicKey, 32, 'k');
    const web = await signBody(DOMAIN, { a: 1 }, key);
    expect(await verifyBody(DOMAIN, { body: { a: 2 }, signature: web.signature }, raw)).toBe(false);
    expect(await verifyBody(DOMAIN, web, decodeBase64urlStrict(newPair().publicKey, 32, 'k'))).toBe(false);
    expect(await verifyBody(DOMAIN, { body: web.body, signature: 'AAAA' }, raw)).toBe(false);
    expect(await verifyBody(DOMAIN, { body: web.body, signature: 12 as never }, raw)).toBe(false);
    expect(await verifyBody(DOMAIN, web, new Uint8Array(5))).toBe(false);
    expect(await verifyBody(DOMAIN, { body: { a: 1.5 } as never, signature: web.signature }, raw)).toBe(false);
    expect(await verifyBody(DOMAIN, web, pair.publicKey)).toBe(true);
  });

  it('signBody refuses a body that cannot be canonicalized, naming the path', async () => {
    const key = await webKeyFrom(newPair());
    await expect(signBody(DOMAIN, { a: { b: 1.5 } } as never, key)).rejects.toThrow(/a\.b.*safe integer/);
  });
});

describe('keyId', () => {
  it('equals machine-core for 100 random keys, and refuses a malformed key like machine-core', async () => {
    for (let i = 0; i < 100; i++) {
      const { publicKey } = newPair();
      expect(await keyId(publicKey)).toBe(coreKeyId(publicKey));
    }
    await expect(keyId('AAAA')).rejects.toThrow(/public key/);
    expect(await tryKeyId('AAAA')).toBeUndefined();
  });
});
