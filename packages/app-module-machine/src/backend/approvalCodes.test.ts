import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { APPROVAL_CODES_FILE, APPROVAL_CODES_KEPT, APPROVAL_CODES_RETENTION_SECONDS, listApprovalCodes, parseApprovalCode, recordApprovalCode } from './approvalCodes.js';
import { makeTempDir, removeTempDir } from './tempDir.testUtil.js';

// The security code of an approval, kept so it can be read again after the dialog is closed (the candidacy random is purged by the relay once approved, so the code
// can no longer be recomputed). It is public (derived from two public keys and a random both machines see): no secret is stored, and nothing here widens a right.

const NOW = 1_800_000_000;
const U1 = '0b8a7a52-7f0d-4f0e-8a56-2f0d3a1c9e11';
const U2 = '11111111-1111-4111-8111-111111111111';
const CODE = '12345 67890 12345 67890 12345';
let dir: string;

beforeEach(() => {
  dir = makeTempDir('app-module-machine-codes-');
});
afterEach(() => removeTempDir(dir));

describe('parseApprovalCode', () => {
  it('accepts exactly a uuid, a name and a code in five groups of five digits', () => {
    expect(parseApprovalCode({ uuid: U1, name: 'laptop', code: CODE })).toEqual({ uuid: U1, name: 'laptop', code: CODE });
  });

  it('refuses another shape, naming the rule', () => {
    for (const bad of [undefined, null, [], 'x', {}, { uuid: U1, name: 'laptop' }, { uuid: U1, name: 'laptop', code: CODE, extra: 1 }, { uuid: 'nope', name: 'laptop', code: CODE }, { uuid: U1, name: '', code: CODE }, { uuid: U1, name: 'a'.repeat(65), code: CODE }, { uuid: U1, name: 'bad\nname', code: CODE }, { uuid: U1, name: 'laptop', code: '1234 5678' }, { uuid: U1, name: 'laptop', code: 'abcde 67890 12345 67890 12345' }]) {
      const out = parseApprovalCode(bad);
      expect(typeof out, JSON.stringify(bad)).toBe('string');
      expect(out as string).toMatch(/expected exactly/);
    }
  });
});

describe('recordApprovalCode and listApprovalCodes', () => {
  it('nothing recorded yet: an empty list, no file needed', () => {
    expect(listApprovalCodes(dir, NOW)).toEqual([]);
  });

  it('keeps the code with the name, the uuid and the time, newest first; the same machine approved again replaces its entry', () => {
    recordApprovalCode(dir, { uuid: U1, name: 'laptop', code: CODE }, NOW);
    recordApprovalCode(dir, { uuid: U2, name: 'server', code: '00000 00000 00000 00000 00001' }, NOW + 60);
    expect(listApprovalCodes(dir, NOW + 90).map((e) => [e.name, e.uuid, e.at])).toEqual([['server', U2, NOW + 60], ['laptop', U1, NOW]]);
    recordApprovalCode(dir, { uuid: U1, name: 'laptop', code: '99999 99999 99999 99999 99999' }, NOW + 120);
    const again = listApprovalCodes(dir, NOW + 130);
    expect(again.map((e) => e.name)).toEqual(['laptop', 'server']);
    expect(again[0]?.code).toBe('99999 99999 99999 99999 99999');
  });

  it('forgets an entry after the retention (the candidate had days to confirm), on read and on the next record', () => {
    recordApprovalCode(dir, { uuid: U1, name: 'laptop', code: CODE }, NOW);
    expect(listApprovalCodes(dir, NOW + APPROVAL_CODES_RETENTION_SECONDS - 1)).toHaveLength(1);
    expect(listApprovalCodes(dir, NOW + APPROVAL_CODES_RETENTION_SECONDS)).toEqual([]);
    recordApprovalCode(dir, { uuid: U2, name: 'server', code: CODE }, NOW + APPROVAL_CODES_RETENTION_SECONDS);
    expect(JSON.parse(readFileSync(join(dir, APPROVAL_CODES_FILE), 'utf8')).approvals.map((e: { name: string }) => e.name)).toEqual(['server']);
  });

  it('keeps the newest entries only', () => {
    for (let i = 0; i < APPROVAL_CODES_KEPT + 5; i++) {
      recordApprovalCode(dir, { uuid: `${String(i).padStart(8, '0')}-1111-4111-8111-111111111111`, name: `m${i}`, code: CODE }, NOW + i);
    }
    const list = listApprovalCodes(dir, NOW + 100);
    expect(list).toHaveLength(APPROVAL_CODES_KEPT);
    expect(list[0]?.name).toBe(`m${APPROVAL_CODES_KEPT + 4}`);
  });

  it('stores nothing but the public reminder (no key, no passphrase, no random)', () => {
    recordApprovalCode(dir, { uuid: U1, name: 'laptop', code: CODE }, NOW);
    const stored = JSON.parse(readFileSync(join(dir, APPROVAL_CODES_FILE), 'utf8')) as { v: number; approvals: Array<Record<string, unknown>> };
    expect(stored.v).toBe(1);
    expect(Object.keys(stored.approvals[0] ?? {}).sort()).toEqual(['at', 'code', 'name', 'uuid']);
  });

  it('a damaged file is loud, names the file and the fix, and is never silently replaced', () => {
    writeFileSync(join(dir, APPROVAL_CODES_FILE), '{not json');
    expect(() => listApprovalCodes(dir, NOW)).toThrow(new RegExp(`${APPROVAL_CODES_FILE}.*delete it`, 's'));
    expect(() => recordApprovalCode(dir, { uuid: U1, name: 'laptop', code: CODE }, NOW)).toThrow(/delete it/);
    expect(readFileSync(join(dir, APPROVAL_CODES_FILE), 'utf8')).toBe('{not json');
  });

  it('a file of another shape is damaged too', () => {
    writeFileSync(join(dir, APPROVAL_CODES_FILE), JSON.stringify({ v: 1, approvals: [{ uuid: U1 }] }));
    expect(() => listApprovalCodes(dir, NOW)).toThrow(/delete it/);
  });
});
