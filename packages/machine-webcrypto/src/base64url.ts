// Unpadded base64url written by hand (no Node-only or legacy browser API): the same strict rules as machine-core (no padding, no other alphabet,
// no non-zero trailing bits), so one value has exactly one spelling.

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const LOOKUP: Record<string, number> = Object.fromEntries(Array.from(ALPHABET, (c, i) => [c, i]));

export function encodeBase64url(data: Uint8Array): string {
  let out = '';
  for (let i = 0; i < data.length; i += 3) {
    const b0 = data[i] as number;
    const b1 = data[i + 1];
    const b2 = data[i + 2];
    out += ALPHABET[b0 >> 2];
    out += ALPHABET[((b0 & 3) << 4) | ((b1 ?? 0) >> 4)];
    if (b1 !== undefined) out += ALPHABET[((b1 & 15) << 2) | ((b2 ?? 0) >> 6)];
    if (b2 !== undefined) out += ALPHABET[b2 & 63];
  }
  return out;
}

/** Decodes any length; refuses every spelling that is not the canonical one. `label` names the value in the error. */
export function decodeBase64urlAny(text: unknown, label: string): Uint8Array {
  if (typeof text !== 'string') throw new Error(`${label} must be unpadded base64url text (got a ${typeof text})`);
  if (!/^[A-Za-z0-9_-]*$/.test(text) || text.length % 4 === 1) {
    throw new Error(`${label} must be unpadded base64url; this string is not the canonical encoding (padding, wrong alphabet or wrong length)`);
  }
  const out = new Uint8Array(Math.floor((text.length * 6) / 8));
  let bits = 0;
  let acc = 0;
  let n = 0;
  for (const c of text) {
    acc = (acc << 6) | (LOOKUP[c] as number);
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[n++] = (acc >> bits) & 255;
      acc &= (1 << bits) - 1;
    }
  }
  if (acc !== 0) throw new Error(`${label} must be unpadded base64url; this string is not the canonical encoding (non-zero trailing bits)`);
  return out;
}

export function decodeBase64urlStrict(text: unknown, expectedBytes: number, label: string): Uint8Array {
  if (typeof text !== 'string') throw new Error(`${label} must be ${expectedBytes} bytes as unpadded base64url (got a ${typeof text})`);
  let bytes: Uint8Array;
  try {
    bytes = decodeBase64urlAny(text, label);
  } catch {
    throw new Error(`${label} must be ${expectedBytes} bytes as unpadded base64url; this string is not the canonical encoding`);
  }
  if (bytes.length !== expectedBytes) throw new Error(`${label} must be ${expectedBytes} bytes as unpadded base64url (got ${bytes.length} bytes)`);
  return bytes;
}
