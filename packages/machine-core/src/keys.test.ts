import { describe, expect, it } from 'vitest';
import { generateSigningKeyPair, keyId, signBytes, verifyBytes } from './keys.js';

const message = new TextEncoder().encode('hello');

describe('signing keys', () => {
  it('signs and verifies', () => {
    const kp = generateSigningKeyPair();
    const sig = signBytes(kp.privateKeyPkcs8, message);
    expect(verifyBytes(kp.publicKey, message, sig)).toBe(true);
  });

  it('rejects a modified message', () => {
    const kp = generateSigningKeyPair();
    const sig = signBytes(kp.privateKeyPkcs8, message);
    expect(verifyBytes(kp.publicKey, new TextEncoder().encode('hellO'), sig)).toBe(false);
  });

  it('rejects another key', () => {
    const a = generateSigningKeyPair();
    const b = generateSigningKeyPair();
    const sig = signBytes(a.privateKeyPkcs8, message);
    expect(verifyBytes(b.publicKey, message, sig)).toBe(false);
  });

  it('rejects a malformed signature or key without throwing', () => {
    const kp = generateSigningKeyPair();
    expect(verifyBytes(kp.publicKey, message, 'not-a-signature')).toBe(false);
    expect(verifyBytes('short', message, 'AAAA')).toBe(false);
  });

  it('exposes a 32-byte raw public key as unpadded base64url', () => {
    const kp = generateSigningKeyPair();
    expect(kp.publicKey).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('gives a stable 32-hex key id that differs between keys', () => {
    const a = generateSigningKeyPair();
    const b = generateSigningKeyPair();
    expect(keyId(a.publicKey)).toBe(keyId(a.publicKey));
    expect(keyId(a.publicKey)).toMatch(/^[0-9a-f]{32}$/);
    expect(keyId(a.publicKey)).not.toBe(keyId(b.publicKey));
  });

  it('refuses a key id for a malformed public key, naming the problem', () => {
    expect(() => keyId('short')).toThrow(/public key.*32 bytes/);
  });
});
