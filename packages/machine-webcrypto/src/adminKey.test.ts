import { encryptAdminKey, keyId as coreKeyId, signDocument, verifyDocument } from '@wadeck-app/machine-core';
import { describe, expect, it } from 'vitest';
import { STRONG, b64u, newPair } from '../test-support/kit.js';
import { signBody } from './signed.js';
import { unlockAdminKey } from './adminKey.js';

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
    expect(await run({ v: 2 })).toMatch(/unsupported format version 2/);
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
