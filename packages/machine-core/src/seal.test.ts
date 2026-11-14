import { createHash, createPublicKey, diffieHellman, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { generateSigningKeyPair } from './keys.js';
import { ed25519PrivateToX25519, ed25519PublicToX25519, openSealed, sealTo } from './seal.js';

const P = 2n ** 255n - 19n;
const context = 'pair-secret:admin-uuid:candidate-uuid:random';
const plaintext = new TextEncoder().encode('SECRET-PLAINTEXT-0123456789-abcdefghij');
const text = (b: Uint8Array): string => Buffer.from(b).toString();

const encodeY = (y: bigint, sign = 0): string => {
  const b = Buffer.alloc(32);
  let v = y;
  for (let i = 0; i < 32; i++) {
    b[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  if (sign) b[31] = (b[31] as number) | 0x80;
  return b.toString('base64url');
};

function messageOf(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    return (e as Error).message;
  }
  throw new Error('expected the call to throw');
}

const x25519Public = (raw: Uint8Array) => createPublicKey({ key: { kty: 'OKP', crv: 'X25519', x: Buffer.from(raw).toString('base64url') }, format: 'jwk' });

describe('seal: round trip and binding', () => {
  it('opens what was sealed to the recipient key', () => {
    const r = generateSigningKeyPair();
    const sealed = sealTo(r.publicKey, plaintext, context);
    expect(openSealed(r.privateKeyPkcs8, sealed, context)).toEqual(plaintext);
  });

  it('seals an empty plaintext', () => {
    const r = generateSigningKeyPair();
    expect(openSealed(r.privateKeyPkcs8, sealTo(r.publicKey, new Uint8Array(0), context), context)).toEqual(new Uint8Array(0));
  });

  it('output is unpadded base64url of version, ephemeral key, nonce, ciphertext and tag', () => {
    const r = generateSigningKeyPair();
    const sealed = sealTo(r.publicKey, plaintext, context);
    expect(sealed).toMatch(/^[A-Za-z0-9_-]+$/);
    const raw = Buffer.from(sealed, 'base64url');
    expect(raw.length).toBe(1 + 32 + 12 + plaintext.length + 16);
    expect(raw[0]).toBe(1);
  });

  it('two seals of the same plaintext differ', () => {
    const r = generateSigningKeyPair();
    expect(sealTo(r.publicKey, plaintext, context)).not.toBe(sealTo(r.publicKey, plaintext, context));
  });

  it('another recipient key cannot open', () => {
    const r = generateSigningKeyPair();
    const other = generateSigningKeyPair();
    const sealed = sealTo(r.publicKey, plaintext, context);
    expect(() => openSealed(other.privateKeyPkcs8, sealed, context)).toThrow(/cannot open the sealed value/);
  });

  it('another context cannot open (a sealed value is not reusable for another purpose)', () => {
    const r = generateSigningKeyPair();
    const sealed = sealTo(r.publicKey, plaintext, context);
    expect(() => openSealed(r.privateKeyPkcs8, sealed, `${context}x`)).toThrow(/cannot open the sealed value/);
    expect(() => openSealed(r.privateKeyPkcs8, sealed, 'pair-secret:other')).toThrow(/cannot open the sealed value/);
  });

  it('refuses an empty context', () => {
    const r = generateSigningKeyPair();
    expect(() => sealTo(r.publicKey, plaintext, '')).toThrow(/context/);
    expect(() => openSealed(r.privateKeyPkcs8, 'AAAA', '')).toThrow(/context/);
  });
});

describe('seal: tampering', () => {
  const r = generateSigningKeyPair();
  const raw = Buffer.from(sealTo(r.publicKey, plaintext, context), 'base64url');
  const flip = (index: number): string => {
    const copy = Buffer.from(raw);
    copy[index] = (copy[index] as number) ^ 0x01;
    return copy.toString('base64url');
  };
  const regions: Array<[string, number]> = [
    ['version', 0],
    ['ephemeral public key', 1],
    ['ephemeral public key (last byte)', 32],
    ['nonce', 33],
    ['ciphertext', 45],
    ['tag', raw.length - 1],
  ];
  it('the unmodified value opens (positive control for the flips below)', () => {
    expect(openSealed(r.privateKeyPkcs8, raw.toString('base64url'), context)).toEqual(plaintext);
  });

  // The version byte has its own message; every other region must end in the one generic refusal.
  for (const [name, index] of regions.filter(([n]) => n !== 'version')) {
    it(`a changed ${name} is refused`, () => {
      expect(() => openSealed(r.privateKeyPkcs8, flip(index), context)).toThrow(/cannot open the sealed value/);
    });
  }

  it('a changed version says which version is known', () => {
    expect(() => openSealed(r.privateKeyPkcs8, flip(0), context)).toThrow(/version/);
  });

  it('truncated and too short values are refused', () => {
    expect(() => openSealed(r.privateKeyPkcs8, raw.subarray(0, raw.length - 1).toString('base64url'), context)).toThrow(/sealed value/);
    expect(() => openSealed(r.privateKeyPkcs8, raw.subarray(0, 40).toString('base64url'), context)).toThrow(/too short/);
    expect(() => openSealed(r.privateKeyPkcs8, '', context)).toThrow(/too short/);
  });

  it('padded, standard-alphabet, spaced and non-string values are refused', () => {
    const good = raw.toString('base64url');
    expect(() => openSealed(r.privateKeyPkcs8, `${good}=`, context)).toThrow(/unpadded base64url/);
    expect(() => openSealed(r.privateKeyPkcs8, `${good} `, context)).toThrow(/unpadded base64url/);
    expect(() => openSealed(r.privateKeyPkcs8, 12 as unknown as string, context)).toThrow(/unpadded base64url/);
    // A value whose standard base64 spelling differs from the base64url one (contains + or /).
    for (let i = 0; i < 200; i++) {
      const candidate = Buffer.from(sealTo(r.publicKey, plaintext, context), 'base64url');
      if (/[+/]/.test(candidate.toString('base64'))) {
        expect(() => openSealed(r.privateKeyPkcs8, candidate.toString('base64'), context)).toThrow(/unpadded base64url/);
        return;
      }
    }
    throw new Error('no value with + or / in its standard base64 spelling in 200 tries');
  });

  it('non-zero trailing bits (another spelling of the same bytes) are refused', () => {
    // 1 + 32 + 12 + 16 = 61 bytes for an empty plaintext: 61 * 8 mod 6 = 2, so two trailing bits exist.
    const empty = sealTo(r.publicKey, new Uint8Array(0), context);
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    const last = empty[empty.length - 1] as string;
    const spelled = `${empty.slice(0, -1)}${alphabet[(alphabet.indexOf(last) + 1) % 64] as string}`;
    expect(Buffer.from(spelled, 'base64url').equals(Buffer.from(empty, 'base64url'))).toBe(true);
    expect(() => openSealed(r.privateKeyPkcs8, spelled, context)).toThrow(/unpadded base64url/);
  });
});

describe('seal: hostile ephemeral public key', () => {
  const r = generateSigningKeyPair();
  const littleEndian32 = (v: bigint): Buffer => {
    const b = Buffer.alloc(32);
    let rest = v;
    for (let i = 0; i < 32; i++) {
      b[i] = Number(rest & 0xffn);
      rest >>= 8n;
    }
    return b;
  };
  const withEphemeral = (ephemeral: Buffer): string => {
    const valid = Buffer.from(sealTo(r.publicKey, plaintext, context), 'base64url');
    return Buffer.concat([valid.subarray(0, 1), ephemeral, valid.subarray(33)]).toString('base64url');
  };
  const cases: Array<[string, Buffer]> = [
    ['all-zero u', Buffer.alloc(32)],
    ['u = 1', littleEndian32(1n)],
    ['u = p - 1', littleEndian32(P - 1n)],
    ['an order-8 u', littleEndian32(325606250916557431795983626356110631294008115727848805560023387167927233504n)],
    ['the other order-8 u', littleEndian32(39382357235489614581723060781553021112529692952248105548094251357589366434n)],
  ];
  for (const [name, ephemeral] of cases) {
    // Both the key agreement refusal (OpenSSL error or all-zero result) and a failed tag end in the same generic error: from the outside the branch is not distinguishable, and neither leaks a value.
    it(`a low-order ephemeral key (${name}) is refused`, () => {
      expect(() => openSealed(r.privateKeyPkcs8, withEphemeral(ephemeral), context)).toThrow(/cannot open the sealed value/);
    });
  }
});

describe('seal: Ed25519 to X25519 conversion', () => {
  it('a sender converting the public key and a recipient converting the private key agree, for 200 random keys', () => {
    for (let i = 0; i < 200; i++) {
      const recipient = generateSigningKeyPair();
      const ephemeral = generateSigningKeyPair();
      const recipientPublicX = ed25519PublicToX25519(recipient.publicKey);
      const recipientPrivateX = ed25519PrivateToX25519(recipient.privateKeyPkcs8);
      // The X25519 public key that OpenSSL derives from the converted private key is the converted public key.
      expect(createPublicKey(recipientPrivateX).export({ format: 'jwk' }).x).toBe(Buffer.from(recipientPublicX).toString('base64url'));
      // Sender: ephemeral private with the converted recipient public. Recipient: converted private with the ephemeral public.
      const ephemeralPrivateX = ed25519PrivateToX25519(ephemeral.privateKeyPkcs8);
      const senderView = diffieHellman({ privateKey: ephemeralPrivateX, publicKey: x25519Public(recipientPublicX) });
      const recipientView = diffieHellman({ privateKey: recipientPrivateX, publicKey: createPublicKey(ephemeralPrivateX) });
      expect(Buffer.from(senderView).equals(Buffer.from(recipientView))).toBe(true);
    }
  });

  it('the private conversion is SHA-512 of the seed, first 32 bytes, clamped (RFC 8032 section 7.1 test 1 keys)', () => {
    const seed = Buffer.from('9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60', 'hex');
    const pkcs8 = Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed]);
    const expected = createHash('sha512').update(seed).digest().subarray(0, 32);
    expected[0] = (expected[0] as number) & 248;
    expected[31] = ((expected[31] as number) & 127) | 64;
    expect(ed25519PrivateToX25519(pkcs8).export({ format: 'jwk' }).d).toBe(expected.toString('base64url'));
    // The RFC public key of that seed converts to the X25519 public key of the converted private key.
    const publicKey = Buffer.from('d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a', 'hex').toString('base64url');
    expect(createPublicKey(ed25519PrivateToX25519(pkcs8)).export({ format: 'jwk' }).x).toBe(Buffer.from(ed25519PublicToX25519(publicKey)).toString('base64url'));
  });

  it('the map is u = (1 + y) / (1 - y) mod p', () => {
    const inverse = (a: bigint): bigint => {
      let result = 1n;
      let base = a % P;
      let exponent = P - 2n;
      while (exponent > 0n) {
        if (exponent & 1n) result = (result * base) % P;
        base = (base * base) % P;
        exponent >>= 1n;
      }
      return result;
    };
    let checked = 0;
    for (let y = 2n; y < 60n; y++) {
      let u: Buffer;
      try {
        u = Buffer.from(ed25519PublicToX25519(encodeY(y)));
      } catch {
        // y is not on the curve
        continue;
      }
      let value = 0n;
      for (let i = 31; i >= 0; i--) value = (value << 8n) | BigInt(u[i] as number);
      expect(value).toBe((((1n + y) % P) * inverse((1n - y + P) % P)) % P);
      checked++;
    }
    expect(checked).toBeGreaterThan(5);
  });

  it('low-order points are refused with a clear error, as recipient key', () => {
    const smallOrder = [
      // identity, order 2, order 4 (both signs)
      '0100000000000000000000000000000000000000000000000000000000000000',
      'ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f',
      '0000000000000000000000000000000000000000000000000000000000000000',
      '0000000000000000000000000000000000000000000000000000000000000080',
      // order 8
      '26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc05',
      'c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac037a',
      '26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc85',
      'c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac03fa',
    ];
    for (const hex of smallOrder) {
      const key = Buffer.from(hex, 'hex').toString('base64url');
      expect(messageOf(() => sealTo(key, plaintext, context)), hex).toMatch(/low-order/);
    }
  });

  it('non-canonical y (y >= p) is refused', () => {
    expect(messageOf(() => ed25519PublicToX25519(encodeY(P)))).toMatch(/not canonical/);
    expect(messageOf(() => ed25519PublicToX25519(encodeY(P + 1n)))).toMatch(/not canonical/);
    expect(messageOf(() => ed25519PublicToX25519(encodeY(2n ** 255n - 1n)))).toMatch(/not canonical/);
  });

  it('a y that is on no point of the curve is refused', () => {
    let refused = 0;
    for (let y = 2n; y < 40n; y++) {
      try {
        ed25519PublicToX25519(encodeY(y));
      } catch (e) {
        expect((e as Error).message).toMatch(/not a valid Ed25519 public key/);
        refused++;
      }
    }
    expect(refused).toBeGreaterThan(5);
  });

  it('a public key of the wrong length or spelling is refused', () => {
    expect(() => sealTo('AAAA', plaintext, context)).toThrow(/public key/);
    expect(() => sealTo(`${generateSigningKeyPair().publicKey}=`, plaintext, context)).toThrow(/public key/);
  });

  it('a private key that is not Ed25519 PKCS8 is refused', () => {
    const sealed = sealTo(generateSigningKeyPair().publicKey, plaintext, context);
    expect(() => openSealed(new Uint8Array(10), sealed, context)).toThrow(/private key/);
    const bad = Buffer.from(generateSigningKeyPair().privateKeyPkcs8);
    bad[3] = 0x7f;
    expect(() => openSealed(bad, sealed, context)).toThrow(/private key/);
  });
});

describe('seal: errors never carry secrets', () => {
  it('no key or plaintext bytes in any error message', () => {
    const r = generateSigningKeyPair();
    const other = generateSigningKeyPair();
    const sealed = sealTo(r.publicKey, plaintext, context);
    const secrets = [
      text(plaintext),
      Buffer.from(plaintext).toString('base64url'),
      Buffer.from(plaintext).toString('hex'),
      Buffer.from(r.privateKeyPkcs8).toString('base64url'),
      Buffer.from(r.privateKeyPkcs8).toString('hex'),
      Buffer.from(other.privateKeyPkcs8).toString('base64url'),
      Buffer.from(r.privateKeyPkcs8).subarray(16).toString('base64url'),
      Buffer.from(other.privateKeyPkcs8).subarray(16).toString('base64url'),
    ];
    const messages = [
      messageOf(() => openSealed(other.privateKeyPkcs8, sealed, context)),
      messageOf(() => openSealed(r.privateKeyPkcs8, sealed, 'other')),
      messageOf(() => openSealed(r.privateKeyPkcs8, `${sealed}=`, context)),
      messageOf(() => openSealed(r.privateKeyPkcs8, sealed.slice(0, 20), context)),
      messageOf(() => openSealed(new Uint8Array(randomBytes(48)), sealed, context)),
      messageOf(() => sealTo(Buffer.from('0100000000000000000000000000000000000000000000000000000000000000', 'hex').toString('base64url'), plaintext, context)),
      messageOf(() => sealTo('not-a-key', plaintext, context)),
    ];
    for (const m of messages) for (const s of secrets) expect(m).not.toContain(s);
  });
});
