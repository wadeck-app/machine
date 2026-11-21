import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { holdingOf, MAX_SENT_MACHINES, noticeSentFile, readNoticeSent, recordNoticeConfirmed, recordNoticeSent } from './noticeRecipientsSent.js';

const A = '6f1c2d3e-4a5b-4c6d-8e7f-0a1b2c3d4e5f';
const B = '0a1b2c3d-4e5f-4a6b-9c7d-8e9f0a1b2c3d';
const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'nrs-'));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('what the admin machine sent, and what each machine confirmed', () => {
  it('no file: nothing is known', () => {
    expect(readNoticeSent(tmp())).toEqual({});
  });

  it('records the last send per machine (serial, time, stored by the relay or not) and the last confirmation', () => {
    const dir = tmp();
    recordNoticeSent(dir, A, { serial: 10, at: 100, stored: true });
    recordNoticeSent(dir, A, { serial: 11, at: 200, stored: false });
    recordNoticeConfirmed(dir, B, { serial: null, at: 300 });
    recordNoticeConfirmed(dir, A, { serial: 10, at: 400 });
    expect(readNoticeSent(dir)).toEqual({
      [A]: { sent: { serial: 11, at: 200, stored: false }, confirmed: { serial: 10, at: 400 } },
      [B]: { confirmed: { serial: null, at: 300 } },
    });
  });

  it('stays bounded: the oldest machines are dropped past the cap', () => {
    const dir = tmp();
    for (let i = 0; i < MAX_SENT_MACHINES + 5; i++) {
      recordNoticeSent(dir, `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`, { serial: 1, at: 1000 + i, stored: true });
    }
    const all = readNoticeSent(dir);
    expect(Object.keys(all)).toHaveLength(MAX_SENT_MACHINES);
    expect(all['00000000-0000-4000-8000-000000000000']).toBeUndefined();
    expect(all[`00000000-0000-4000-8000-${String(MAX_SENT_MACHINES + 4).padStart(12, '0')}`]).toBeDefined();
  });

  it('a damaged file stops the reader with its path and the fix (it is only a record: delete it)', () => {
    const dir = tmp();
    writeFileSync(noticeSentFile(dir), '{not json');
    expect(() => readNoticeSent(dir)).toThrow(/notice-recipients-sent\.json.*Delete it/);
    expect(() => recordNoticeSent(dir, A, { serial: 1, at: 1, stored: true })).toThrow(/notice-recipients-sent\.json/);
  });
});

describe('what a machine holds, from the record and the current list', () => {
  const current = 100;
  it('confirmed with the current serial: has it', () => {
    expect(holdingOf(current, { confirmed: { serial: 100, at: 5 } })).toEqual({ state: 'current', serial: 100, at: 5 });
  });
  it('confirmed with a higher serial (another admin machine signed a newer list): has a newer one', () => {
    expect(holdingOf(current, { confirmed: { serial: 150, at: 5 } })).toMatchObject({ state: 'newer', serial: 150 });
  });
  it('sent and stored, not confirmed since: sent, not confirmed', () => {
    expect(holdingOf(current, { sent: { serial: 100, at: 50, stored: true } })).toEqual({ state: 'sent', at: 50 });
    expect(holdingOf(current, { sent: { serial: 100, at: 50, stored: true }, confirmed: { serial: 90, at: 40 } })).toEqual({ state: 'sent', at: 50 });
  });
  it('sent, then asked: the answer wins when it is more recent than the send', () => {
    expect(holdingOf(current, { sent: { serial: 100, at: 50, stored: true }, confirmed: { serial: 90, at: 60 } })).toEqual({ state: 'older', serial: 90, at: 60 });
    expect(holdingOf(current, { sent: { serial: 100, at: 50, stored: true }, confirmed: { serial: null, at: 60 } })).toEqual({ state: 'none', at: 60 });
  });
  it('the last send failed: said as such', () => {
    expect(holdingOf(current, { sent: { serial: 100, at: 50, stored: false } })).toEqual({ state: 'send-failed', at: 50 });
  });
  it('confirmed an older list, nothing sent since: has an older list', () => {
    expect(holdingOf(current, { confirmed: { serial: 90, at: 5 } })).toEqual({ state: 'older', serial: 90, at: 5 });
  });
  it('a send of an older list does not count for the current one', () => {
    expect(holdingOf(current, { sent: { serial: 90, at: 50, stored: true } })).toEqual({ state: 'unknown' });
  });
  it('nothing known: unknown', () => {
    expect(holdingOf(current, undefined)).toEqual({ state: 'unknown' });
  });
});
