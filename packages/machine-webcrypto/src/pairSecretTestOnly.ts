import { encodeBase64url } from './base64url.js';
import { buf, subtle } from './keys.js';
import { UUID_V4 } from './pairSecret.js';

// FOR TESTS ONLY, not exported by index.ts. The current machine-core derivePairSecret keys HKDF with the raw admin seed, which a
// non-extractable browser key cannot provide: this twin exists only to prove the two implementations agree while the decision
// on derivePairSecretV2 is pending. Never call it with a real admin seed in the page.

export async function derivePairSecretFromSeedForTests(seed: Uint8Array, a: { uuid: string; serial: number }, b: { uuid: string; serial: number }): Promise<string> {
  if (seed.length !== 32) throw new Error('the admin seed must be 32 bytes');
  for (const m of [a, b]) if (!UUID_V4.test(m.uuid)) throw new Error('pair secret: uuid must be a lowercase version 4 UUID');
  const [first, second] = a.uuid <= b.uuid ? [a, b] : [b, a];
  const data = new TextEncoder().encode(`machine/pair-secret/v1\u0000${first.uuid}:${first.serial}\u0000${second.uuid}:${second.serial}`);
  const ikm = await subtle().importKey('raw', buf(seed), 'HKDF', false, ['deriveBits']);
  const subkey = new Uint8Array(await subtle().deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: new ArrayBuffer(0), info: buf(new TextEncoder().encode('machine/pair-secret/v1')) }, ikm, 256));
  try {
    const hmac = await subtle().importKey('raw', buf(subkey), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    return encodeBase64url(new Uint8Array(await subtle().sign('HMAC', hmac, buf(data))));
  } finally {
    subkey.fill(0);
  }
}
