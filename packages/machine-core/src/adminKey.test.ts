import { createCipheriv, pbkdf2Sync, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { canonicalize } from './canonical.js';
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

describe('admin key file hardening (review findings)', () => {
  it('refuses absurd iteration counts before computing anything', () => {
    const envelope = encryptAdminKey(generateSigningKeyPair(), STRONG);
    const started = Date.now();
    expect(() => decryptAdminKey({ ...envelope, kdf: { ...envelope.kdf, iterations: 9e15 } }, STRONG)).toThrow(/iterations.*above the maximum/);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('names the file and the field when a field is missing or has the wrong size', () => {
    const envelope = encryptAdminKey(generateSigningKeyPair(), STRONG);
    expect(() => decryptAdminKey({ ...envelope, kdf: { ...envelope.kdf, salt: undefined as never } }, STRONG)).toThrow(/admin key file:.*salt/);
    expect(() => decryptAdminKey({ ...envelope, cipher: { ...envelope.cipher, iv: 'AAAA' } }, STRONG)).toThrow(/admin key file:.*iv/);
    expect(() => decryptAdminKey({ ...envelope, ciphertext: 7 as never }, STRONG)).toThrow(/admin key file:.*ciphertext/);
  });

  it('reports a decrypted payload that is not an Ed25519 key as a damaged file', () => {
    const good = encryptAdminKey(generateSigningKeyPair(), STRONG);
    const iv = randomBytes(12);
    const head = { v: 1 as const, publicKey: good.publicKey, kdf: good.kdf, cipher: { name: 'aes-256-gcm' as const, iv: iv.toString('base64url') } };
    const aad = Buffer.from(canonicalize({ v: 1, publicKey: head.publicKey, kdf: head.kdf, cipher: { name: 'aes-256-gcm' } }));
    const cipher = createCipheriv('aes-256-gcm', pbkdf2Sync(STRONG, Buffer.from(good.kdf.salt, 'base64url'), good.kdf.iterations, 32, 'sha256'), iv);
    cipher.setAAD(aad);
    const ciphertext = Buffer.concat([cipher.update(Buffer.from('not a key')), cipher.final(), cipher.getAuthTag()]);
    expect(() => decryptAdminKey({ ...head, ciphertext: ciphertext.toString('base64url') }, STRONG)).toThrow(/admin key file: wrong passphrase or damaged key file/);
  });
});

describe('passphrase strength (T-06, S-03)', () => {
  it('counts characters, not UTF-16 units (ten emoji are ten characters)', () => {
    expect(checkPassphrase('😀😁😂🤣😃😄😅😆😉😊')).toMatchObject({ ok: false });
  });

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
