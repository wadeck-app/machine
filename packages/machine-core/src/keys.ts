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

function rawPublicKeyBytes(publicKey: string): Buffer {
  const bytes = Buffer.from(publicKey, 'base64url');
  if (bytes.length !== 32 || bytes.toString('base64url') !== publicKey) {
    throw new Error(`public key must be 32 bytes as unpadded base64url (got ${bytes.length} bytes)`);
  }
  return bytes;
}

export function keyId(publicKey: string): string {
  return createHash('sha256').update(rawPublicKeyBytes(publicKey)).digest('hex').slice(0, 32);
}

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
