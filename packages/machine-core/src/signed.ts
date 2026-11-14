import { signingInput, type Json } from './canonical.js';
import { signBytes, verifyBytes } from './keys.js';

// Every signed document type has its own domain string ("machine/<type>/v<n>"): a signature made for one type never verifies as another.

export function signDocument(domain: string, body: Json, privateKeyPkcs8: Uint8Array): string {
  return signBytes(privateKeyPkcs8, signingInput(domain, body));
}

export function verifyDocument(domain: string, body: Json, publicKey: string, signature: string): boolean {
  let input: Uint8Array;
  try {
    input = signingInput(domain, body);
  } catch {
    return false;
  }
  return verifyBytes(publicKey, input, signature);
}
