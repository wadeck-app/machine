import { createHash, randomBytes } from 'node:crypto';
import { decodeBase64urlStrict } from './keys.js';

// Verification codes for enrollment by candidacy (decisions 35, 35a).
// Candidacy code: 80 bits, four groups of four Crockford base32 characters (internal, shown with --verbose).
// Final code ("security code", the one human comparison): 83 bits, five groups of five digits (decision 55).
// The relay cannot find another key that gives the same code in reasonable time (about 2^80 / 2^83 work), so a swapped key is visible by comparison.

const CANDIDACY_DOMAIN = 'machine/candidacy-code/v1';
const FINAL_DOMAIN = 'machine/final-code/v1';
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

function rawKey(publicKey: string, label: string): Buffer {
  return decodeBase64urlStrict(publicKey, 32, label);
}

function rawRandom(random: string): Buffer {
  return decodeBase64urlStrict(random, 16, 'candidacy random');
}

function format(digest: Buffer): string {
  // First 10 bytes = 80 bits = 16 groups of 5 bits.
  let bits = 0n;
  for (let i = 0; i < 10; i++) bits = (bits << 8n) | BigInt(digest[i] as number);
  let out = '';
  for (let i = 15; i >= 0; i--) out += ALPHABET[Number((bits >> BigInt(i * 5)) & 31n)];
  return `${out.slice(0, 4)}-${out.slice(4, 8)}-${out.slice(8, 12)}-${out.slice(12, 16)}`;
}

/**
 * The final code as shown to a human (decision 55, "security code"): the first 83 bits of the digest as 25 decimal digits in
 * five groups of five separated by spaces (2^83 < 10^25, so every kept bit counts). Digits and spaces only: visibly unlike the
 * base32 candidacy code and the relay login code, and easy to read aloud. 83 bits, against 80 for the earlier base32 display.
 */
export function formatFinalCode(digest: Uint8Array): string {
  if (digest.length < 11) throw new Error('formatFinalCode: need at least 11 bytes');
  // 11 bytes = 88 bits, the last 5 are dropped.
  let bits = 0n;
  for (let i = 0; i < 11; i++) bits = (bits << 8n) | BigInt(digest[i] as number);
  const digits = (bits >> 5n).toString().padStart(25, '0');
  return [0, 5, 10, 15, 20].map((i) => digits.slice(i, i + 5)).join(' ');
}

export function newCandidacyRandom(): string {
  return randomBytes(16).toString('base64url');
}

/** Shown by the candidate's CLI and recomputed by the admin page from the candidacy it received. */
export function candidacyCode(candidatePublicKey: string, random: string): string {
  const digest = createHash('sha256')
    .update(`${CANDIDACY_DOMAIN}\u0000`)
    .update(rawKey(candidatePublicKey, 'candidate public key'))
    .update(rawRandom(random))
    .digest();
  return format(digest);
}

/** Shown on both sides after approval, before the candidate pins the admin public key. */
export function finalCode(candidatePublicKey: string, adminPublicKey: string, random: string): string {
  const digest = createHash('sha256')
    .update(`${FINAL_DOMAIN}\u0000`)
    .update(rawKey(candidatePublicKey, 'candidate public key'))
    .update(rawKey(adminPublicKey, 'admin public key'))
    .update(rawRandom(random))
    .digest();
  return formatFinalCode(digest);
}
