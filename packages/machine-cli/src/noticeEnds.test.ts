import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MAX_NOTICE_ENDS, findNoticeEnd, noticeEndsFile, readNoticeEnds, recordNoticeEndOutcome } from './noticeEnds.js';
import { recordNoticeEnd } from './noticesStore.js';

// How a hold ended (decision 86, progress after Allow): the target tells the admin machine in `request-notice-end`; the page asks for it every 2 s.
// Information only (never a right), bounded, no secret: ids, outcomes, dates.

const MACHINE = '0a1b2c3d-4e5f-4a6b-9c7d-8e9f0a1b2c3d';
const OTHER = '1b2c3d4e-5f6a-4b7c-8d9e-9f0a1b2c3d4e';
const NOW = 1_800_000_000;
const id = (n: number) => `3f1c2d3e-4a5b-4c6d-8e7f-${String(n).padStart(12, '0')}`;
const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'notice-ends-'));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('notice ends', () => {
  it('no file: none, and nothing is found', () => {
    const dir = tmp();
    expect(readNoticeEnds(dir)).toEqual([]);
    expect(findNoticeEnd(dir, MACHINE, id(1))).toBeUndefined();
  });

  it('records the outcome of a hold with the machine that ended it, and finds it by machine and id', () => {
    const dir = tmp();
    recordNoticeEndOutcome(dir, { machine: MACHINE, id: id(1), outcome: 'allowed', at: NOW }, NOW);
    recordNoticeEndOutcome(dir, { machine: OTHER, id: id(1), outcome: 'denied', at: NOW }, NOW);
    expect(findNoticeEnd(dir, MACHINE, id(1))).toEqual({ machine: MACHINE, id: id(1), outcome: 'allowed', at: NOW });
    expect(findNoticeEnd(dir, OTHER, id(1))?.outcome).toBe('denied');
    expect(findNoticeEnd(dir, MACHINE, id(2))).toBeUndefined();
  });

  it('the same hold ended again replaces the first record (no duplicate)', () => {
    const dir = tmp();
    recordNoticeEndOutcome(dir, { machine: MACHINE, id: id(1), outcome: 'deadline', at: NOW }, NOW);
    recordNoticeEndOutcome(dir, { machine: MACHINE, id: id(1), outcome: 'allowed', at: NOW + 1 }, NOW + 1);
    expect(readNoticeEnds(dir)).toHaveLength(1);
    expect(findNoticeEnd(dir, MACHINE, id(1))?.outcome).toBe('allowed');
  });

  it('is bounded: the newest are kept', () => {
    const dir = tmp();
    for (let i = 0; i < MAX_NOTICE_ENDS + 5; i++) recordNoticeEndOutcome(dir, { machine: MACHINE, id: id(i), outcome: 'allowed', at: NOW + i }, NOW + i);
    expect(readNoticeEnds(dir)).toHaveLength(MAX_NOTICE_ENDS);
    expect(findNoticeEnd(dir, MACHINE, id(0))).toBeUndefined();
    expect(findNoticeEnd(dir, MACHINE, id(MAX_NOTICE_ENDS + 4))).toBeDefined();
  });

  it('forgets what is older than a day', () => {
    const dir = tmp();
    recordNoticeEndOutcome(dir, { machine: MACHINE, id: id(1), outcome: 'allowed', at: NOW }, NOW);
    recordNoticeEndOutcome(dir, { machine: MACHINE, id: id(2), outcome: 'allowed', at: NOW + 86_401 }, NOW + 86_401);
    expect(readNoticeEnds(dir).map((e) => e.id)).toEqual([id(2)]);
  });

  it('a damaged file is refused loudly, with the file and the fix', () => {
    const dir = tmp();
    writeFileSync(noticeEndsFile(dir), '{not json');
    expect(() => readNoticeEnds(dir)).toThrow(/notice-ends\.json.*Delete it/);
    writeFileSync(noticeEndsFile(dir), JSON.stringify({ v: 1, ends: [{ machine: 'x', id: 'y', outcome: 'allowed', at: 1 }] }));
    expect(() => readNoticeEnds(dir)).toThrow(/notice-ends\.json/);
  });

  it('refuses an outcome that is not one of the known ones, never stores it', () => {
    const dir = tmp();
    expect(() => recordNoticeEndOutcome(dir, { machine: MACHINE, id: id(1), outcome: 'maybe' as never, at: NOW }, NOW)).toThrow(/outcome/);
  });

  it('stores nothing secret: only machine, id, outcome and date', () => {
    const dir = tmp();
    recordNoticeEndOutcome(dir, { machine: MACHINE, id: id(1), outcome: 'allowed', at: NOW }, NOW);
    expect(Object.keys(JSON.parse(readFileSync(noticeEndsFile(dir), 'utf8')).ends[0]).sort()).toEqual(['at', 'id', 'machine', 'outcome']);
  });

  it('recordNoticeEnd (the frame of a peer) keeps the outcome when it is given', () => {
    const dir = tmp();
    recordNoticeEnd(dir, MACHINE, id(1), NOW, 'allowed');
    expect(findNoticeEnd(dir, MACHINE, id(1))).toMatchObject({ outcome: 'allowed', at: NOW });
  });
});
