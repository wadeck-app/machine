import { decodeBase64urlStrict, encodeBase64url } from './base64url.js';
import { signingInput, type Json } from './canonical.js';
import { buf, rawPublicKeyBytes, subtle } from './keys.js';

// A WebCrypto key cannot be destroyed, so "locked" is a registry kept here: every signing path of this package checks it.
// A caller that kept a reference to the CryptoKey and calls crypto.subtle.sign itself is outside what this package can stop
// (residual risk of decision D25: other code of the same origin).
const locked = new WeakSet<CryptoKey>();

export function markLocked(key: CryptoKey): void {
  locked.add(key);
}

export function isKeyLocked(key: CryptoKey): boolean {
  return locked.has(key);
}

export function assertSigningKey(key: CryptoKey): void {
  if (locked.has(key)) throw new Error('the admin key is locked: unlock it again with the passphrase before signing');
  if (typeof key !== 'object' || key === null || key.type !== 'private' || !key.usages.includes('sign') || key.algorithm.name !== 'Ed25519') {
    throw new Error('the key is not an Ed25519 signing key: pass the privateKey returned by unlockAdminKey');
  }
}

/** Raw Ed25519 signature (64 bytes) over `data`. */
export async function signRaw(privateKey: CryptoKey, data: Uint8Array): Promise<Uint8Array> {
  assertSigningKey(privateKey);
  return new Uint8Array(await subtle().sign('Ed25519', privateKey, buf(data)));
}

export interface SignedBody<T> {
  body: T;
  signature: string;
}

/** Same bytes as machine-core signDocument: Ed25519 over domain, NUL, canonical body. Returns the body with its unpadded base64url signature. */
export async function signBody<T extends Json>(domain: string, body: T, privateKey: CryptoKey): Promise<SignedBody<T>> {
  const signature = await signRaw(privateKey, signingInput(domain, body));
  return { body, signature: encodeBase64url(signature) };
}

/** Never throws: a malformed key, body or signature is simply "not valid". `publicKey` is the raw 32 bytes, or their unpadded base64url. */
export async function verifyBody(domain: string, signed: SignedBody<Json>, publicKey: Uint8Array | string): Promise<boolean> {
  try {
    const raw = typeof publicKey === 'string' ? rawPublicKeyBytes(publicKey) : publicKey;
    if (raw.length !== 32) return false;
    const signature = decodeBase64urlStrict(signed.signature, 64, 'signature');
    const key = await subtle().importKey('raw', buf(raw), 'Ed25519', false, ['verify']);
    return await subtle().verify('Ed25519', key, buf(signature), buf(signingInput(domain, signed.body)));
  } catch {
    return false;
  }
}
