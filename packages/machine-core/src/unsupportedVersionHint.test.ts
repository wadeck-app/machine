import { describe, expect, it } from 'vitest';
import { assertAddressRecordBody } from './addressRecord.js';
import { assertRegistrationBody } from './registration.js';
import { assertRevocationBody } from './revocation.js';

// A document of a newer build carries a higher version: the only fix is to update the machine that reads it.
describe('an unsupported document version names the fix (U20)', () => {
  const hint = /unsupported version 2 \(this build reads version 1\).*machine cli update/;

  it('address record', () => {
    expect(() => assertAddressRecordBody({ v: 2, uuid: 'x', addresses: [], seq: 1, issuedAt: 1 })).toThrow(hint);
  });

  it('registration', () => {
    const body = { v: 2, uuid: 'x', name: 'x', identityPublicKey: 'x', serial: 1, validFrom: 0, validTo: 1, adminKeyId: 'x' };
    expect(() => assertRegistrationBody(body)).toThrow(hint);
  });

  it('revocation', () => {
    expect(() => assertRevocationBody({ v: 2, entries: [] })).toThrow(hint);
  });
});
