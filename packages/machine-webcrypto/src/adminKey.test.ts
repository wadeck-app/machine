import { decryptAdminKey, encryptAdminKey, keyId as coreKeyId, signDocument, verifyDocument } from '@wadeck-app/machine-core';
import { describe, expect, it } from 'vitest';
import { STRONG, b64u, newPair } from '../test-support/kit.js';
import { signBody } from './signed.js';
import { adminKeyHint, unlockAdminKey } from './adminKey.js';
import { canonicalize } from './canonical.js';

const MAX_ITERATIONS_PLUS_ONE = 20_000_001;
const OTHER = 'another passphrase that is long enough 1';

async function messageOfAsync(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
  } catch (e) {
    return (e as Error).message;
  }
  return '';
}

// Every unlock derives 600 000 PBKDF2 iterations: a few real ones, not one hundred (the machine is a working desktop).
describe('unlockAdminKey: a file written by machine-core adminKey', () => {
  it('unlocks, gives a non-extractable key, the raw public key and the key id, and signs documents machine-core verifies', async () => {
    const pair = newPair();
    const file = JSON.stringify(encryptAdminKey(pair, STRONG), null, 2);
    const unlocked = await unlockAdminKey(file, STRONG, { extractable: false });
    expect(unlocked.publicKey).toBe(pair.publicKey);
    expect(b64u(unlocked.publicKeyRaw)).toBe(pair.publicKey);
    expect(unlocked.keyId).toBe(coreKeyId(pair.publicKey));
    expect(unlocked.privateKey.extractable).toBe(false);
    expect(unlocked.privateKey.type).toBe('private');
    expect(unlocked.privateKey.algorithm.name).toBe('Ed25519');
    expect([...unlocked.privateKey.usages]).toEqual(['sign']);

    const signed = await signBody('machine/test/v1', { a: 1 }, unlocked.privateKey);
    expect(verifyDocument('machine/test/v1', { a: 1 }, pair.publicKey, signed.signature)).toBe(true);
    expect(signed.signature).toBe(signDocument('machine/test/v1', { a: 1 }, pair.privateKeyPkcs8));
  });

  it('decision 51: a chosen passphrase of the minimum length (12 characters) written by machine-core is opened here, and the unlock imposes no length rule of its own', async () => {
    const pair = newPair();
    const minimum = 'abcdef123456';
    const unlocked = await unlockAdminKey(JSON.stringify(encryptAdminKey(pair, minimum)), minimum, { extractable: false });
    expect(unlocked.publicKey).toBe(pair.publicKey);
  });

  it('the unlocked key cannot be exported in any format', async () => {
    const file = JSON.stringify(encryptAdminKey(newPair(), STRONG));
    const unlocked = await unlockAdminKey(file, STRONG, { extractable: false });
    for (const format of ['pkcs8', 'raw', 'jwk'] as const) {
      await expect(crypto.subtle.exportKey(format, unlocked.privateKey), format).rejects.toThrow();
    }
  });

  it('lock() makes every later signing throw an actionable error, and is idempotent', async () => {
    const pair = newPair();
    const unlocked = await unlockAdminKey(JSON.stringify(encryptAdminKey(pair, STRONG)), STRONG, { extractable: false });
    await signBody('machine/test/v1', { a: 1 }, unlocked.privateKey);
    expect(unlocked.isLocked()).toBe(false);
    unlocked.lock();
    unlocked.lock();
    expect(unlocked.isLocked()).toBe(true);
    await expect(signBody('machine/test/v1', { a: 1 }, unlocked.privateKey)).rejects.toThrow(/locked.*unlock/i);
  });

  it('a wrong passphrase gives the same message as machine-core and does not leak the passphrase or anything about the key', async () => {
    const pair = newPair();
    const file = JSON.stringify(encryptAdminKey(pair, STRONG));
    const message = await messageOfAsync(() => unlockAdminKey(file, OTHER, { extractable: false }));
    expect(message).toBe('admin key file: wrong passphrase or damaged key file');
    expect(message).not.toContain(OTHER);
    expect(message).not.toContain(pair.publicKey);
  });

  it('a tampered header is refused with the same message (the header is authenticated)', async () => {
    const pair = newPair();
    const envelope = encryptAdminKey(pair, STRONG);
    const swapped = JSON.stringify({ ...envelope, publicKey: newPair().publicKey });
    expect(await messageOfAsync(() => unlockAdminKey(swapped, STRONG, { extractable: false }))).toBe('admin key file: wrong passphrase or damaged key file');
    const flipped = Buffer.from(envelope.ciphertext, 'base64url');
    flipped[3] = (flipped[3] as number) ^ 1;
    const damaged = JSON.stringify({ ...envelope, ciphertext: flipped.toString('base64url') });
    expect(await messageOfAsync(() => unlockAdminKey(damaged, STRONG, { extractable: false }))).toBe('admin key file: wrong passphrase or damaged key file');
  });
});

describe('unlockAdminKey: validation before any key derivation (same rules and messages as adminKey.ts)', () => {
  const envelope = encryptAdminKey(newPair(), STRONG);
  const run = (patch: object) => messageOfAsync(() => unlockAdminKey(JSON.stringify({ ...envelope, ...patch }), STRONG, { extractable: false }));

  it('refuses a weakened, an absurd and a non-integer iteration count', async () => {
    expect(await run({ kdf: { ...envelope.kdf, iterations: 1 } })).toMatch(/below the minimum 600000/);
    expect(await run({ kdf: { ...envelope.kdf, iterations: 20_000_001 } })).toMatch(/above the maximum/);
    expect(await run({ kdf: { ...envelope.kdf, iterations: 600_000.5 } })).toMatch(/iterations/);
  });

  it('refuses an unknown version, kdf, cipher, a malformed salt, iv or ciphertext', async () => {
    expect(await run({ v: 3 })).toMatch(/unsupported format version 3/);
    expect(await run({ kdf: { ...envelope.kdf, name: 'argon2id' } })).toMatch(/unknown kdf or cipher/);
    expect(await run({ cipher: { ...envelope.cipher, name: 'chacha' } })).toMatch(/unknown kdf or cipher/);
    expect(await run({ kdf: { ...envelope.kdf, salt: 'AAAA' } })).toMatch(/kdf salt is missing or malformed/);
    expect(await run({ cipher: { ...envelope.cipher, iv: 'AAAA' } })).toMatch(/cipher iv is missing or malformed/);
    expect(await run({ ciphertext: 7 })).toMatch(/ciphertext is missing or malformed/);
    expect(await run({ ciphertext: 'AAAA' })).toMatch(/wrong passphrase or damaged key file/);
    expect(await run({ publicKey: 'AAAA' })).toMatch(/public key/);
  });

  it('refuses text that is not JSON or not an object, with the fix', async () => {
    expect(await messageOfAsync(() => unlockAdminKey('{nope', STRONG, { extractable: false }))).toMatch(/not valid JSON.*copy it again/);
    expect(await messageOfAsync(() => unlockAdminKey('[1]', STRONG, { extractable: false }))).toMatch(/not an admin key file/);
    expect(await messageOfAsync(() => unlockAdminKey('null', STRONG, { extractable: false }))).toMatch(/not an admin key file/);
  });

  it('refuses a request for an extractable key, and a non-string passphrase', async () => {
    const text = JSON.stringify(envelope);
    expect(await messageOfAsync(() => unlockAdminKey(text, STRONG, { extractable: true as never }))).toMatch(/non-extractable/);
    expect(await messageOfAsync(() => unlockAdminKey(text, 5 as never, { extractable: false }))).toMatch(/passphrase must be a string/);
  });
});

describe('passphrase hint (decision 57): the two implementations agree on the authenticated header', () => {
  it('a file made by machine-core WITH a hint is opened here, and the hint is readable without the passphrase', async () => {
    const pair = newPair();
    const file = JSON.stringify(encryptAdminKey(pair, STRONG, { hint: 'the street of my first school' }));
    expect(adminKeyHint(file)).toBe('the street of my first school');
    const unlocked = await unlockAdminKey(file, STRONG, { extractable: false });
    expect(unlocked.publicKey).toBe(pair.publicKey);
  });

  it('a file made by machine-core WITHOUT a hint has no hint here and still opens', async () => {
    const file = JSON.stringify(encryptAdminKey(newPair(), STRONG));
    expect(adminKeyHint(file)).toBeUndefined();
    await unlockAdminKey(file, STRONG, { extractable: false });
  });

  it('a swapped, removed or added hint is refused here too', async () => {
    const withHint = encryptAdminKey(newPair(), STRONG, { hint: 'original hint' });
    expect(await messageOfAsync(() => unlockAdminKey(JSON.stringify({ ...withHint, hint: 'swapped hint' }), STRONG, { extractable: false }))).toMatch(/wrong passphrase or damaged key file/);
    const { hint: _removed, ...removed } = withHint;
    expect(await messageOfAsync(() => unlockAdminKey(JSON.stringify({ ...removed, v: 1 }), STRONG, { extractable: false }))).toMatch(/wrong passphrase or damaged key file/);
    expect(await messageOfAsync(() => unlockAdminKey(JSON.stringify({ ...withHint, v: 1 }), STRONG, { extractable: false }))).toMatch(/version 1 file cannot carry a hint/);
    expect(await messageOfAsync(() => unlockAdminKey(JSON.stringify({ ...removed, v: 2 }), STRONG, { extractable: false }))).toMatch(/version 2 without a hint/);
  });

  it('a malformed hint is refused by name', async () => {
    const withHint = encryptAdminKey(newPair(), STRONG, { hint: 'ok' });
    const bad = JSON.stringify({ ...withHint, hint: 'bad' + String.fromCharCode(27) });
    expect(() => adminKeyHint(bad)).toThrow(/the hint is malformed/);
    expect(await messageOfAsync(() => unlockAdminKey(bad, STRONG, { extractable: false }))).toMatch(/the hint is malformed/);
  });

  it('a file written with WebCrypto only (header with a hint, built here) is opened by machine-core', async () => {
    const pair = newPair();
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const kdf = { name: 'pbkdf2-sha256', iterations: 600_000, salt: b64u(salt) };
    const head = { v: 2, publicKey: pair.publicKey, hint: 'written by the page twin', kdf, cipher: { name: 'aes-256-gcm', iv: b64u(iv) } };
    const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(STRONG), 'PBKDF2', false, ['deriveKey']);
    const aes = await crypto.subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt: salt as BufferSource, iterations: 600_000 }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt']);
    const aad = new TextEncoder().encode(canonicalize({ v: 2, publicKey: head.publicKey, kdf, cipher: { name: 'aes-256-gcm' }, hint: head.hint }));
    const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv as BufferSource, additionalData: aad as BufferSource, tagLength: 128 }, aes, pair.privateKeyPkcs8 as BufferSource));
    const envelope = { ...head, ciphertext: b64u(sealed) };
    expect(decryptAdminKey(envelope as never, STRONG).publicKey).toBe(pair.publicKey);
    expect((await unlockAdminKey(JSON.stringify(envelope), STRONG, { extractable: false })).publicKey).toBe(pair.publicKey);
  });
});
