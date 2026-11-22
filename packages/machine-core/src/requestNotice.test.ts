import { describe, expect, it } from 'vitest';
import {
  MAX_NOTICES,
  MAX_NOTICE_AGE_SECONDS,
  MAX_NOTICE_FRAME_BYTES,
  applyNotice,
  buildRequestNotice,
  buildRequestNoticeEnd,
  endNotice,
  parseRequestNotice,
  parseRequestNoticeEnd,
  visibleNotices,
  type StoredNotice,
} from './requestNotice.js';

const ID = '3f1c2d3e-4a5b-4c6d-8e7f-0a1b2c3d4e5f';
const PEER = '6f1c2d3e-4a5b-4c6d-8e7f-0a1b2c3d4e5f';
const SENDER = '0a1b2c3d-4e5f-4a6b-9c7d-8e9f0a1b2c3d';
const NOW = 1_800_000_000;

const held = () => buildRequestNotice({ id: ID, peer: PEER, peerName: 'agent-box', shell: 'sh', command: 'systemctl restart nginx', state: 'held', deadline: NOW + 600, now: NOW });

describe('request-notice frame', () => {
  it('builds a small frame and parses it back', () => {
    const frame = held();
    expect(Buffer.byteLength(JSON.stringify(frame))).toBeLessThan(MAX_NOTICE_FRAME_BYTES);
    expect(parseRequestNotice(frame)).toEqual({ ok: true, notice: frame });
  });

  it('carries the ask of the caller (held notices) and refuses an invalid one, naming the field', () => {
    const frame = buildRequestNotice({ id: ID, peer: PEER, peerName: 'agent-box', shell: 'sh', command: 'ls', state: 'held', deadline: NOW + 600, now: NOW, ask: { times: 2, why: 'rerun' } });
    expect(parseRequestNotice(frame)).toEqual({ ok: true, notice: frame });
    expect(parseRequestNotice({ ...frame, ask: { times: 0 } })).toMatchObject({ ok: false, message: expect.stringContaining('ask') });
    expect(parseRequestNotice({ ...frame, ask: { colour: 'red' } })).toMatchObject({ ok: false });
  });

  it('a refused request has no deadline', () => {
    const frame = buildRequestNotice({ id: ID, peer: PEER, peerName: 'agent-box', shell: 'sh', command: 'ls', state: 'refused', deadline: null, now: NOW });
    expect(parseRequestNotice(frame)).toMatchObject({ ok: true });
  });

  it('refuses unknown fields, a bad state, control and non-ASCII characters in the command, and an oversized frame, naming the field', () => {
    const base = held() as unknown as Record<string, unknown>;
    const bad = (patch: Record<string, unknown>) => parseRequestNotice({ ...base, ...patch });
    expect(bad({ extra: 1 })).toMatchObject({ ok: false, message: expect.stringContaining('unknown field "extra"') });
    expect(bad({ state: 'weird' })).toMatchObject({ ok: false, message: expect.stringContaining('state') });
    expect(bad({ command: 'echo \u001b[31mred' })).toMatchObject({ ok: false, message: expect.stringContaining('command') });
    expect(bad({ command: 'café' })).toMatchObject({ ok: false });
    expect(bad({ command: 'x'.repeat(5000) })).toMatchObject({ ok: false });
    expect(bad({ id: 'not-a-uuid' })).toMatchObject({ ok: false, message: expect.stringContaining('id') });
    expect(bad({ peerName: 'a b\nc' })).toMatchObject({ ok: false, message: expect.stringContaining('peerName') });
    expect(bad({ shell: 'zsh' })).toMatchObject({ ok: false, message: expect.stringContaining('shell') });
    expect(bad({ state: 'held', deadline: null })).toMatchObject({ ok: false, message: expect.stringContaining('deadline') });
    expect(parseRequestNotice('nope')).toMatchObject({ ok: false });
  });

  it('truncates a command that would not fit and says so with a flag', () => {
    const frame = buildRequestNotice({ id: ID, peer: PEER, peerName: 'a', shell: 'sh', command: `${'x'.repeat(2048)}y`, state: 'held', deadline: NOW + 1, now: NOW });
    expect(frame.commandTruncated).toBe(true);
    expect(frame.command.length).toBe(2048);
    expect(Buffer.byteLength(JSON.stringify(frame))).toBeLessThan(MAX_NOTICE_FRAME_BYTES);
  });

  it('the end frame names the request and a known outcome', () => {
    const end = buildRequestNoticeEnd({ id: ID, outcome: 'allowed', now: NOW });
    expect(parseRequestNoticeEnd(end)).toMatchObject({ ok: true, end });
    expect(parseRequestNoticeEnd({ ...end, outcome: 'maybe' })).toMatchObject({ ok: false });
    expect(parseRequestNoticeEnd({ ...end, command: 'x' })).toMatchObject({ ok: false });
  });
});

describe('notices store logic', () => {
  const stored = (n: number, receivedAt: number): StoredNotice => {
    const { type: _type, ...rest } = held();
    return { ...rest, machine: SENDER, machineName: 'thinkcentre', receivedAt, id: `3f1c2d3e-4a5b-4c6d-8e7f-${String(n).padStart(12, '0')}` };
  };

  it('upserts by (machine, id)', () => {
    const first = applyNotice([], stored(1, NOW), NOW);
    const again = applyNotice(first, { ...stored(1, NOW + 5), command: 'changed' }, NOW + 5);
    expect(again).toHaveLength(1);
    expect(again[0]?.command).toBe('changed');
  });

  it('keeps the 200 newest and drops entries older than 7 days', () => {
    let list: StoredNotice[] = [];
    for (let i = 0; i < MAX_NOTICES + 5; i++) {
      list = applyNotice(list, stored(i, NOW + i), NOW + i);
    }
    expect(list).toHaveLength(MAX_NOTICES);
    expect(list.some((n) => n.id.endsWith('000000000000'))).toBe(false);
    const later = NOW + MAX_NOTICE_AGE_SECONDS + 1000;
    expect(applyNotice(list, stored(999, later), later)).toHaveLength(1);
  });

  it('endNotice removes the matching one only', () => {
    const list = applyNotice(applyNotice([], stored(1, NOW), NOW), stored(2, NOW), NOW);
    const next = endNotice(list, SENDER, stored(1, NOW).id);
    expect(next.map((n) => n.id)).toEqual([stored(2, NOW).id]);
    expect(endNotice(list, PEER, stored(1, NOW).id)).toHaveLength(2);
  });

  it('visibleNotices hides a held notice whose deadline passed, newest first', () => {
    const live = stored(1, NOW);
    const stale = { ...stored(2, NOW + 1), deadline: NOW + 10 };
    expect(visibleNotices([live, stale], NOW + 100).map((n) => n.id)).toEqual([live.id]);
    const refused = { ...stored(3, NOW + 2), state: 'refused' as const, deadline: null };
    expect(visibleNotices([live, refused], NOW + 100).map((n) => n.id)).toEqual([refused.id, live.id]);
  });
});
