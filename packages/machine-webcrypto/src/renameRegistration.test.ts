import { buildRenamedRegistration as coreRename, type RegistrationBody, type RenameRegistrationInput } from '@wadeck-app/machine-core';
import { describe, expect, it } from 'vitest';
import { buildRenamedRegistration } from './renameRegistration.js';

// Rename (decision 114) as the page plans it: a copy of machine-core `buildRenamedRegistration`, tested equal on every refusal and on the success.

const NOW = 1_800_000_000;
const U = '6f1c2d3e-4a5b-4c6d-8e7f-0a1b2c3d4e5f';
const V = '7a1c2d3e-4a5b-4c6d-8e7f-0a1b2c3d4e5f';
const W = '8b1c2d3e-4a5b-4c6d-8e7f-0a1b2c3d4e5f';
const current: RegistrationBody = { v: 1, uuid: U, name: 'thinkcentre', identityPublicKey: 'k'.repeat(43), serial: 7, validFrom: NOW - 100, validTo: NOW + 100_000, adminKeyId: 'a'.repeat(32) };
const base: RenameRegistrationInput = {
  uuid: U, current, newName: 'box', machines: [{ uuid: U, name: 'thinkcentre' }, { uuid: V, name: 'mac-m2' }, { uuid: W, name: 'desk' }], aliases: {}, networkAliases: {}, revokedUpTo: undefined, now: NOW,
};

const cases: Array<[string, RenameRegistrationInput]> = [
  ['success', base],
  ['unknown machine', { ...base, current: undefined }],
  ['other uuid', { ...base, uuid: V }],
  ['revoked', { ...base, revokedUpTo: 7 }],
  ['revoked earlier serial is fine', { ...base, revokedUpTo: 6 }],
  ['expired', { ...base, now: current.validTo + 1 }],
  ['invalid name', { ...base, newName: 'Bad Name' }],
  ['same name', { ...base, newName: 'thinkcentre' }],
  ['name taken', { ...base, newName: 'desk' }],
  ['lookalike', { ...base, newName: 'mac-m-2' }],
  ['local alias of another machine', { ...base, aliases: { box: V } }],
  ['local alias of the same machine', { ...base, aliases: { box: U } }],
  ['network alias of another machine', { ...base, networkAliases: { box: V } }],
  ['network alias of the same machine', { ...base, networkAliases: { box: U.toUpperCase() } }],
];

describe('buildRenamedRegistration (copy of machine-core)', () => {
  it.each(cases)('%s', (_name, input) => {
    expect(buildRenamedRegistration(input)).toEqual(coreRename(input));
  });
  it('keeps the uuid, the key and the expiry, bumps the serial by one and starts now', () => {
    const r = buildRenamedRegistration(base);
    expect(r).toEqual({ ok: true, body: { ...current, name: 'box', serial: 8, validFrom: NOW } });
  });
});

describe('alias refusals name the machine and the real CLI verb (same text as machine-core)', () => {
  it('local alias: machine named, `machine alias rm`, never `machine alias remove`', () => {
    const r = buildRenamedRegistration({ ...base, aliases: { box: V } });
    const message = (r as { message: string }).message;
    expect(message).toContain('is a local alias of another machine "mac-m2" (7a1c2d3e)');
    expect(message).toContain('`machine alias rm box`');
    expect(message).not.toContain('alias remove');
  });
  it('network alias: machine named, and the short id alone when the machine is not listed', () => {
    const named = buildRenamedRegistration({ ...base, networkAliases: { box: W } });
    expect((named as { message: string }).message).toContain('is a network alias of another machine "desk" (8b1c2d3e)');
    const other = '99999999-9999-4999-8999-999999999999';
    const unlisted = { ...base, networkAliases: { box: other } };
    expect((buildRenamedRegistration(unlisted) as { message: string }).message).toContain('is a network alias of another machine (99999999)');
    expect(buildRenamedRegistration(unlisted)).toEqual(coreRename(unlisted));
  });
});
