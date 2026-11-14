import { X509Certificate, createPrivateKey, randomBytes, sign } from 'node:crypto';
import type { SigningKeyPair } from '@wadeck-app/machine-core';

// Node has no API to create an X.509 certificate, so this is a minimal DER encoder for ONE shape: a self-signed
// Ed25519 certificate whose only purpose is to carry the identity public key through TLS. Trust never comes from the
// certificate (no CA, no validity, no name): the peer is accepted only if its key matches an admin-signed registration.

const SPKI_ED25519_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
const OID_ED25519 = Buffer.from('2b6570', 'hex');
const OID_COMMON_NAME = Buffer.from('550403', 'hex');

function length(n: number): Buffer {
  if (n < 0x80) return Buffer.from([n]);
  if (n < 0x100) return Buffer.from([0x81, n]);
  return Buffer.from([0x82, n >> 8, n & 0xff]);
}

function tlv(tag: number, ...parts: Buffer[]): Buffer {
  const body = Buffer.concat(parts);
  return Buffer.concat([Buffer.from([tag]), length(body.length), body]);
}

function utcTime(date: Date): Buffer {
  return tlv(0x17, Buffer.from(`${date.toISOString().replace(/[-:T]/g, '').slice(2, 14)}Z`));
}

function distinguishedName(commonName: string): Buffer {
  return tlv(0x30, tlv(0x31, tlv(0x30, tlv(0x06, OID_COMMON_NAME), tlv(0x0c, Buffer.from(commonName)))));
}

export interface MintedCertificate {
  certificatePem: string;
  privateKeyPem: string;
}

export function mintCertificate(identity: SigningKeyPair, options: { now?: Date } = {}): MintedCertificate {
  const privateKey = createPrivateKey({ key: Buffer.from(identity.privateKeyPkcs8), format: 'der', type: 'pkcs8' });
  const publicKeyDer = Buffer.concat([SPKI_ED25519_PREFIX, Buffer.from(identity.publicKey, 'base64url')]);
  const now = options.now ?? new Date();
  // Validity is not a trust input here (pinning is); a wide window avoids spurious expiry failures on machines with a wrong clock.
  const notBefore = new Date(now.getTime() - 86_400_000);
  const notAfter = new Date(now.getTime() + 3650 * 86_400_000);
  // Positive 8-byte serial: clear the top bit so the DER INTEGER stays positive.
  const serial = randomBytes(8);
  serial[0] = (serial[0] as number) & 0x7f;
  const algorithm = tlv(0x30, tlv(0x06, OID_ED25519));
  const name = distinguishedName('machine');
  const tbs = tlv(0x30, tlv(0xa0, tlv(0x02, Buffer.from([2]))), tlv(0x02, serial), algorithm, name, tlv(0x30, utcTime(notBefore), utcTime(notAfter)), name, publicKeyDer);
  const signature = sign(null, tbs, privateKey);
  const der = tlv(0x30, tbs, algorithm, tlv(0x03, Buffer.concat([Buffer.from([0]), signature])));
  const pem = (label: string, body: Buffer) => `-----BEGIN ${label}-----\n${(body.toString('base64').match(/.{1,64}/g) ?? []).join('\n')}\n-----END ${label}-----\n`;
  return {
    certificatePem: pem('CERTIFICATE', der),
    privateKeyPem: pem('PRIVATE KEY', Buffer.from(identity.privateKeyPkcs8)),
  };
}

/** Raw Ed25519 public key (unpadded base64url) of a DER certificate received from a peer. Throws if it is anything else. */
export function publicKeyOfCertificate(der: Buffer): string {
  try {
    const key = new X509Certificate(der).publicKey;
    if (key.asymmetricKeyType !== 'ed25519') throw new Error(`key type is ${String(key.asymmetricKeyType)}, expected ed25519`);
    const x = key.export({ format: 'jwk' }).x;
    if (typeof x !== 'string') throw new Error('no raw public key');
    return x;
  } catch (e) {
    throw new Error(`peer certificate is not an Ed25519 certificate (${(e as Error).message})`);
  }
}
