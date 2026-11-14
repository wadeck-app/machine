import { describe, expect, it } from 'vitest';
import {
  ADDRESS_RECORD_DOMAIN,
  MAX_ADDRESSES,
  MAX_ADDRESS_RECORD_BYTES,
  advertisedProblem,
  buildAddressRecord,
  destinationProblem,
  hostClass,
  hostProblem,
  parseAddress,
  verifyAddressRecord,
  type AddressRecordBody,
  type SignedAddressRecord,
} from './addressRecord.js';
import { generateSigningKeyPair } from './keys.js';
import { signDocument } from './signed.js';
import type { Json } from './canonical.js';

const UUID = '6f1c2d3e-4a5b-4c6d-8e7f-0a1b2c3d4e5f';
const OTHER_UUID = '0a1b2c3d-4e5f-4a6b-9c7d-8e9f0a1b2c3d';
const NOW = 1_800_000_000;

function setup(overrides: Partial<AddressRecordBody> = {}) {
  const key = generateSigningKeyPair();
  const registered = { uuid: UUID, identityPublicKey: key.publicKey };
  const record = buildAddressRecord({ uuid: UUID, addresses: [{ host: '192.168.1.20', port: 47921 }], seq: 5, issuedAt: NOW, ...overrides }, key.privateKeyPkcs8);
  return { key, registered, record };
}

/** A record signed by `key` over an arbitrary body: what a hostile or buggy machine could publish (buildAddressRecord refuses it). */
function forge(body: unknown, key: { privateKeyPkcs8: Uint8Array }): SignedAddressRecord {
  try {
    return { body: body as AddressRecordBody, signature: signDocument(ADDRESS_RECORD_DOMAIN, body as Json, key.privateKeyPkcs8) };
  } catch {
    // A float cannot be signed at all: the record then carries a made-up signature, and must be refused on its shape.
    return { body: body as AddressRecordBody, signature: 'A'.repeat(86) };
  }
}

describe('address record', () => {
  it('uses its own signature domain', () => {
    expect(ADDRESS_RECORD_DOMAIN).toBe('machine/address-record/v1');
  });

  it('builds a record that verifies against the registered identity key', () => {
    const { registered, record } = setup();
    const r = verifyAddressRecord(record, registered, NOW);
    expect(r).toEqual({ ok: true, body: record.body, signature: record.signature });
  });

  it('serializes to the shape the relay stores (body and signature only)', () => {
    const { record } = setup();
    expect(Object.keys(record).sort()).toEqual(['body', 'signature']);
    expect(Object.keys(record.body).sort()).toEqual(['addresses', 'issuedAt', 'seq', 'uuid', 'v']);
  });

  describe('tampering', () => {
    it.each([
      ['uuid', (r: SignedAddressRecord) => ({ ...r.body, uuid: OTHER_UUID })],
      ['addresses', (r: SignedAddressRecord) => ({ ...r.body, addresses: [{ host: '10.0.0.66', port: 47921 }] })],
      ['port', (r: SignedAddressRecord) => ({ ...r.body, addresses: [{ host: '192.168.1.20', port: 47922 }] })],
      ['seq', (r: SignedAddressRecord) => ({ ...r.body, seq: 6 })],
      ['issuedAt', (r: SignedAddressRecord) => ({ ...r.body, issuedAt: NOW + 1 })],
    ])('refuses a record whose %s was changed after signing', (field, change) => {
      const { registered, record } = setup();
      const tampered = { body: change(record), signature: record.signature };
      const r = verifyAddressRecord(tampered, registered, NOW + 5);
      expect(r.ok).toBe(false);
      // A changed uuid is reported as the mismatch it is, every other change as a bad signature.
      expect(r).toMatchObject({ reason: field === 'uuid' ? 'wrong-uuid' : 'bad-signature' });
    });

    it('refuses a changed signature', () => {
      const { registered, record } = setup();
      const flipped = `${record.signature.slice(0, -2)}${record.signature.endsWith('AA') ? 'BB' : 'AA'}`;
      expect(verifyAddressRecord({ ...record, signature: flipped }, registered, NOW)).toMatchObject({ ok: false, reason: 'bad-signature' });
    });

    it('refuses a record signed by another key, and says which machine it concerns', () => {
      const { record } = setup();
      const other = generateSigningKeyPair();
      const r = verifyAddressRecord(record, { uuid: UUID, identityPublicKey: other.publicKey }, NOW);
      expect(r).toMatchObject({ ok: false, reason: 'bad-signature' });
      expect((r as { message: string }).message).toMatch(/registered identity key/);
    });

    it('refuses a record of another machine (uuid differs from the registration)', () => {
      const { key, record } = setup();
      const r = verifyAddressRecord(record, { uuid: OTHER_UUID, identityPublicKey: key.publicKey }, NOW);
      expect(r).toMatchObject({ ok: false, reason: 'wrong-uuid' });
      expect((r as { message: string }).message).toContain(OTHER_UUID);
    });

    it('is not valid as another document type (domain separation)', () => {
      const { key, registered } = setup();
      const body = { v: 1, uuid: UUID, addresses: [{ host: '192.168.1.20', port: 1 }], seq: 1, issuedAt: NOW };
      const wrongDomain: SignedAddressRecord = { body: body as AddressRecordBody, signature: signDocument('machine/registration/v1', body as Json, key.privateKeyPkcs8) };
      expect(verifyAddressRecord(wrongDomain, registered, NOW)).toMatchObject({ ok: false, reason: 'bad-signature' });
    });

    it('refuses a malformed identity key without throwing', () => {
      const { record } = setup();
      expect(verifyAddressRecord(record, { uuid: UUID, identityPublicKey: 'not-a-key' }, NOW)).toMatchObject({ ok: false, reason: 'bad-signature' });
    });
  });

  describe('shape', () => {
    it.each([
      ['not an object', 'text'],
      ['null', null],
      ['an array', []],
      ['no signature', { body: {} }],
      ['an extra top-level field', 'extra'],
    ])('refuses %s as malformed', (_label, value) => {
      const { key, registered, record } = setup();
      const input = value === 'extra' ? { ...record, more: 1 } : value;
      const r = verifyAddressRecord(input, registered, NOW);
      expect(r).toMatchObject({ ok: false, reason: 'malformed' });
      void key;
    });

    it.each([
      ['unknown field', { extra: 1 }],
      ['version 2', { v: 2 }],
      ['uppercase uuid', { uuid: UUID.toUpperCase() }],
      ['no addresses', { addresses: [] }],
      ['seq zero', { seq: 0 }],
      ['negative seq', { seq: -1 }],
      ['fractional seq', { seq: 1.5 }],
      ['string seq', { seq: '1' }],
      ['issuedAt zero', { issuedAt: 0 }],
      ['address with an extra field', { addresses: [{ host: '10.0.0.1', port: 1, extra: true }] }],
      ['address without port', { addresses: [{ host: '10.0.0.1' }] }],
      ['port zero', { addresses: [{ host: '10.0.0.1', port: 0 }] }],
      ['port 65536', { addresses: [{ host: '10.0.0.1', port: 65536 }] }],
      ['fractional port', { addresses: [{ host: '10.0.0.1', port: 80.5 }] }],
      ['string port', { addresses: [{ host: '10.0.0.1', port: '80' }] }],
    ])('refuses a signed body with %s', (_label, change) => {
      const { key, registered } = setup();
      const body = { v: 1, uuid: UUID, addresses: [{ host: '10.0.0.1', port: 47921 }], seq: 1, issuedAt: NOW, ...change };
      const r = verifyAddressRecord(forge(body, key), registered, NOW);
      expect(r).toMatchObject({ ok: false, reason: 'malformed' });
    });

    it('refuses a missing field', () => {
      const { key, registered } = setup();
      const body = { v: 1, uuid: UUID, addresses: [{ host: '10.0.0.1', port: 1 }], issuedAt: NOW };
      expect(verifyAddressRecord(forge(body, key), registered, NOW)).toMatchObject({ ok: false, reason: 'malformed' });
    });

    it.each(['http://evil.example', 'user@host', 'host/path', 'host name', 'evil.example:80', '', '-bad.example', 'bad-.example', 'a..b', 'fe80::1%eth0', '[::1]', 'a_b.example', 'x'.repeat(64) + '.example', `${'a.'.repeat(130)}com`, 'café.example', '0x7f.1', '1.2.3', '256.1.1.1'])('refuses the host %j (bad host)', (host) => {
      const { key, registered } = setup();
      const body = { v: 1, uuid: UUID, addresses: [{ host, port: 47921 }], seq: 1, issuedAt: NOW };
      const r = verifyAddressRecord(forge(body, key), registered, NOW);
      expect(r).toMatchObject({ ok: false, reason: 'malformed' });
      expect((r as { message: string }).message).toMatch(/host/);
    });

    it.each(['192.168.1.20', '10.0.0.1', '2001:db8::1', '::1', 'desktop', 'desktop.lan', 'my-host.example.com', 'A1.example'])('accepts the host %j', (host) => {
      const { key, registered } = setup();
      const body = { v: 1, uuid: UUID, addresses: [{ host, port: 47921 }], seq: 1, issuedAt: NOW };
      expect(verifyAddressRecord(forge(body, key), registered, NOW)).toMatchObject({ ok: true });
    });

    it(`accepts ${MAX_ADDRESSES} addresses and refuses ${MAX_ADDRESSES + 1}`, () => {
      const { key, registered } = setup();
      const make = (n: number) => ({ v: 1, uuid: UUID, addresses: Array.from({ length: n }, (_, i) => ({ host: `10.0.0.${i + 1}`, port: 47921 })), seq: 1, issuedAt: NOW });
      expect(verifyAddressRecord(forge(make(MAX_ADDRESSES), key), registered, NOW)).toMatchObject({ ok: true });
      const r = verifyAddressRecord(forge(make(MAX_ADDRESSES + 1), key), registered, NOW);
      expect(r).toMatchObject({ ok: false, reason: 'malformed' });
      expect((r as { message: string }).message).toMatch(/at most 8 addresses/);
    });

    it('refuses a record larger than 2 KiB before anything else', () => {
      const { key, registered } = setup();
      // Few addresses but a long (still valid) name each: 8 names of 253 characters exceed 2 KiB.
      const longName = `${'a'.repeat(60)}.${'b'.repeat(60)}.${'c'.repeat(60)}.${'d'.repeat(60)}`;
      const body = { v: 1, uuid: UUID, addresses: Array.from({ length: 8 }, () => ({ host: longName, port: 47921 })), seq: 1, issuedAt: NOW };
      const record = forge(body, key);
      expect(Buffer.byteLength(JSON.stringify(record))).toBeGreaterThan(MAX_ADDRESS_RECORD_BYTES);
      const r = verifyAddressRecord(record, registered, NOW);
      expect(r).toMatchObject({ ok: false, reason: 'too-large' });
      expect((r as { message: string }).message).toMatch(/2048/);
    });

    it('buildAddressRecord refuses to sign what no peer would accept', () => {
      const key = generateSigningKeyPair();
      const base = { uuid: UUID, addresses: [{ host: '10.0.0.1', port: 1 }], seq: 1, issuedAt: NOW };
      expect(() => buildAddressRecord({ ...base, addresses: [] }, key.privateKeyPkcs8)).toThrow(/at least one address/);
      expect(() => buildAddressRecord({ ...base, addresses: [{ host: 'http://x', port: 1 }] }, key.privateKeyPkcs8)).toThrow(/host/);
      expect(() => buildAddressRecord({ ...base, addresses: Array.from({ length: 9 }, () => ({ host: '10.0.0.1', port: 1 })) }, key.privateKeyPkcs8)).toThrow(/at most 8/);
      expect(() => buildAddressRecord({ ...base, seq: 0 }, key.privateKeyPkcs8)).toThrow(/seq/);
    });
  });

  describe('seq (rollback)', () => {
    it('accepts a seq strictly greater than the highest seen', () => {
      const { registered, record } = setup({ seq: 6 });
      expect(verifyAddressRecord(record, registered, NOW, { seq: 5, signature: 'whatever' })).toMatchObject({ ok: true });
    });

    it('refuses a lower seq as a rollback and names both numbers', () => {
      const { registered, record } = setup({ seq: 4 });
      const r = verifyAddressRecord(record, registered, NOW, { seq: 5, signature: 'whatever' });
      expect(r).toMatchObject({ ok: false, reason: 'rollback' });
      expect((r as { message: string }).message).toMatch(/seq 4/);
      expect((r as { message: string }).message).toMatch(/seq 5/);
    });

    it('accepts the same seq with identical bytes (idempotent)', () => {
      const { registered, record } = setup({ seq: 5 });
      expect(verifyAddressRecord(record, registered, NOW, { seq: 5, signature: record.signature })).toMatchObject({ ok: true });
    });

    it('refuses the same seq with other content (two records under one seq)', () => {
      const { key, registered, record } = setup({ seq: 5 });
      const other = buildAddressRecord({ uuid: UUID, addresses: [{ host: '10.9.9.9', port: 47921 }], seq: 5, issuedAt: NOW }, key.privateKeyPkcs8);
      const r = verifyAddressRecord(other, registered, NOW, { seq: 5, signature: record.signature });
      expect(r).toMatchObject({ ok: false, reason: 'same-seq' });
    });

    it('checks the signature before the seq: a forged high seq is a bad signature, not a state change', () => {
      const { registered, record } = setup({ seq: 5 });
      const forged = { body: { ...record.body, seq: 99 }, signature: record.signature };
      expect(verifyAddressRecord(forged, registered, NOW, { seq: 5, signature: record.signature })).toMatchObject({ ok: false, reason: 'bad-signature' });
    });
  });

  describe('time', () => {
    it('accepts issuedAt up to 30 s in the future and refuses 31 s', () => {
      const a = setup({ issuedAt: NOW + 30 });
      expect(verifyAddressRecord(a.record, a.registered, NOW)).toMatchObject({ ok: true });
      const b = setup({ issuedAt: NOW + 31 });
      const r = verifyAddressRecord(b.record, b.registered, NOW);
      expect(r).toMatchObject({ ok: false, reason: 'not-yet-valid' });
      expect((r as { message: string }).message).toMatch(/clock/);
    });

    it('accepts a record 30 days old and refuses one 30 days and 1 s old', () => {
      const day30 = 30 * 86_400;
      const a = setup({ issuedAt: NOW - day30 });
      expect(verifyAddressRecord(a.record, a.registered, NOW)).toMatchObject({ ok: true });
      const b = setup({ issuedAt: NOW - day30 - 1 });
      const r = verifyAddressRecord(b.record, b.registered, NOW);
      expect(r).toMatchObject({ ok: false, reason: 'expired' });
      expect((r as { message: string }).message).toMatch(/30 days/);
    });
  });
});

describe('parseAddress and hostProblem', () => {
  it('accepts host:port, a name and a bracketed IPv6 address', () => {
    expect(parseAddress('127.0.0.1:47921')).toEqual({ host: '127.0.0.1', port: 47921 });
    expect(parseAddress('desktop.lan:80')).toEqual({ host: 'desktop.lan', port: 80 });
    expect(parseAddress('[::1]:47921')).toEqual({ host: '::1', port: 47921 });
    expect(parseAddress('[fe80::1]:1')).toEqual({ host: 'fe80::1', port: 1 });
  });

  it.each(['', 'host', 'host:0', 'host:65536', '::1:80', '[::1]', '[::1]:x', ':80', 'a b:80', 'user@host:80', 'http://host:80', 'host/x:80', '[host]:80'])('refuses %j', (text) => {
    expect(parseAddress(text)).toBeUndefined();
  });

  it('hostProblem says why a host is refused', () => {
    expect(hostProblem('10.0.0.1')).toBeUndefined();
    expect(hostProblem('')).toMatch(/empty/);
    expect(hostProblem('a b')).toMatch(/valid DNS name/);
    expect(hostProblem('fe80::1%eth0')).toMatch(/zone/);
  });
});

describe('numeric-looking hosts (WHATWG "ends in a number")', () => {
  it.each(['0x7f000001', '0x7f.0x1', '1.2.3.0x4', '0x', '0X7F.1', '1.2.3.04', '2130706433', 'a.0x10', 'host.123'])('refuses %j', (host) => {
    expect(hostProblem(host)).toMatch(/number|valid DNS name/);
  });

  it.each(['host1', 'a.b2', '0xabc.example', 'x0x1', '1a.example', '1.2.3.4'])('keeps accepting %j', (host) => {
    expect(hostProblem(host)).toBeUndefined();
  });
});

describe('destinationProblem (where a record of a peer may send this machine)', () => {
  it.each([
    '127.0.0.1', '127.1.2.3', '::1', '0:0:0:0:0:0:0:1', '::ffff:127.0.0.1', '::ffff:7f00:1', '::127.0.0.1',
    '0.0.0.0', '::', '0:0::0', '::ffff:0.0.0.0', '0.1.2.3',
    '169.254.169.254', '169.254.0.1', '::ffff:169.254.169.254', '::ffff:a9fe:a9fe', 'fe80::1', 'FE80::1', 'febf::1:2', 'fe80:0:0:0:1:2:3:4',
    'localhost', 'LOCALHOST', 'localhost.', 'foo.localhost',
  ])('refuses %j with a reason', (host) => {
    const problem = destinationProblem(host);
    expect(problem, host).toMatch(/loopback|unspecified|link-local/);
  });

  it.each(['192.168.1.5', '10.0.0.1', '2001:db8::1', '::ffff:192.168.1.5', 'desktop.lan', 'fe00::1', '128.0.0.1', '169.253.0.1', 'fec0::1', 'localhost.example.com', 'mylocalhost'])('accepts %j', (host) => {
    expect(destinationProblem(host)).toBeUndefined();
  });

  it('classifies without being fooled by case or spelling', () => {
    expect(hostClass('::FFFF:7F00:0001')).toBe('loopback');
    expect(hostClass('0000:0000:0000:0000:0000:0000:0000:0000')).toBe('unspecified');
    expect(hostClass('192.168.1.1')).toBe('other');
    expect(hostClass('Desktop.LAN')).toBe('other');
  });

  it('advertisedProblem refuses only the unspecified addresses (a tunnel or a loopback redirect is the user choice)', () => {
    expect(advertisedProblem('0.0.0.0')).toMatch(/unspecified/);
    expect(advertisedProblem('::')).toMatch(/unspecified/);
    expect(advertisedProblem('::ffff:0.0.0.0')).toMatch(/unspecified/);
    expect(advertisedProblem('127.0.0.1')).toBeUndefined();
    expect(advertisedProblem('203.0.113.9')).toBeUndefined();
  });
});
