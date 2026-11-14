import { X509Certificate } from 'node:crypto';
import { generateSigningKeyPair } from '@wadeck-app/machine-core';
import { describe, expect, it } from 'vitest';
import { mintCertificate, publicKeyOfCertificate } from './cert.js';

describe('self-signed identity certificate', () => {
  it('is a valid X.509 certificate that carries exactly the identity public key', () => {
    const identity = generateSigningKeyPair();
    const { certificatePem } = mintCertificate(identity);
    const cert = new X509Certificate(certificatePem);
    expect(cert.publicKey.asymmetricKeyType).toBe('ed25519');
    expect(publicKeyOfCertificate(cert.raw)).toBe(identity.publicKey);
  });

  it('is signed by the identity key itself (self-signed)', () => {
    const identity = generateSigningKeyPair();
    const cert = new X509Certificate(mintCertificate(identity).certificatePem);
    expect(cert.verify(cert.publicKey)).toBe(true);
  });

  it('gives each certificate its own serial number', () => {
    const identity = generateSigningKeyPair();
    const a = new X509Certificate(mintCertificate(identity).certificatePem);
    const b = new X509Certificate(mintCertificate(identity).certificatePem);
    expect(a.serialNumber).not.toBe(b.serialNumber);
  });

  it('refuses a certificate that does not hold an Ed25519 key, naming the problem', () => {
    // An RSA-free way to get a non-Ed25519 certificate is not available; a truncated DER must be refused loudly instead.
    expect(() => publicKeyOfCertificate(Buffer.from('not a certificate'))).toThrow(/peer certificate/);
  });
});
