import { decodeBase64urlStrict } from './base64url.js';
import { concat, sha256 } from './keys.js';

// Verification codes for enrollment by candidacy: 80 bits, four groups of four Crockford base32 characters.
// Same domains and byte layout as machine-core sas.ts.

const CANDIDACY_DOMAIN = 'machine/candidacy-code/v1';
const FINAL_DOMAIN = 'machine/final-code/v1';
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

const rawKey = (publicKey: string, label: string): Uint8Array => decodeBase64urlStrict(publicKey, 32, label);
const rawRandom = (random: string): Uint8Array => decodeBase64urlStrict(random, 16, 'candidacy random');
const text = (s: string): Uint8Array => new TextEncoder().encode(s);

/** The first 10 bytes (80 bits) of a digest as four groups of four characters. */
export function formatVerificationCode(digest: Uint8Array): string {
  if (digest.length < 10) throw new Error('formatVerificationCode: need at least 10 bytes');
  let bits = 0n;
  for (let i = 0; i < 10; i++) bits = (bits << 8n) | BigInt(digest[i] as number);
  let out = '';
  for (let i = 15; i >= 0; i--) out += ALPHABET[Number((bits >> BigInt(i * 5)) & 31n)];
  return `${out.slice(0, 4)}-${out.slice(4, 8)}-${out.slice(8, 12)}-${out.slice(12, 16)}`;
}

/** Recomputed by the admin page from the candidacy it received, and compared with what the candidate's CLI shows. */
export async function candidacyCode(candidatePublicKey: string, random: string): Promise<string> {
  const input = concat(text(`${CANDIDACY_DOMAIN}\u0000`), rawKey(candidatePublicKey, 'candidate public key'), rawRandom(random));
  return formatVerificationCode(await sha256(input));
}

/** Shown on both sides after approval, before the candidate pins the admin public key. */
export async function finalCode(candidatePublicKey: string, adminPublicKey: string, random: string): Promise<string> {
  const input = concat(text(`${FINAL_DOMAIN}\u0000`), rawKey(candidatePublicKey, 'candidate public key'), rawKey(adminPublicKey, 'admin public key'), rawRandom(random));
  return formatVerificationCode(await sha256(input));
}

