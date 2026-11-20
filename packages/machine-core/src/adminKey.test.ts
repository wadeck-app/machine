import { createCipheriv, pbkdf2Sync, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { canonicalize } from './canonical.js';
import { adminKeyHint, checkHint, checkPassphrase, decryptAdminKey, encryptAdminKey, generatePassphrase, passphraseAdvice, PASSPHRASE_RECOMMENDED_LENGTH } from './adminKey.js';
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
    expect(() => decryptAdminKey({ ...envelope, v: 3 } as never, STRONG)).toThrow(/version 3/);
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

  it('decision 51: a chosen passphrase needs 12 characters, 6 distinct ones and not only digits', () => {
    expect(checkPassphrase('abcdef123456')).toEqual({ ok: true });
    expect(checkPassphrase('abcdef12345')).toMatchObject({ ok: false, message: expect.stringMatching(/at least 12 characters/) });
    expect(checkPassphrase('abcabcabcabc')).toMatchObject({ ok: false, message: expect.stringMatching(/at least 6 are required/) });
    expect(checkPassphrase('abcdefabcdef')).toEqual({ ok: true });
    expect(checkPassphrase('123456789012')).toMatchObject({ ok: false, message: expect.stringMatching(/digits only/) });
    // The failure of the length names the way out: choose a longer one, or let the tool generate one.
    expect(checkPassphrase('short')).toMatchObject({ message: expect.stringMatching(/--generate/) });
  });

  it('advises (never refuses) below the recommended length, and only then', () => {
    expect(PASSPHRASE_RECOMMENDED_LENGTH).toBe(20);
    expect(passphraseAdvice('abcdef123456')).toMatch(/12 characters.*steals.*longer/s);
    expect(passphraseAdvice('abcdefghijklmnopqrs')).toBeDefined();
    expect(passphraseAdvice('abcdefghijklmnopqrst')).toBeUndefined();
    expect(passphraseAdvice(generatePassphrase())).toBeUndefined();
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

describe('passphrase hint (decision 57)', () => {
  it('a file without a hint is unchanged: version 1, no hint field, read as undefined', () => {
    const envelope = encryptAdminKey(generateSigningKeyPair(), STRONG);
    expect(envelope.v).toBe(1);
    expect('hint' in envelope).toBe(false);
    expect(adminKeyHint(envelope)).toBeUndefined();
  });

  it('a hint is stored in clear in the header (version 2), read without the passphrase, and the key still unlocks', () => {
    const kp = generateSigningKeyPair();
    const envelope = encryptAdminKey(kp, STRONG, { hint: 'the street of my first school' });
    expect(envelope.v).toBe(2);
    expect(envelope.hint).toBe('the street of my first school');
    expect(adminKeyHint(envelope)).toBe('the street of my first school');
    expect(decryptAdminKey(envelope, STRONG).publicKey).toBe(kp.publicKey);
  });

  it('no hint option means no hint; a blank hint is refused, not dropped (finding: it used to be silently ignored)', () => {
    expect(encryptAdminKey(generateSigningKeyPair(), STRONG, {}).v).toBe(1);
    expect(() => encryptAdminKey(generateSigningKeyPair(), STRONG, { hint: '   ' })).toThrow(/only spaces/);
  });

  it('the hint is authenticated: swapping, removing or adding it breaks decryption', () => {
    const envelope = encryptAdminKey(generateSigningKeyPair(), STRONG, { hint: 'original hint' });
    expect(() => decryptAdminKey({ ...envelope, hint: 'swapped hint' }, STRONG)).toThrow(/wrong passphrase or damaged key file/);
    const { hint: _removed, ...without } = envelope;
    expect(() => decryptAdminKey({ ...without, v: 1 } as never, STRONG)).toThrow(/wrong passphrase or damaged key file/);
    const plain = encryptAdminKey(generateSigningKeyPair(), STRONG);
    expect(() => decryptAdminKey({ ...plain, hint: 'added hint' } as never, STRONG)).toThrow(/admin key file/);
  });

  it('refuses a hint that is too long, not printable ASCII, or that contains the passphrase (any case)', () => {
    expect(checkHint('x'.repeat(81), STRONG)).toMatchObject({ ok: false, message: expect.stringMatching(/at most 80/) });
    expect(checkHint(String.fromCharCode(99, 97, 102, 233), STRONG)).toMatchObject({ ok: false, message: expect.stringMatching(/printable ASCII/) });
    expect(checkHint('line' + String.fromCharCode(10) + 'break', STRONG)).toMatchObject({ ok: false, message: expect.stringMatching(/printable ASCII/) });
    expect(checkHint(`it is ${STRONG.toUpperCase()} indeed`, STRONG)).toMatchObject({ ok: false, message: expect.stringMatching(/contains the passphrase/) });
    // Only spaces (or nothing): refused with a message, never silently dropped by the trim at encryption.
    expect(checkHint('   ', STRONG)).toMatchObject({ ok: false, message: expect.stringMatching(/only spaces/) });
    expect(checkHint('')).toMatchObject({ ok: false, message: expect.stringMatching(/only spaces/) });
    expect(() => encryptAdminKey(generateSigningKeyPair(), STRONG, { hint: '   ' })).toThrow(/only spaces/);
    expect(() => adminKeyHint({ ...encryptAdminKey(generateSigningKeyPair(), STRONG, { hint: 'ok' }), hint: '   ' })).toThrow(/the hint is malformed/);
    expect(checkHint('x'.repeat(80), STRONG)).toEqual({ ok: true });
    expect(checkHint(STRONG)).toEqual({ ok: true });
    expect(() => encryptAdminKey(generateSigningKeyPair(), STRONG, { hint: STRONG })).toThrow(/contains the passphrase/);
  });

  it('a malformed hint in a file is reported by name, never shown', () => {
    const envelope = { ...encryptAdminKey(generateSigningKeyPair(), STRONG, { hint: 'ok' }), hint: 'bad' + String.fromCharCode(27) + '[31m' };
    expect(() => adminKeyHint(envelope)).toThrow(/admin key file: the hint is malformed/);
    expect(() => decryptAdminKey(envelope, STRONG)).toThrow(/admin key file: the hint is malformed/);
  });

  it('a version 1 file that carries a hint is refused (an old build would report a wrong passphrase)', () => {
    const envelope = encryptAdminKey(generateSigningKeyPair(), STRONG, { hint: 'ok' });
    expect(() => decryptAdminKey({ ...envelope, v: 1 } as never, STRONG)).toThrow(/admin key file: .*hint/);
  });
});

describe('the same envelope for another key (the local policy key)', () => {
  it('names the key in decryption errors and offers no admin-only advice when asked', async () => {
    const { generateSigningKeyPair } = await import('./keys.js');
    const envelope = encryptAdminKey(generateSigningKeyPair(), 'correct horse battery staple');
    expect(() => decryptAdminKey(envelope, 'not the passphrase at all', 'local policy key file')).toThrow(/^local policy key file: wrong passphrase or damaged key file/);
    expect(() => decryptAdminKey(envelope, 'not the passphrase at all')).toThrow(/^admin key file: wrong passphrase/);
    const short = checkPassphrase('short', 'type a longer one');
    expect(short.ok).toBe(false);
    expect((short as { message: string }).message).toMatch(/at least 12 characters \(20 or more is recommended\): type a longer one$/);
    expect((short as { message: string }).message).not.toMatch(/admin init/);
  });
});
