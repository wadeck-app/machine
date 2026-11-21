import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MAX_NOTICES, buildRequestNotice, type StoredNotice } from '@wadeck-app/machine-core';
import { noticesFile, readNotices, recordNotice, recordNoticeEnd } from './noticesStore.js';

const SENDER = '0a1b2c3d-4e5f-4a6b-9c7d-8e9f0a1b2c3d';
const NOW = 1_800_000_000;
const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'notices-'));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) {
    rmSync(d, { recursive: true, force: true });
  }
});

const notice = (n: number, receivedAt = NOW): StoredNotice => {
  const { type: _type, ...rest } = buildRequestNotice({
    id: `3f1c2d3e-4a5b-4c6d-8e7f-${String(n).padStart(12, '0')}`,
    peer: '6f1c2d3e-4a5b-4c6d-8e7f-0a1b2c3d4e5f',
    peerName: 'agent-box',
    shell: 'sh',
    command: `echo ${n}`,
    state: 'held',
    deadline: receivedAt + 600,
    now: receivedAt,
  });
  return { ...rest, machine: SENDER, machineName: 'thinkcentre', receivedAt };
};

describe('notices store', () => {
  it('no file: no notices', () => {
    expect(readNotices(tmp())).toEqual([]);
  });

  it('records, reads back, and ends a notice', () => {
    const dir = tmp();
    recordNotice(dir, notice(1), NOW);
    recordNotice(dir, notice(2), NOW + 1);
    expect(readNotices(dir).map((n) => n.command)).toEqual(['echo 1', 'echo 2']);
    recordNoticeEnd(dir, SENDER, notice(1).id, NOW + 2);
    expect(readNotices(dir).map((n) => n.command)).toEqual(['echo 2']);
  });

  it('is bounded: 200 newest', () => {
    const dir = tmp();
    for (let i = 0; i < MAX_NOTICES + 3; i++) {
      recordNotice(dir, notice(i, NOW + i), NOW + i);
    }
    expect(readNotices(dir)).toHaveLength(MAX_NOTICES);
  });

  it('a damaged file is refused loudly with the path and the fix, for the reader and for the writer', () => {
    const dir = tmp();
    writeFileSync(noticesFile(dir), '{nope');
    expect(() => readNotices(dir)).toThrow(/notices\.json.*Delete it/s);
    expect(() => recordNotice(dir, notice(1), NOW)).toThrow(/notices\.json.*Delete it/s);
    writeFileSync(noticesFile(dir), JSON.stringify({ v: 1, notices: [{ id: 'x' }] }));
    expect(() => readNotices(dir)).toThrow(/Delete it/);
  });

  it('writes only the declared fields (a stored notice carries no secret and no extra data)', () => {
    const dir = tmp();
    recordNotice(dir, { ...notice(1), extra: 'x' } as StoredNotice, NOW);
    expect(Object.keys(JSON.parse(readFileSync(noticesFile(dir), 'utf8')).notices[0]).sort()).toEqual(
      ['command', 'commandTruncated', 'deadline', 'id', 'machine', 'machineName', 'peer', 'peerName', 'receivedAt', 'shell', 'state', 'ts'].sort(),
    );
  });
});
