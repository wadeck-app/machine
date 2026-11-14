import { describe, expect, it } from 'vitest';
import { checkPassphrase, decryptAdminKey, encryptAdminKey, generatePassphrase } from './adminKey.js';
import { generateSigningKeyPair, signBytes, verifyBytes } from './keys.js';

const STRONG = 'correct horse battery staple 7391';

describe('admin key at rest', () => {
  it('round-trips with the right passphrase and keeps signing working', () => {
    const kp = generateSigningKeyPair();
    const envelope = encryptAdminKey(kp, STRONG);
    const back = decryptAdminKey(envelope, STRONG);
    expect(back.publicKey).toBe(kp.publicKey);
    const sig = signBytes(back.privateKeyPkcs8, new TextEncoder().encode('x'));
    expect(verifyBytes(kp.publicKey, new TextEncoder().encode('x'), sig)).toBe(true);
  });

  it('fails with a wrong passphrase, loudly and without saying anything about the key', () => {
    const envelope = encryptAdminKey(generateSigningKeyPair(), STRONG);
    expect(() => decryptAdminKey(envelope, 'another passphrase that is long enough 1')).toThrow(/wrong passphrase or damaged key file/);
  });

  it('detects a modified envelope (public key, ciphertext or parameters)', () => {
    const kp = generateSigningKeyPair();
    const envelope = encryptAdminKey(kp, STRONG);
    const swapped = { ...envelope, publicKey: generateSigningKeyPair().publicKey };
    expect(() => decryptAdminKey(swapped, STRONG)).toThrow(/wrong passphrase or damaged key file/);
    const weaker = { ...envelope, kdf: { ...envelope.kdf, iterations: 1 } };
    expect(() => decryptAdminKey(weaker, STRONG)).toThrow(/iterations/);
  });

  it('records the key derivation parameters and a format version', () => {
    const envelope = encryptAdminKey(generateSigningKeyPair(), STRONG);
    expect(envelope.v).toBe(1);
    expect(envelope.kdf).toMatchObject({ name: 'pbkdf2-sha256' });
    expect(envelope.kdf.iterations).toBeGreaterThanOrEqual(600_000);
    expect(envelope.cipher.name).toBe('aes-256-gcm');
  });

  it('refuses an unknown format version', () => {
    const envelope = encryptAdminKey(generateSigningKeyPair(), STRONG);
    expect(() => decryptAdminKey({ ...envelope, v: 2 } as never, STRONG)).toThrow(/version 2/);
  });

  it('uses a fresh salt and nonce each time', () => {
    const kp = generateSigningKeyPair();
    const a = encryptAdminKey(kp, STRONG);
    const b = encryptAdminKey(kp, STRONG);
    expect(a.kdf.salt).not.toBe(b.kdf.salt);
    expect(a.cipher.iv).not.toBe(b.cipher.iv);
  });
});

describe('passphrase strength (T-06, S-03)', () => {
  it('refuses short, repetitive or low-variety passphrases with the reason', () => {
    expect(checkPassphrase('short')).toMatchObject({ ok: false });
    expect(checkPassphrase('aaaaaaaaaaaaaaaaaaaaaaaa')).toMatchObject({ ok: false });
    expect(checkPassphrase('12345678901234567890')).toMatchObject({ ok: false });
  });

  it('accepts a long varied passphrase', () => {
    expect(checkPassphrase(STRONG)).toEqual({ ok: true });
  });

  it('generates at least 100 bits as grouped Crockford base32 that passes its own check', () => {
    const p = generatePassphrase();
    expect(p).toMatch(/^([0-9A-HJKMNP-TV-Z]{4}-){4}[0-9A-HJKMNP-TV-Z]{4}$/);
    expect(checkPassphrase(p)).toEqual({ ok: true });
    expect(generatePassphrase()).not.toBe(p);
  });
});
