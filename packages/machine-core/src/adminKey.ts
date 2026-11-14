import { createCipheriv, createDecipheriv, createPrivateKey, createPublicKey, pbkdf2Sync, randomBytes, randomInt } from 'node:crypto';
import { canonicalize, type Json } from './canonical.js';
import { decodeBase64urlStrict, type SigningKeyPair } from './keys.js';

// The admin private key at rest: PBKDF2-HMAC-SHA256 then AES-256-GCM. PBKDF2 is the one memory-hard-free KDF that
// WebCrypto offers, and the browser page cannot load WebAssembly under app-core's CSP (evidence.md), so the same file
// opens in Node and in the page. The parameters are in the file; a stronger KDF is a new format version.

export const MIN_ITERATIONS = 600_000;
/** Upper bound read from a file: a hostile or damaged file must not make the process compute for hours. */
export const MAX_ITERATIONS = 20_000_000;
const DEFAULT_ITERATIONS = 600_000;
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

export interface AdminKeyEnvelope {
  v: 1;
  publicKey: string;
  kdf: { name: 'pbkdf2-sha256'; iterations: number; salt: string };
  cipher: { name: 'aes-256-gcm'; iv: string };
  /** Ciphertext followed by the 16-byte authentication tag, unpadded base64url. */
  ciphertext: string;
}

export type PassphraseCheck = { ok: true } | { ok: false; message: string };

export function checkPassphrase(passphrase: string): PassphraseCheck {
  // Counted in characters (code points), not UTF-16 units.
  const chars = Array.from(passphrase.normalize('NFKC'));
  if (chars.length < 20) return { ok: false, message: 'the passphrase must be at least 20 characters; use `machine admin init` to generate one (100 bits)' };
  if (new Set(chars).size < 8) return { ok: false, message: 'the passphrase uses too few different characters (at least 8 are required)' };
  if (/^[0-9\s-]+$/.test(chars.join(''))) return { ok: false, message: 'the passphrase must not be digits only' };
  return { ok: true };
}

/** 20 Crockford base32 characters (100 bits) in five groups of four. */
export function generatePassphrase(): string {
  for (let attempt = 0; attempt < 1000; attempt++) {
    let out = '';
    for (let i = 0; i < 20; i++) out += ALPHABET[randomInt(32)];
    const candidate = `${out.slice(0, 4)}-${out.slice(4, 8)}-${out.slice(8, 12)}-${out.slice(12, 16)}-${out.slice(16, 20)}`;
    if (checkPassphrase(candidate).ok) return candidate;
  }
  throw new Error('admin key: could not generate a passphrase that passes the strength check; the rules in checkPassphrase are inconsistent with the generator');
}

function aad(envelope: Pick<AdminKeyEnvelope, 'v' | 'publicKey' | 'kdf' | 'cipher'>): Buffer {
  return Buffer.from(canonicalize({ v: envelope.v, publicKey: envelope.publicKey, kdf: envelope.kdf, cipher: { name: envelope.cipher.name } } as unknown as Json));
}

function deriveKey(passphrase: string, salt: Buffer, iterations: number): Buffer {
  return pbkdf2Sync(passphrase.normalize('NFKC'), salt, iterations, 32, 'sha256');
}

export function encryptAdminKey(keyPair: SigningKeyPair, passphrase: string, options: { iterations?: number } = {}): AdminKeyEnvelope {
  const check = checkPassphrase(passphrase);
  if (!check.ok) throw new Error(`admin key: ${check.message}`);
  const iterations = options.iterations ?? DEFAULT_ITERATIONS;
  if (iterations < MIN_ITERATIONS) throw new Error(`admin key: iterations must be at least ${MIN_ITERATIONS}`);
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const head = {
    v: 1 as const,
    publicKey: keyPair.publicKey,
    kdf: { name: 'pbkdf2-sha256' as const, iterations, salt: salt.toString('base64url') },
    cipher: { name: 'aes-256-gcm' as const, iv: iv.toString('base64url') },
  };
  const cipher = createCipheriv('aes-256-gcm', deriveKey(passphrase, salt, iterations), iv);
  cipher.setAAD(aad(head));
  const encrypted = Buffer.concat([cipher.update(Buffer.from(keyPair.privateKeyPkcs8)), cipher.final(), cipher.getAuthTag()]);
  return { ...head, ciphertext: encrypted.toString('base64url') };
}

const WRONG_OR_DAMAGED = 'admin key file: wrong passphrase or damaged key file';

function field<T>(read: () => T, name: string): T {
  try {
    return read();
  } catch (e) {
    throw new Error(`admin key file: ${name} is missing or malformed (${(e as Error).message}); restore the file from another machine`);
  }
}

export function decryptAdminKey(envelope: AdminKeyEnvelope, passphrase: string): SigningKeyPair {
  if ((envelope as { v: number }).v !== 1) {
    throw new Error(`admin key file: unsupported format version ${String((envelope as { v: unknown }).v)} (this build reads version 1); update machine`);
  }
  if (envelope.kdf?.name !== 'pbkdf2-sha256' || envelope.cipher?.name !== 'aes-256-gcm') throw new Error('admin key file: unknown kdf or cipher; update machine');
  const { iterations } = envelope.kdf;
  if (!Number.isSafeInteger(iterations) || iterations < MIN_ITERATIONS) {
    throw new Error(`admin key file: kdf iterations ${String(iterations)} are below the minimum ${MIN_ITERATIONS}; the file was weakened or damaged`);
  }
  if (iterations > MAX_ITERATIONS) {
    throw new Error(`admin key file: kdf iterations ${iterations} are above the maximum ${MAX_ITERATIONS}; refusing to compute them, the file is damaged or hostile`);
  }
  // Every field is checked before any key derivation starts.
  const salt = field(() => decodeBase64urlStrict(envelope.kdf.salt, 16, 'kdf salt'), 'kdf salt');
  const iv = field(() => decodeBase64urlStrict(envelope.cipher.iv, 12, 'cipher iv'), 'cipher iv');
  if (typeof envelope.ciphertext !== 'string') throw new Error('admin key file: ciphertext is missing or malformed; restore the file from another machine');
  const raw = Buffer.from(envelope.ciphertext, 'base64url');
  if (raw.length < 17) throw new Error(WRONG_OR_DAMAGED);
  const decipher = createDecipheriv('aes-256-gcm', deriveKey(passphrase, salt, iterations), iv);
  decipher.setAAD(aad(envelope));
  decipher.setAuthTag(raw.subarray(raw.length - 16));
  let plain: Buffer | undefined;
  try {
    plain = Buffer.concat([decipher.update(raw.subarray(0, raw.length - 16)), decipher.final()]);
    const publicKey = createPublicKey(createPrivateKey({ key: plain, format: 'der', type: 'pkcs8' })).export({ format: 'jwk' }).x;
    if (publicKey !== envelope.publicKey) throw new Error('public key mismatch');
    return { publicKey: envelope.publicKey, privateKeyPkcs8: new Uint8Array(plain) };
  } catch {
    throw new Error(WRONG_OR_DAMAGED);
  } finally {
    plain?.fill(0);
  }
}
