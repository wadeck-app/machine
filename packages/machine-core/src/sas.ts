import { createHash, randomBytes } from 'node:crypto';
import { decodeBase64urlStrict } from './keys.js';

// Verification codes for enrollment by candidacy (decisions 35, 35a).
// 80 bits, shown as four groups of four Crockford base32 characters. The relay cannot find another key that
// gives the same code in reasonable time (about 2^80 work), so a swapped key is visible by comparison.

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
  return format(digest);
}
