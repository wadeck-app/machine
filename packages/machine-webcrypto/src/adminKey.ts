import { decodeBase64urlAny, decodeBase64urlStrict } from './base64url.js';
import { canonicalize } from './canonical.js';
import { buf, keyId, subtle } from './keys.js';
import { isKeyLocked, markLocked } from './signed.js';

// Opens the admin key file written by machine-core adminKey.ts (PBKDF2-HMAC-SHA256 then AES-256-GCM, header authenticated)
// and keeps the Ed25519 private key as a NON-EXTRACTABLE CryptoKey: the raw key never exists in page memory after the import.
// The decrypted PKCS8 bytes and the passphrase bytes this module owns are zeroed as soon as the import is done. The passphrase
// string itself is the caller's (JavaScript strings cannot be wiped): drop the reference as soon as unlock returns.

export const MIN_ITERATIONS = 600_000;
/** Upper bound read from a file: a hostile or damaged file must not make the page compute for hours. */
export const MAX_ITERATIONS = 20_000_000;

const WRONG_OR_DAMAGED = 'admin key file: wrong passphrase or damaged key file';
const PKCS8_ED25519_PREFIX = Uint8Array.from([0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20]);

export interface UnlockedAdminKey {
  /** Non-extractable Ed25519 signing key. After lock(), every signing function of this package refuses it. */
  privateKey: CryptoKey;
  /** Raw 32-byte public key. */
  publicKeyRaw: Uint8Array;
  /** The same key as unpadded base64url (what registrations and pins carry). */
  publicKey: string;
  /** 32 hex characters, same as machine-core keyId. */
  keyId: string;
  lock(): void;
  isLocked(): boolean;
}

function field<T>(read: () => T, name: string): T {
  try {
    return read();
  } catch (e) {
    throw new Error(`admin key file: ${name} is missing or malformed (${(e as Error).message}); restore the file from another machine`);
  }
}

function parseEnvelope(fileContent: string): Record<string, any> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fileContent);
  } catch {
    throw new Error('the admin key file is corrupt or invalid (not valid JSON): copy it again from another machine');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('the admin key file is corrupt or invalid (not an admin key file): copy it again from another machine');
  }
  return parsed as Record<string, any>;
}

/** Decision 57, same rules as machine-core: 1 to 80 printable ASCII characters. Throws on a malformed one. */
function readHint(envelope: Record<string, any>): string | undefined {
  const hint: unknown = envelope.hint;
  if (hint === undefined) return undefined;
  if (typeof hint !== 'string' || hint.length === 0 || Array.from(hint).length > 80 || !/^[\x20-\x7e]+$/.test(hint) || hint.trim().length === 0) {
    throw new Error('admin key file: the hint is malformed (it must be 1 to 80 printable ASCII characters); restore the file from another machine');
  }
  return hint;
}

/**
 * The hint of a key file, readable without the passphrase (it is stored in clear). It is shown BEFORE authentication: a swapped hint is
 * detected only when the file is decrypted (the unlock fails), not before.
 */
export function adminKeyHint(fileContent: string): string | undefined {
  return readHint(parseEnvelope(fileContent));
}

export async function unlockAdminKey(fileContent: string, passphrase: string, options: { extractable: false }): Promise<UnlockedAdminKey> {
  if (options?.extractable !== false) {
    throw new Error('unlockAdminKey: the unlocked key is always non-extractable; call it with { extractable: false } (the page never holds the raw key)');
  }
  if (typeof passphrase !== 'string') throw new Error('unlockAdminKey: the passphrase must be a string');
  if (typeof fileContent !== 'string') throw new Error('unlockAdminKey: the file content must be the text of the admin key file');
  const envelope = parseEnvelope(fileContent);

  if (envelope.v !== 1 && envelope.v !== 2) {
    throw new Error(`admin key file: unsupported format version ${String(envelope.v)} (this build reads versions 1 and 2); update machine`);
  }
  // Version 2 is the version with a hint: the two must agree, or the header would not be the one that was authenticated.
  const hint = readHint(envelope);
  if ((envelope.v === 2) !== (hint !== undefined)) {
    throw new Error(envelope.v === 2 ? 'admin key file: version 2 without a hint, the file is damaged; restore it from another machine' : 'admin key file: a version 1 file cannot carry a hint, the file is damaged; restore it from another machine');
  }
  if (envelope.kdf?.name !== 'pbkdf2-sha256' || envelope.cipher?.name !== 'aes-256-gcm') throw new Error('admin key file: unknown kdf or cipher; update machine');
  const iterations: unknown = envelope.kdf.iterations;
  if (typeof iterations !== 'number' || !Number.isSafeInteger(iterations) || iterations < MIN_ITERATIONS) {
    throw new Error(`admin key file: kdf iterations ${String(iterations)} are below the minimum ${MIN_ITERATIONS}; the file was weakened or damaged`);
  }
  if (iterations > MAX_ITERATIONS) {
    throw new Error(`admin key file: kdf iterations ${iterations} are above the maximum ${MAX_ITERATIONS}; refusing to compute them, the file is damaged or hostile`);
  }
  // Every field is checked before any key derivation starts.
  const salt = field(() => decodeBase64urlStrict(envelope.kdf.salt, 16, 'kdf salt'), 'kdf salt');
  const iv = field(() => decodeBase64urlStrict(envelope.cipher.iv, 12, 'cipher iv'), 'cipher iv');
  const publicKeyRaw = field(() => decodeBase64urlStrict(envelope.publicKey, 32, 'public key'), 'public key');
  if (typeof envelope.ciphertext !== 'string') throw new Error('admin key file: ciphertext is missing or malformed; restore the file from another machine');
  let sealed: Uint8Array;
  try {
    sealed = decodeBase64urlAny(envelope.ciphertext, 'ciphertext');
  } catch {
    throw new Error('admin key file: ciphertext is missing or malformed; restore the file from another machine');
  }
  if (sealed.length < 17) throw new Error(WRONG_OR_DAMAGED);

  const aad = new TextEncoder().encode(canonicalize({ v: envelope.v, publicKey: envelope.publicKey, kdf: envelope.kdf, cipher: { name: envelope.cipher.name }, ...(hint !== undefined ? { hint } : {}) }));

  const passphraseBytes = new TextEncoder().encode(passphrase.normalize('NFKC'));
  let plain: Uint8Array | undefined;
  try {
    const base = await subtle().importKey('raw', buf(passphraseBytes), 'PBKDF2', false, ['deriveKey']);
    // The AES key is derived as a non-extractable CryptoKey: its bytes never enter JavaScript.
    const aes = await subtle().deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt: buf(salt), iterations }, base, { name: 'AES-GCM', length: 256 }, false, ['decrypt']);
    plain = new Uint8Array(await subtle().decrypt({ name: 'AES-GCM', iv: buf(iv), additionalData: buf(aad), tagLength: 128 }, aes, buf(sealed)));
    if (plain.length !== PKCS8_ED25519_PREFIX.length + 32 || !PKCS8_ED25519_PREFIX.every((b, i) => plain?.[i] === b)) throw new Error('not an Ed25519 PKCS8 key');
    const privateKey = await subtle().importKey('pkcs8', buf(plain), 'Ed25519', false, ['sign']);
    // WebCrypto cannot derive the public key of a non-extractable private key: prove that the header's public key belongs to it.
    const challenge = new TextEncoder().encode('machine/unlock-check/v1');
    const proof = await subtle().sign('Ed25519', privateKey, buf(challenge));
    const publicKey = await subtle().importKey('raw', buf(publicKeyRaw), 'Ed25519', false, ['verify']);
    if (!(await subtle().verify('Ed25519', publicKey, proof, buf(challenge)))) throw new Error('public key mismatch');
    return {
      privateKey,
      publicKeyRaw,
      publicKey: envelope.publicKey as string,
      keyId: await keyId(envelope.publicKey as string),
      lock: () => markLocked(privateKey),
      isLocked: () => isKeyLocked(privateKey),
    };
  } catch {
    throw new Error(WRONG_OR_DAMAGED);
  } finally {
    plain?.fill(0);
    passphraseBytes.fill(0);
  }
}
