import { createCipheriv, createDecipheriv, createHash, createPrivateKey, createPublicKey, diffieHellman, generateKeyPairSync, hkdfSync, randomBytes, type KeyObject } from 'node:crypto';
import { decodeBase64urlStrict } from './keys.js';

// Sealing a small secret to a machine's identity key (decision 22, one identity key per machine, decision 42):
// HPKE-like (ephemeral X25519 + HKDF-SHA256 + AES-256-GCM). The recipient Ed25519 key is converted to X25519 (birational
// map), so no second key is stored or published. No I/O. Error messages never contain key or plaintext bytes.
//
// Wire: base64url( version(1) || ephemeralPublic(32) || nonce(12) || ciphertext || tag(16) ).
// AAD = version || ephemeralPublic || context. The context binds the PURPOSE (for example
// `pair-secret:<sender>:<recipient>`): a sealed value opened under another context fails.

const VERSION = 1;
const EPHEMERAL_BYTES = 32;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const MIN_SEALED_BYTES = 1 + EPHEMERAL_BYTES + NONCE_BYTES + TAG_BYTES;
const INFO_PREFIX = 'machine/seal/v1\0';

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
 * Ed25519 public key (raw 32 bytes as unpadded base64url) to the raw X25519 public key (32 bytes, little endian):
 * u = (1 + y) / (1 - y) mod p. Refuses a non-canonical encoding (y >= p, or a sign bit on x = 0), a value that is not a
 * point of the curve, and every point of order dividing 8 (the sealed value would then not depend on the recipient).
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

const PKCS8_ED25519_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');
const PKCS8_X25519_PREFIX = Buffer.from('302e020100300506032b656e04220420', 'hex');

/** Ed25519 private key (PKCS8 DER, as the identity stores it) to the X25519 private key: SHA-512 of the seed, first 32 bytes, clamped. */
export function ed25519PrivateToX25519(privateKeyPkcs8: Uint8Array): KeyObject {
  const der = Buffer.from(privateKeyPkcs8);
  if (der.length !== PKCS8_ED25519_PREFIX.length + 32 || !der.subarray(0, PKCS8_ED25519_PREFIX.length).equals(PKCS8_ED25519_PREFIX)) {
    throw new Error('the private key is not an Ed25519 PKCS8 key of 48 bytes: the identity file may be damaged');
  }
  // Best effort: the temporary copies we own are zeroed (the key objects and the caller's buffer are not ours to clear).
  const digest = createHash('sha512').update(der.subarray(PKCS8_ED25519_PREFIX.length)).digest();
  const scalar = digest.subarray(0, 32);
  scalar[0] = (scalar[0] as number) & 248;
  scalar[31] = ((scalar[31] as number) & 127) | 64;
  const pkcs8 = Buffer.concat([PKCS8_X25519_PREFIX, scalar]);
  try {
    return createPrivateKey({ key: pkcs8, format: 'der', type: 'pkcs8' });
  } finally {
    pkcs8.fill(0);
    digest.fill(0);
    der.fill(0);
  }
}

const x25519PublicKey = (raw: Uint8Array): KeyObject => createPublicKey({ key: { kty: 'OKP', crv: 'X25519', x: Buffer.from(raw).toString('base64url') }, format: 'jwk' });
const rawX25519Public = (key: KeyObject): Buffer => {
  const x = key.export({ format: 'jwk' }).x;
  if (typeof x !== 'string') throw new Error('the runtime returned no raw X25519 public key');
  return Buffer.from(x, 'base64url');
};

function agree(privateKey: KeyObject, peerPublic: KeyObject): Buffer {
  let shared: Buffer;
  try {
    shared = diffieHellman({ privateKey, publicKey: peerPublic });
  } catch {
    throw new Error('the key agreement failed (a low-order or invalid public key was presented)');
  }
  if (shared.every((b) => b === 0)) throw new Error('the key agreement gave an all-zero result (a low-order public key was presented)');
  return shared;
}

function derive(shared: Buffer, ephemeralPublic: Buffer, recipientPublic: Buffer, context: string): Buffer {
  return Buffer.from(hkdfSync('sha256', shared, Buffer.concat([ephemeralPublic, recipientPublic]), Buffer.concat([Buffer.from(INFO_PREFIX), Buffer.from(context, 'utf8')]), 32));
}

const aad = (ephemeralPublic: Buffer, context: string): Buffer => Buffer.concat([Buffer.from([VERSION]), ephemeralPublic, Buffer.from(context, 'utf8')]);

function assertContext(context: unknown): asserts context is string {
  if (typeof context !== 'string' || context.length === 0) throw new Error('the seal context must be a non-empty string naming the purpose (for example pair-secret:<sender>:<recipient>)');
}

/** Seal `plaintext` so that only the holder of the private key of `recipientIdentityPublicKey` can open it, for this `context` only. */
export function sealTo(recipientIdentityPublicKey: string, plaintext: Uint8Array, context: string): string {
  assertContext(context);
  const recipientPublicRaw = Buffer.from(ed25519PublicToX25519(recipientIdentityPublicKey));
  const ephemeral = generateKeyPairSync('x25519');
  const ephemeralPublic = rawX25519Public(ephemeral.publicKey);
  const shared = agree(ephemeral.privateKey, x25519PublicKey(recipientPublicRaw));
  let key: Buffer | undefined;
  try {
    key = derive(shared, ephemeralPublic, recipientPublicRaw, context);
    const nonce = randomBytes(NONCE_BYTES);
    const cipher = createCipheriv('aes-256-gcm', key, nonce, { authTagLength: TAG_BYTES });
    cipher.setAAD(aad(ephemeralPublic, context));
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    return Buffer.concat([Buffer.from([VERSION]), ephemeralPublic, nonce, ciphertext, cipher.getAuthTag()]).toString('base64url');
  } finally {
    shared.fill(0);
    key?.fill(0);
  }
}

/** Open a value made by `sealTo` for the identity key `recipientIdentityPrivateKey` (PKCS8 DER) under the same `context`. */
export function openSealed(recipientIdentityPrivateKey: Uint8Array, sealed: string, context: string): Uint8Array {
  assertContext(context);
  if (typeof sealed !== 'string') throw new Error('the sealed value must be unpadded base64url text');
  const raw = Buffer.from(sealed, 'base64url');
  if (raw.toString('base64url') !== sealed) throw new Error('the sealed value is not unpadded base64url (padding, wrong alphabet or non-canonical spelling)');
  if (raw.length < MIN_SEALED_BYTES) throw new Error(`the sealed value is too short (${raw.length} bytes, at least ${MIN_SEALED_BYTES}): it is truncated or not a sealed value`);
  if (raw[0] !== VERSION) throw new Error(`the sealed value has version ${String(raw[0])}, this build reads version ${VERSION}: update machine or ask the sender to update`);
  const ephemeralPublic = raw.subarray(1, 1 + EPHEMERAL_BYTES);
  const nonce = raw.subarray(1 + EPHEMERAL_BYTES, 1 + EPHEMERAL_BYTES + NONCE_BYTES);
  const ciphertext = raw.subarray(1 + EPHEMERAL_BYTES + NONCE_BYTES, raw.length - TAG_BYTES);
  const tag = raw.subarray(raw.length - TAG_BYTES);
  const privateKey = ed25519PrivateToX25519(recipientIdentityPrivateKey);
  const cannot = (): Error =>
    new Error('cannot open the sealed value: it was not sealed to this machine identity key, it was altered, or it was sealed for another purpose (context). Ask the sender to seal it again');
  let shared: Buffer | undefined;
  let key: Buffer | undefined;
  try {
    shared = agree(privateKey, x25519PublicKey(ephemeralPublic));
    key = derive(shared, Buffer.from(ephemeralPublic), rawX25519Public(createPublicKey(privateKey)), context);
    const decipher = createDecipheriv('aes-256-gcm', key, nonce, { authTagLength: TAG_BYTES });
    decipher.setAAD(aad(Buffer.from(ephemeralPublic), context));
    decipher.setAuthTag(tag);
    return new Uint8Array(Buffer.concat([decipher.update(ciphertext), decipher.final()]));
  } catch {
    throw cannot();
  } finally {
    shared?.fill(0);
    key?.fill(0);
  }
}
