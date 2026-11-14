import { randomBytes, randomUUID } from 'node:crypto';
import { generateSigningKeyPair, type SigningKeyPair } from '@wadeck-app/machine-core';

// Shared by the cross-tests only (never part of the browser package): a deterministic PRNG, and helpers that turn a machine-core key into a WebCrypto key.

export const STRONG = 'correct horse battery staple 7391';

export function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const PKCS8_ED25519_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

export function pkcs8FromSeed(seed: Uint8Array): Uint8Array {
  return new Uint8Array(Buffer.concat([PKCS8_ED25519_PREFIX, seed]));
}

/** A machine-core key pair as a WebCrypto signing key (optionally extractable, for the tests that need to compare). */
export async function webKeyFrom(pair: SigningKeyPair, extractable = false): Promise<CryptoKey> {
  return crypto.subtle.importKey('pkcs8', pair.privateKeyPkcs8 as BufferSource, 'Ed25519', extractable, ['sign']);
}

export function newPair(): SigningKeyPair {
  return generateSigningKeyPair();
}

export function uuid(): string {
  return randomUUID();
}

export function bytes(n: number): Uint8Array {
  return new Uint8Array(randomBytes(n));
}

export function b64u(data: Uint8Array): string {
  return Buffer.from(data).toString('base64url');
}

/** Random plain JSON of the kinds the signed documents contain (safe integers, unicode strings, nested objects with unsorted keys). */
export function randomJson(rand: () => number, depth = 0): unknown {
  const pick = Math.floor(rand() * (depth > 3 ? 4 : 6));
  const str = (): string => {
    const alphabet = ['a', 'Z', '0', ' ', '"', '\\','\n', '\u0000', 'é', '€', '\u{1f600}', '/', '-'];
    let s = '';
    for (let i = Math.floor(rand() * 8); i > 0; i--) s += alphabet[Math.floor(rand() * alphabet.length)];
    return s;
  };
  switch (pick) {
    case 0:
      return null;
    case 1:
      return rand() < 0.5;
    case 2:
      return Math.floor((rand() - 0.5) * 2 ** 40);
    case 3:
      return str();
    case 4:
      return Array.from({ length: Math.floor(rand() * 4) }, () => randomJson(rand, depth + 1));
    default: {
      const o: Record<string, unknown> = {};
      for (let i = Math.floor(rand() * 5); i > 0; i--) o[str() + String(i)] = randomJson(rand, depth + 1);
      return o;
    }
  }
}
