import { decodeBase64urlStrict, encodeBase64url } from './base64url.js';
import { buf, concat, subtle } from './keys.js';

// Sealing a small secret to a machine identity key, wire-compatible with machine-core seal.ts:
// base64url( version(1) || ephemeralPublic(32) || nonce(12) || ciphertext || tag(16) ), AAD = version || ephemeralPublic || context,
// key = HKDF-SHA256(shared, salt = ephemeralPublic || recipientX25519, info = "machine/seal/v1\0" || context).
// The browser only seals; opening happens on the machine. Error messages never contain key or plaintext bytes.

const VERSION = 1;
const NONCE_BYTES = 12;
const INFO_PREFIX = 'machine/seal/v1\u0000';

const P = 2n ** 255n - 19n;
const modP = (a: bigint): bigint => ((a % P) + P) % P;
function power(base: bigint, exponent: bigint): bigint {
  let result = 1n;
  let b = modP(base);
  let e = exponent;
  while (e > 0n) {
    if (e & 1n) result = (result * b) % P;
    b = (b * b) % P;
    e >>= 1n;
  }
  return result;
}
const inverse = (a: bigint): bigint => power(a, P - 2n);
// Edwards curve constant d = -121665 / 121666 (RFC 8032).
const D = modP(-121665n * inverse(121666n));
// sqrt(-1) mod p
const SQRT_M1 = power(2n, (P - 1n) / 4n);

function sqrt(a: bigint): bigint | undefined {
  // p = 5 mod 8
  let r = power(a, (P + 3n) / 8n);
  if (modP(r * r) === modP(a)) return r;
  r = modP(r * SQRT_M1);
  return modP(r * r) === modP(a) ? r : undefined;
}

type Point = { x: bigint; y: bigint };
// Complete addition law of the twisted Edwards curve with a = -1 (affine; the denominators never vanish for points of the curve).
function add(a: Point, b: Point): Point {
  const t = modP(D * a.x * b.x * a.y * b.y);
  return { x: modP((a.x * b.y + b.x * a.y) * inverse(1n + t)), y: modP((a.y * b.y + a.x * b.x) * inverse(1n - t)) };
}

const littleEndianToBigInt = (b: Uint8Array): bigint => {
  let v = 0n;
  for (let i = b.length - 1; i >= 0; i--) v = (v << 8n) | BigInt(b[i] as number);
  return v;
};
function bigIntToLittleEndian(v: bigint): Uint8Array {
  const out = new Uint8Array(32);
  let rest = v;
  for (let i = 0; i < 32; i++) {
    out[i] = Number(rest & 0xffn);
    rest >>= 8n;
  }
  return out;
}

/**
 * Ed25519 public key (raw 32 bytes as unpadded base64url) to the raw X25519 public key (32 bytes, little endian): u = (1 + y) / (1 - y) mod p.
 * Refuses a non-canonical encoding (y >= p, or a sign bit on x = 0), a value that is not a point of the curve, and every point of
 * order dividing 8 (the sealed value would then not depend on the recipient). Same refusals and messages as machine-core.
 */
export function ed25519PublicToX25519(publicKey: string): Uint8Array {
  const raw = decodeBase64urlStrict(publicKey, 32, 'recipient public key');
  const sign = (raw[31] as number) >> 7;
  const encoded = Uint8Array.from(raw);
  encoded[31] = (encoded[31] as number) & 0x7f;
  const y = littleEndianToBigInt(encoded);
  if (y >= P) throw new Error('recipient public key is not canonical (y is not below 2^255-19): this is not a key made by this software');
  const y2 = modP(y * y);
  const x2 = modP((y2 - 1n) * inverse(modP(D * y2 + 1n)));
  let x = sqrt(x2);
  if (x === undefined) throw new Error('recipient public key is not a valid Ed25519 public key (it is not a point of the curve)');
  if (x === 0n && sign === 1) throw new Error('recipient public key is not canonical (sign bit set on x = 0)');
  if (Number(x & 1n) !== sign) x = modP(-x);
  // Mixed-order (torsion) points are accepted on purpose: the X25519 clamp clears the cofactor, so they cannot leak anything.
  // Low order: 8 * P is the identity (0, 1) exactly for the points of order 1, 2, 4 and 8.
  let q: Point = { x, y };
  for (let i = 0; i < 3; i++) q = add(q, q);
  if (q.x === 0n && q.y === 1n) throw new Error('recipient public key is a low-order point: sealing to it would not protect anything. Use the real identity key of the machine');
  return bigIntToLittleEndian(modP((1n + y) * inverse(modP(1n - y))));
}

function assertContext(context: unknown): asserts context is string {
  if (typeof context !== 'string' || context.length === 0) throw new Error('the seal context must be a non-empty string naming the purpose (for example pair-secret:<sender>:<recipient>)');
}

/** Seal `plaintext` so that only the holder of the private key of `recipientIdentityPublicKey` can open it, for this `context` only. */
export async function sealTo(recipientIdentityPublicKey: string, plaintext: Uint8Array, context: string): Promise<string> {
  assertContext(context);
  const recipientPublicRaw = ed25519PublicToX25519(recipientIdentityPublicKey);
  const s = subtle();
  const ephemeral = (await s.generateKey({ name: 'X25519' }, false, ['deriveBits'])) as CryptoKeyPair;
  const ephemeralPublic = new Uint8Array(await s.exportKey('raw', ephemeral.publicKey));
  const recipientKey = await s.importKey('raw', buf(recipientPublicRaw), { name: 'X25519' }, false, []);
  const shared = new Uint8Array(await s.deriveBits({ name: 'X25519', public: recipientKey }, ephemeral.privateKey, 256));
  let keyBits: Uint8Array | undefined;
  try {
    if (shared.every(b => b === 0)) throw new Error('the key agreement gave an all-zero result (a low-order public key was presented)');
    const contextBytes = new TextEncoder().encode(context);
    const hkdfKey = await s.importKey('raw', buf(shared), 'HKDF', false, ['deriveBits']);
    keyBits = new Uint8Array(
      await s.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: buf(concat(ephemeralPublic, recipientPublicRaw)), info: buf(concat(new TextEncoder().encode(INFO_PREFIX), contextBytes)) }, hkdfKey, 256),
    );
    const aesKey = await s.importKey('raw', buf(keyBits), 'AES-GCM', false, ['encrypt']);
    const nonce = globalThis.crypto.getRandomValues(new Uint8Array(NONCE_BYTES));
    const aad = concat(Uint8Array.of(VERSION), ephemeralPublic, contextBytes);
    const encrypted = new Uint8Array(await s.encrypt({ name: 'AES-GCM', iv: buf(nonce), additionalData: buf(aad), tagLength: 128 }, aesKey, buf(plaintext)));
    return encodeBase64url(concat(Uint8Array.of(VERSION), ephemeralPublic, nonce, encrypted));
  } finally {
    shared.fill(0);
    keyBits?.fill(0);
  }
}
