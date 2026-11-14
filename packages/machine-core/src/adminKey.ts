import { createCipheriv, createDecipheriv, createPrivateKey, createPublicKey, pbkdf2Sync, randomBytes, randomInt } from 'node:crypto';
import { canonicalize, type Json } from './canonical.js';
import type { SigningKeyPair } from './keys.js';

// The admin private key at rest: PBKDF2-HMAC-SHA256 then AES-256-GCM. PBKDF2 is the one memory-hard-free KDF that
// WebCrypto offers, and the browser page cannot load WebAssembly under app-core's CSP (evidence.md), so the same file
// opens in Node and in the page. The parameters are in the file; a stronger KDF is a new format version.

export const MIN_ITERATIONS = 600_000;
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
  const p = passphrase.normalize('NFKC');
  if (p.length < 20) return { ok: false, message: 'the passphrase must be at least 20 characters; use `machine admin init` to generate one (100 bits)' };
  if (new Set(p).size < 8) return { ok: false, message: 'the passphrase uses too few different characters (at least 8 are required)' };
  if (/^[0-9\s-]+$/.test(p)) return { ok: false, message: 'the passphrase must not be digits only' };
  return { ok: true };
}

/** 20 Crockford base32 characters (100 bits) in five groups of four. */
export function generatePassphrase(): string {
  for (;;) {
    let out = '';
    for (let i = 0; i < 20; i++) out += ALPHABET[randomInt(32)];
    const candidate = `${out.slice(0, 4)}-${out.slice(4, 8)}-${out.slice(8, 12)}-${out.slice(12, 16)}-${out.slice(16, 20)}`;
    if (checkPassphrase(candidate).ok) return candidate;
  }
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

export function decryptAdminKey(envelope: AdminKeyEnvelope, passphrase: string): SigningKeyPair {
  if ((envelope as { v: number }).v !== 1) {
    throw new Error(`admin key file: unsupported format version ${String((envelope as { v: unknown }).v)} (this build reads version 1); update machine`);
  }
  if (envelope.kdf.name !== 'pbkdf2-sha256' || envelope.cipher.name !== 'aes-256-gcm') throw new Error('admin key file: unknown kdf or cipher; update machine');
  if (!Number.isSafeInteger(envelope.kdf.iterations) || envelope.kdf.iterations < MIN_ITERATIONS) {
    throw new Error(`admin key file: kdf iterations ${String(envelope.kdf.iterations)} are below the minimum ${MIN_ITERATIONS}; the file was weakened or damaged`);
  }
  const raw = Buffer.from(envelope.ciphertext, 'base64url');
  if (raw.length < 17) throw new Error('admin key file: wrong passphrase or damaged key file');
  const decipher = createDecipheriv('aes-256-gcm', deriveKey(passphrase, Buffer.from(envelope.kdf.salt, 'base64url'), envelope.kdf.iterations), Buffer.from(envelope.cipher.iv, 'base64url'));
  decipher.setAAD(aad(envelope));
  decipher.setAuthTag(raw.subarray(raw.length - 16));
  let plain: Buffer;
  try {
    plain = Buffer.concat([decipher.update(raw.subarray(0, raw.length - 16)), decipher.final()]);
  } catch {
    throw new Error('admin key file: wrong passphrase or damaged key file');
  }
  const publicKey = createPublicKey(createPrivateKey({ key: plain, format: 'der', type: 'pkcs8' })).export({ format: 'jwk' }).x;
  if (publicKey !== envelope.publicKey) throw new Error('admin key file: wrong passphrase or damaged key file');
  return { publicKey: envelope.publicKey, privateKeyPkcs8: new Uint8Array(plain) };
}
