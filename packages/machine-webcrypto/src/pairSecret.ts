import { encodeBase64url } from './base64url.js';
import { buf, subtle } from './keys.js';
import { signRaw } from './signed.js';

// The pair secret of two machines from a deterministic Ed25519 signature of the admin key: the same function as machine-core
// derivePairSecretV2, computable with a non-extractable key. Ed25519 is deterministic and unforgeable without the key, so a
// signature over a domain-separated string naming both machines and serials is a keyed PRF; HKDF-SHA256 gives 32 bytes.

export const PAIR_SECRET_V2_DOMAIN = 'machine/pair-secret/v2';
export const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export interface PairMember {
  uuid: string;
  serial: number;
}

/** Validates both members and returns them ordered by uuid, so both sides of the pair get the same value. */
export function orderedPair(a: PairMember, b: PairMember): [PairMember, PairMember] {
  for (const m of [a, b]) {
    if (typeof m.uuid !== 'string' || !UUID_V4.test(m.uuid)) throw new Error('pair secret: uuid must be a lowercase version 4 UUID');
    if (!Number.isSafeInteger(m.serial) || m.serial < 1) throw new Error('pair secret: serial must be a positive integer');
  }
  if (a.uuid === b.uuid) throw new Error('pair secret: a machine is never paired with itself; the two uuids must differ');
  return a.uuid < b.uuid ? [a, b] : [b, a];
}

export async function derivePairSecretFromSignature(privateKey: CryptoKey, a: PairMember, b: PairMember): Promise<string> {
  const [first, second] = orderedPair(a, b);
  const data = new TextEncoder().encode(`${PAIR_SECRET_V2_DOMAIN}\u0000${first.uuid}:${first.serial}\u0000${second.uuid}:${second.serial}`);
  const signature = await signRaw(privateKey, data);
  let secret: Uint8Array | undefined;
  try {
    const ikm = await subtle().importKey('raw', buf(signature), 'HKDF', false, ['deriveBits']);
    secret = new Uint8Array(await subtle().deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: new ArrayBuffer(0), info: buf(new TextEncoder().encode(PAIR_SECRET_V2_DOMAIN)) }, ikm, 256));
    return encodeBase64url(secret);
  } finally {
    signature.fill(0);
    secret?.fill(0);
  }
}
