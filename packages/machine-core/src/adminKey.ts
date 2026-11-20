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
  /** 1 without a hint, 2 with one (decision 57: an older build reports "unsupported format version" instead of a misleading "wrong passphrase"). */
  v: 1 | 2;
  publicKey: string;
  /** Decision 57: optional passphrase hint, stored in CLEAR but authenticated (it is part of the AAD). Present only in version 2. */
  hint?: string;
  kdf: { name: 'pbkdf2-sha256'; iterations: number; salt: string };
  cipher: { name: 'aes-256-gcm'; iv: string };
  /** Ciphertext followed by the 16-byte authentication tag, unpadded base64url. */
  ciphertext: string;
}

export type PassphraseCheck = { ok: true } | { ok: false; message: string };

/** Decision 51: the floor of a passphrase CHOSEN by the user (the generated one has 20 characters, 100 bits). */
export const PASSPHRASE_MIN_LENGTH = 12;
/** Below this a passphrase is accepted with a warning (offline guessing risk if a machine holding the key file is stolen). */
export const PASSPHRASE_RECOMMENDED_LENGTH = 20;
const MIN_DISTINCT = 6;

/** Decision 57: the longest hint accepted. */
export const HINT_MAX_LENGTH = 80;

const charsOf = (passphrase: string): string[] => Array.from(passphrase.normalize('NFKC'));

/** `fix` is what follows "type a longer one": the admin key offers a generated one, another key (the local policy key) may not. */
export function checkPassphrase(passphrase: string, fix = 'type a longer one, or use `machine admin init --generate` for a random one (100 bits)'): PassphraseCheck {
  // Counted in characters (code points), not UTF-16 units.
  const chars = charsOf(passphrase);
  if (chars.length < PASSPHRASE_MIN_LENGTH) {
    return { ok: false, message: `the passphrase must be at least ${PASSPHRASE_MIN_LENGTH} characters (${PASSPHRASE_RECOMMENDED_LENGTH} or more is recommended): ${fix}` };
  }
  if (new Set(chars).size < MIN_DISTINCT) return { ok: false, message: `the passphrase uses too few different characters (at least ${MIN_DISTINCT} are required)` };
  if (/^[0-9\s-]+$/.test(chars.join(''))) return { ok: false, message: 'the passphrase must not be digits only' };
  return { ok: true };
}

/**
 * Decision 57: a hint is shown in clear at every unlock prompt on every machine, so it must stay short, printable ASCII (no
 * control character can reach a terminal) and must not give the passphrase away. Case-insensitive on the NFKC form.
 */
export function checkHint(hint: string, passphrase?: string): PassphraseCheck {
  // A hint of only spaces would be dropped by the trim at encryption: refused, never silently ignored.
  if (hint.trim().length === 0) return { ok: false, message: 'the hint is empty (only spaces): give a text that helps you remember the passphrase, or leave the hint out' };
  if (Array.from(hint).length > HINT_MAX_LENGTH) return { ok: false, message: `the hint must be at most ${HINT_MAX_LENGTH} characters` };
  if (!/^[ -~]*$/.test(hint)) return { ok: false, message: 'the hint must be printable ASCII (letters, digits, punctuation, spaces)' };
  // Without the passphrase (an early check of --hint) only the rules that do not depend on it are applied.
  if (passphrase !== undefined && hint.normalize('NFKC').toLowerCase().includes(passphrase.normalize('NFKC').toLowerCase())) {
    return { ok: false, message: 'the hint contains the passphrase itself: it is stored in clear and shown at every unlock, so it must only help you remember the passphrase, never reveal it' };
  }
  return { ok: true };
}

/**
 * The hint of a key file (undefined when there is none). It is not secret-bearing: read it without the passphrase. Throws when it is malformed.
 * It is shown BEFORE the passphrase is typed and authenticated only when the file is decrypted: a swapped hint is detected then (the unlock
 * fails), not before. It proves nothing.
 */
export function adminKeyHint(envelope: AdminKeyEnvelope): string | undefined {
  const hint = (envelope as { hint?: unknown }).hint;
  if (hint === undefined) return undefined;
  if (typeof hint !== 'string' || hint.length === 0 || Array.from(hint).length > HINT_MAX_LENGTH || !/^[ -~]+$/.test(hint) || hint.trim().length === 0) {
    throw new Error('admin key file: the hint is malformed (it must be 1 to 80 printable ASCII characters); restore the file from another machine');
  }
  return hint;
}

/** A warning (never a refusal) for a valid passphrase shorter than the recommended length; undefined when it is long enough. */
export function passphraseAdvice(passphrase: string): string | undefined {
  const length = charsOf(passphrase).length;
  if (length >= PASSPHRASE_RECOMMENDED_LENGTH) return undefined;
  return `this passphrase has ${length} characters, the minimum is ${PASSPHRASE_MIN_LENGTH} and ${PASSPHRASE_RECOMMENDED_LENGTH} or more is recommended: an encrypted copy of the admin key is on every machine, so anyone who steals one of them can try to guess it offline; a longer phrase is stronger`;
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

// The hint joins the authenticated header only when there is one: a file without a hint keeps the exact version 1 header.
function aad(envelope: Pick<AdminKeyEnvelope, 'v' | 'publicKey' | 'kdf' | 'cipher' | 'hint'>): Buffer {
  const head = { v: envelope.v, publicKey: envelope.publicKey, kdf: envelope.kdf, cipher: { name: envelope.cipher.name }, ...(envelope.hint !== undefined ? { hint: envelope.hint } : {}) };
  return Buffer.from(canonicalize(head as unknown as Json));
}

function deriveKey(passphrase: string, salt: Buffer, iterations: number): Buffer {
  return pbkdf2Sync(passphrase.normalize('NFKC'), salt, iterations, 32, 'sha256');
}

export function encryptAdminKey(keyPair: SigningKeyPair, passphrase: string, options: { iterations?: number; hint?: string } = {}): AdminKeyEnvelope {
  const check = checkPassphrase(passphrase);
  if (!check.ok) throw new Error(`admin key: ${check.message}`);
  // A hint of only spaces is refused by checkHint below, never silently dropped.
  const hint = options.hint === undefined ? undefined : options.hint.trim();
  if (hint !== undefined) {
    const hintCheck = checkHint(hint, passphrase);
    if (!hintCheck.ok) throw new Error(`admin key: ${hintCheck.message}`);
  }
  const iterations = options.iterations ?? DEFAULT_ITERATIONS;
  if (iterations < MIN_ITERATIONS) throw new Error(`admin key: iterations must be at least ${MIN_ITERATIONS}`);
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const head: Omit<AdminKeyEnvelope, 'ciphertext'> = {
    v: hint === undefined ? 1 : 2,
    publicKey: keyPair.publicKey,
    ...(hint !== undefined ? { hint } : {}),
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

/** `label` replaces "admin key file" in every error: the same envelope holds the local policy key (policy mode `local`). */
export function decryptAdminKey(envelope: AdminKeyEnvelope, passphrase: string, label = 'admin key file'): SigningKeyPair {
  try {
    return decryptEnvelope(envelope, passphrase);
  } catch (e) {
    const message = (e as Error).message;
    if (label === 'admin key file' || !message.startsWith('admin key file')) throw e;
    throw new Error(`${label}${message.slice('admin key file'.length)}`);
  }
}

function decryptEnvelope(envelope: AdminKeyEnvelope, passphrase: string): SigningKeyPair {
  const version = (envelope as { v: unknown }).v;
  if (version !== 1 && version !== 2) {
    throw new Error(`admin key file: unsupported format version ${String(version)} (this build reads versions 1 and 2); update machine`);
  }
  // Version 2 is the version with a hint: the two must agree, or the header would not be the one that was authenticated.
  const hint = adminKeyHint(envelope);
  if ((version === 2) !== (hint !== undefined)) {
    throw new Error(version === 2 ? 'admin key file: version 2 without a hint, the file is damaged; restore it from another machine' : 'admin key file: a version 1 file cannot carry a hint, the file is damaged; restore it from another machine');
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
