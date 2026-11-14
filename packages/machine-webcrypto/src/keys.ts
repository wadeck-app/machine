import { decodeBase64urlStrict } from './base64url.js';

const subtle = (): SubtleCrypto => {
  const s = globalThis.crypto?.subtle;
  if (s === undefined) throw new Error('WebCrypto is not available here: use a secure context (https or localhost) in a current browser');
  return s;
};

export { subtle };

/** Wraps a Uint8Array for the WebCrypto typings (the bytes are not copied). */
export const buf = (data: Uint8Array): BufferSource => data as BufferSource;

export async function sha256(data: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await subtle().digest('SHA-256', buf(data)));
}

export const hex = (data: Uint8Array): string => Array.from(data, b => b.toString(16).padStart(2, '0')).join('');

export function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

export function rawPublicKeyBytes(publicKey: string): Uint8Array {
  return decodeBase64urlStrict(publicKey, 32, 'public key');
}

/** First 32 hex characters of the SHA-256 of the raw public key: same as machine-core keyId. */
export async function keyId(publicKey: string): Promise<string> {
  return hex(await sha256(rawPublicKeyBytes(publicKey))).slice(0, 32);
}

/** Like keyId, but returns undefined for a malformed key. */
export async function tryKeyId(publicKey: string): Promise<string | undefined> {
  try {
    return await keyId(publicKey);
  } catch {
    return undefined;
  }
}
