import { openSealed, sealTo as coreSealTo } from '@wadeck-app/machine-core';
// Not exported by the machine-core index: imported from its source for the comparison only.
import { ed25519PublicToX25519 as coreToX25519 } from '../../machine-core/src/seal.js';
import { describe, expect, it } from 'vitest';
import { b64u, bytes, newPair, prng } from '../test-support/kit.js';
import { ed25519PublicToX25519, sealTo } from './seal.js';

const P = 2n ** 255n - 19n;

function encodeY(y: bigint): string {
  const out = new Uint8Array(32);
  let rest = y;
  for (let i = 0; i < 32; i++) {
    out[i] = Number(rest & 0xffn);
    rest >>= 8n;
  }
  return b64u(out);
}

function messageOf(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    return (e as Error).message;
  }
  return '';
}

describe('sealTo: opened by machine-core', () => {
  it('100 random cases (random plaintext length, random context)', async () => {
    const rand = prng(11);
    for (let i = 0; i < 100; i++) {
      const recipient = newPair();
      const plaintext = bytes(Math.floor(rand() * 80));
      const context = `pair-secret:${Math.floor(rand() * 1e9)}:é`;
      const sealed = await sealTo(recipient.publicKey, plaintext, context);
      expect(Buffer.from(openSealed(recipient.privateKeyPkcs8, sealed, context)).equals(Buffer.from(plaintext))).toBe(true);
      expect(() => openSealed(recipient.privateKeyPkcs8, sealed, `${context}x`)).toThrow(/cannot open/);
      expect(() => openSealed(newPair().privateKeyPkcs8, sealed, context)).toThrow(/cannot open/);
    }
  });

  it('wire format: version 1, 32 ephemeral bytes, 12 nonce bytes, ciphertext, 16 tag bytes; two seals of the same value differ', async () => {
    const recipient = newPair();
    const a = Buffer.from(await sealTo(recipient.publicKey, new Uint8Array(32), 'ctx'), 'base64url');
    const b = Buffer.from(await sealTo(recipient.publicKey, new Uint8Array(32), 'ctx'), 'base64url');
    expect(a).toHaveLength(1 + 32 + 12 + 32 + 16);
    expect(a[0]).toBe(1);
    expect(a.equals(b)).toBe(false);
  });

  it('refuses an empty context and a malformed recipient key, like machine-core', async () => {
    const recipient = newPair();
    await expect(sealTo(recipient.publicKey, new Uint8Array(1), '')).rejects.toThrow(/context/);
    await expect(sealTo('AAAA', new Uint8Array(1), 'c')).rejects.toThrow(/public key/);
    await expect(sealTo(`${recipient.publicKey}=`, new Uint8Array(1), 'c')).rejects.toThrow(/public key/);
  });
});

describe('Ed25519 public key to X25519: same bytes and same refusals as machine-core', () => {
  it('100 random keys', () => {
    for (let i = 0; i < 100; i++) {
      const { publicKey } = newPair();
      expect(Buffer.from(ed25519PublicToX25519(publicKey)).equals(Buffer.from(coreToX25519(publicKey)))).toBe(true);
    }
  });

  it('refuses low-order points, non-canonical y, and off-curve values with the same messages', () => {
    const smallOrder = [
      '0100000000000000000000000000000000000000000000000000000000000000',
      'ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f',
      '0000000000000000000000000000000000000000000000000000000000000000',
      '0000000000000000000000000000000000000000000000000000000000000080',
      '26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc05',
      'c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac037a',
      '26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc85',
      'c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac03fa',
    ].map(hex => Buffer.from(hex, 'hex').toString('base64url'));
    const candidates = [...smallOrder, encodeY(P), encodeY(P + 1n), encodeY(2n ** 255n - 1n), ...Array.from({ length: 38 }, (_, i) => encodeY(BigInt(i + 2)))];
    let refused = 0;
    for (const key of candidates) {
      const core = messageOf(() => coreToX25519(key));
      const web = messageOf(() => ed25519PublicToX25519(key));
      expect(web, key).toBe(core);
      if (core !== '') refused++;
    }
    expect(refused).toBeGreaterThan(14);
    for (const key of smallOrder) expect(messageOf(() => ed25519PublicToX25519(key))).toMatch(/low-order/);
  });

  it('sealTo to a low-order recipient is refused', async () => {
    await expect(sealTo(Buffer.from('01'.padEnd(64, '0'), 'hex').toString('base64url'), new Uint8Array(1), 'c')).rejects.toThrow(/low-order/);
  });

  it('a sealed value built by machine-core and one built here have the same size for the same plaintext', async () => {
    const recipient = newPair();
    const here = Buffer.from(await sealTo(recipient.publicKey, new Uint8Array(32), 'c'), 'base64url');
    const there = Buffer.from(coreSealTo(recipient.publicKey, new Uint8Array(32), 'c'), 'base64url');
    expect(here).toHaveLength(there.length);
  });
});
