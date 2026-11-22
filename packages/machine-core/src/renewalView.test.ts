import { describe, expect, it } from 'vitest';
import { appendAudit, GENESIS_HASH } from './audit.js';
import type { Json } from './canonical.js';
import { HoldTable } from './hold.js';
import { buildRequestNotice, parseRequestNotice } from './requestNotice.js';
import { allowCommand, summarizeRequests, type WaitingRequest } from './requests.js';
import { layoutRequests, type RequestsLayoutInput } from './requestsLayout.js';
import { buildRequestsListAnswer, parseRequestsListAnswer } from './requestsList.js';

// A held request that waits for the RENEWAL of an exhausted or expired entry (hold-for-approval.md, "Renewal"): every surface says so and names the entry.

const PEER = '11111111-1111-4111-8111-111111111111';
const SELF = '22222222-2222-4222-8222-222222222222';
const ID = '3f1c2d3e-4a5b-4c6d-8e7f-0a1b2c3d4e5f';
const T0 = Date.UTC(2026, 10, 20, 12, 0, 0) / 1000;
const iso = (s: number) => new Date((T0 + s) * 1000).toISOString();

const renewal = { reason: 'exhausted' as const, entry: 'orch stop', typed: false, own: false, maxCalls: 1, used: 1, note: 'entry used 1 of 1 call(s)' };

function log(entries: Array<Record<string, Json>>): string[] {
  const lines: string[] = [];
  let prev = GENESIS_HASH;
  entries.forEach((entry, seq) => {
    const r = appendAudit({ prevHash: prev, seq, entry });
    lines.push(r.line);
    prev = r.hash;
  });
  return lines;
}

describe('HoldTable keeps the renewal of a hold', () => {
  it('admit stores it, a plain hold has none', () => {
    const table = new HoldTable();
    const a = table.admit({ id: 'a', peer: PEER, shell: 'sh', command: 'orch stop', now: T0, requestedSeconds: 600, capSeconds: 1800, renewal });
    expect(a.ok && a.hold.renewal).toEqual(renewal);
    const b = table.admit({ id: 'b', peer: PEER, shell: 'sh', command: 'ls', now: T0, requestedSeconds: 600, capSeconds: 1800 });
    expect(b.ok && b.hold.renewal).toBeUndefined();
  });
});

describe('summarizeRequests: a waiting request carries its renewal', () => {
  it('reads it from the held line, bounded and printable', () => {
    const held: Record<string, Json> = { ts: iso(0), event: 'held', source: PEER, id: 'h1', shell: 'sh', command: 'orch stop', deadline: T0 + 600, waitSeconds: 600, renewal: { ...renewal } };
    const r = summarizeRequests(log([held]), { now: T0 + 10, isAllowed: () => false });
    expect(r.waiting[0]).toMatchObject({ id: 'h1', renewal });
  });

  it('a malformed renewal is left out (the request is still waiting, as a plain one)', () => {
    const held: Record<string, Json> = { ts: iso(0), event: 'held', source: PEER, id: 'h1', shell: 'sh', command: 'x', deadline: T0 + 600, renewal: { reason: 'weird' } };
    const r = summarizeRequests(log([held]), { now: T0 + 10, isAllowed: () => false });
    expect(r.waiting).toHaveLength(1);
    expect(r.waiting[0]?.renewal).toBeUndefined();
  });
});

const waiting = (over: Partial<WaitingRequest> = {}): WaitingRequest => ({ id: 'abcdef12-3456-4789-8abc-def012345678', peer: PEER, peerName: 'midgard2', shell: 'sh', command: 'orch stop', since: T0, deadline: T0 + 600, ...over });
const layoutInput = (over: Partial<RequestsLayoutInput> = {}): RequestsLayoutInput => ({
  machine: { name: 'thinkcentre', policyMode: 'admin' },
  remote: false,
  adminKeyHere: true,
  now: T0 + 10,
  waiting: [],
  pending: [],
  pendingTotal: 0,
  allowedNow: 0,
  logPresent: true,
  full: false,
  age: () => '10 s ago',
  ...over,
});

describe('machine requests: the row of a renewal', () => {
  it('says renew and why, names the entry, and the allow command replaces it (--renew)', () => {
    const text = layoutRequests(layoutInput({ waiting: [waiting({ renewal })] })).join('\n');
    expect(text).toContain('renew: entry used 1 of 1 call(s)');
    expect(text).toContain('sh "orch stop"');
    expect(text).toContain('machine admin allow thinkcentre --renew --shell sh --times 1 -- "orch stop"');
  });

  it('an expired entry says when, and asks for the new duration (it cannot guess it)', () => {
    const expired = { reason: 'expired' as const, entry: 'orch stop', typed: false, own: false, expiresAt: T0 - 5, note: `expired at ${iso(-5)}` };
    const text = layoutRequests(layoutInput({ waiting: [waiting({ renewal: expired })] })).join('\n');
    expect(text).toContain(`renew: expired at ${iso(-5)}`);
    expect(text).toContain('--renew --shell sh');
    expect(text).toContain('<duration>');
  });

  it('a typed entry is renewed by its template, not by the command of the request', () => {
    const typed = { reason: 'exhausted' as const, entry: 'orch logs <j:name>', typed: true, own: false, maxCalls: 3, used: 3, note: 'entry used 3 of 3 call(s)' };
    const text = layoutRequests(layoutInput({ waiting: [waiting({ command: 'orch logs abc', renewal: typed })] })).join('\n');
    expect(text).toContain('"orch logs <j:name>"');
  });

  it('no line exceeds the width, ASCII only', () => {
    const lines = layoutRequests(layoutInput({ waiting: [waiting({ renewal })], full: true }));
    expect(Math.max(...lines.map((l) => l.length))).toBeLessThanOrEqual(100);
    expect(lines.every((l) => /^[\x20-\x7e]*$/.test(l))).toBe(true);
  });

  it('allowCommand of a renewal row (local mode: machine policy allow)', () => {
    expect(allowCommand({ shell: 'sh', command: 'orch stop', renewal }, { name: 'thinkcentre', policyMode: 'local' })).toBe('machine policy allow --renew --shell sh --times 1 -- "orch stop"');
  });
});

describe('requests-list answer: the renewal rides the waiting row', () => {
  it('round trip through the strict parser', () => {
    const data = { id: ID, machine: { uuid: SELF, name: 'thinkcentre' }, policyMode: 'admin' as const, now: T0, chain: { ok: true as const }, pendingTotal: 0, allowedNow: 0, waiting: [waiting({ renewal })], pending: [] };
    const answer = buildRequestsListAnswer(data, 100_000);
    const parsed = parseRequestsListAnswer(JSON.parse(JSON.stringify(answer)), ID);
    expect(parsed.ok && parsed.answer.waiting[0]?.renewal).toEqual(renewal);
  });

  it('an answer from a peer without the field reads as a plain request', () => {
    const data = { id: ID, machine: { uuid: SELF, name: 'thinkcentre' }, policyMode: 'admin' as const, now: T0, chain: { ok: true as const }, pendingTotal: 0, allowedNow: 0, waiting: [waiting()], pending: [] };
    const parsed = parseRequestsListAnswer(JSON.parse(JSON.stringify(buildRequestsListAnswer(data, 100_000))), ID);
    expect(parsed.ok && parsed.answer.waiting[0]?.renewal).toBeUndefined();
  });

  it('a malformed renewal is refused loudly (incompatible peer), not silently dropped', () => {
    const data = { id: ID, machine: { uuid: SELF, name: 'thinkcentre' }, policyMode: 'admin' as const, now: T0, chain: { ok: true as const }, pendingTotal: 0, allowedNow: 0, waiting: [waiting({ renewal: { ...renewal, reason: 'weird' as never } })], pending: [] };
    const parsed = parseRequestsListAnswer(JSON.parse(JSON.stringify(buildRequestsListAnswer(data, 100_000))), ID);
    expect(parsed).toMatchObject({ ok: false });
  });
});

describe('request-notice: the renewal of a held request', () => {
  it('is an optional field of the frame, parsed strictly', () => {
    const frame = buildRequestNotice({ id: ID, peer: PEER, peerName: 'agent-box', shell: 'sh', command: 'orch stop', state: 'held', deadline: T0 + 600, now: T0, renewal });
    expect(parseRequestNotice(frame)).toEqual({ ok: true, notice: frame });
    expect((frame as { renewal?: unknown }).renewal).toEqual(renewal);
  });

  it('a plain notice has no such key (older receivers keep reading it)', () => {
    const frame = buildRequestNotice({ id: ID, peer: PEER, peerName: 'agent-box', shell: 'sh', command: 'ls', state: 'held', deadline: T0 + 600, now: T0 });
    expect(Object.keys(frame)).not.toContain('renewal');
  });

  it('refuses a malformed renewal by name', () => {
    const frame = { ...buildRequestNotice({ id: ID, peer: PEER, peerName: 'agent-box', shell: 'sh', command: 'x', state: 'held', deadline: T0 + 600, now: T0 }), renewal: { reason: 'weird' } };
    expect(parseRequestNotice(frame)).toMatchObject({ ok: false, message: expect.stringContaining('renewal') });
  });
});


describe('machine requests: a held notice of another machine that is a renewal', () => {
  it('says renew, names the entry, and the exact allow command carries --renew', () => {
    const frame = buildRequestNotice({ id: ID, peer: PEER, peerName: 'agent-box', shell: 'sh', command: 'orch stop', state: 'held', deadline: T0 + 600, now: T0, renewal });
    const { type: _type, ...rest } = frame;
    const stored = { ...rest, machine: SELF, machineName: 'thinkcentre', receivedAt: T0 };
    const text = layoutRequests(layoutInput({ remote: true, notices: [stored] })).join('\n');
    expect(text).toContain('renew: entry used 1 of 1 call(s)');
    expect(text).toContain('machine admin allow thinkcentre --renew --shell sh --times 1 -- "orch stop"');
  });
});
