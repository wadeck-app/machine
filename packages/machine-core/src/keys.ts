import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from 'node:crypto';

// Ed25519 only. Public keys are the raw 32 bytes as unpadded base64url; private keys are PKCS8 DER bytes
// (what the encrypted key file stores). Nothing here touches the file system.

export interface SigningKeyPair {
  /** Raw 32-byte public key, unpadded base64url. */
  publicKey: string;
  /** PKCS8 DER of the private key. Secret: never log, never send. */
  privateKeyPkcs8: Uint8Array;
}

const SPKI_ED25519_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

export function generateSigningKeyPair(): SigningKeyPair {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const jwk = publicKey.export({ format: 'jwk' });
  if (typeof jwk.x !== 'string') throw new Error('generateSigningKeyPair: the runtime returned no raw public key');
  return { publicKey: jwk.x, privateKeyPkcs8: new Uint8Array(privateKey.export({ format: 'der', type: 'pkcs8' })) };
}

/** Decodes unpadded base64url and refuses any other spelling of the same bytes (padding, stray characters, non-zero trailing bits). */
export function decodeBase64urlStrict(text: unknown, expectedBytes: number, label: string): Buffer {
  if (typeof text !== 'string') throw new Error(`${label} must be ${expectedBytes} bytes as unpadded base64url (got a ${typeof text})`);
  const bytes = Buffer.from(text, 'base64url');
  if (bytes.length !== expectedBytes) throw new Error(`${label} must be ${expectedBytes} bytes as unpadded base64url (got ${bytes.length} bytes)`);
  if (bytes.toString('base64url') !== text) throw new Error(`${label} must be ${expectedBytes} bytes as unpadded base64url; this string is not the canonical encoding`);
  return bytes;
}

function rawPublicKeyBytes(publicKey: string): Buffer {
  return decodeBase64urlStrict(publicKey, 32, 'public key');
}

export function keyId(publicKey: string): string {
  return createHash('sha256').update(rawPublicKeyBytes(publicKey)).digest('hex').slice(0, 32);
}

/** Like keyId, but returns undefined for a malformed key so that verifiers can answer with a result instead of throwing. */
export function tryKeyId(publicKey: string): string | undefined {
  try {
    return keyId(publicKey);
  } catch {
    return undefined;
  }
}

export const INVALID_ADMIN_KEY_MESSAGE =
  'the pinned admin public key of this machine is invalid (the local configuration is damaged); re-enroll this machine or restore the key from another machine';

export function signBytes(privateKeyPkcs8: Uint8Array, data: Uint8Array): string {
  const key = createPrivateKey({ key: Buffer.from(privateKeyPkcs8), format: 'der', type: 'pkcs8' });
  return sign(null, data, key).toString('base64url');
}

// Never throws: a malformed key or signature is simply "not valid".
export function verifyBytes(publicKey: string, data: Uint8Array, signature: string): boolean {
  try {
    const raw = rawPublicKeyBytes(publicKey);
    const key = createPublicKey({ key: Buffer.concat([SPKI_ED25519_PREFIX, raw]), format: 'der', type: 'spki' });
    const sig = Buffer.from(signature, 'base64url');
    if (sig.length !== 64) return false;
    return verify(null, data, key, sig);
  } catch {
    return false;
  }
}
