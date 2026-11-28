import { describe, expect, it } from 'vitest';
import { appendAudit, GENESIS_HASH } from './audit.js';
import type { Json } from './canonical.js';
import { HoldTable } from './hold.js';
import { summarizeRequests, type WaitingRequest } from './requests.js';
import { layoutRequests, type RequestsLayoutInput } from './requestsLayout.js';
import { inputDigest } from './stdinInput.js';

// A held request that carries a payload on stdin (stdin-input.md, "Held requests", D1): the payload lives in memory only, with the hold;
// the audit line and the listing carry its size and hash, and the owner sees the payload escaped through the daemon.

const NOW = 1_800_000_000;
const PEER = '0a1b2c3d-4e5f-4a6b-9c7d-8e9f0a1b2c3d';
const payload = new TextEncoder().encode('{"op":"get"}');

describe('HoldTable keeps the payload of a held request in memory and lets it go with the hold', () => {
  const admit = (table: HoldTable, id: string, input?: Uint8Array) => table.admit({ id, peer: PEER, shell: 'sh', command: 'task remote-call', now: NOW, requestedSeconds: 600, capSeconds: 1800, ...(input !== undefined ? { input } : {}) });

  it('the hold carries the size and hash, the table the bytes', () => {
    const table = new HoldTable();
    const r = admit(table, 'id-1', payload);
    expect(r.ok && r.hold.input).toEqual(inputDigest(payload));
    expect(Buffer.from(table.inputOf('id-1') as Uint8Array).equals(Buffer.from(payload))).toBe(true);
  });
  it('a hold without payload has none', () => {
    const table = new HoldTable();
    const r = admit(table, 'id-1');
    expect(r.ok && r.hold.input).toBeUndefined();
    expect(table.inputOf('id-1')).toBeUndefined();
  });
  it('the bytes are gone when the hold ends (answered, denied, expired, dropped)', () => {
    const table = new HoldTable();
    admit(table, 'id-1', payload);
    table.end('id-1');
    expect(table.inputOf('id-1')).toBeUndefined();
  });
  it('the memory is bounded by the hold limits times the payload ceiling: a refused admission keeps nothing', () => {
    const table = new HoldTable({ perPeer: 1, perMachine: 1 });
    admit(table, 'a', payload);
    const second = admit(table, 'b', payload);
    expect(second.ok).toBe(false);
    expect(table.inputOf('b')).toBeUndefined();
  });
});

describe('the Requests summary and layout show a held payload', () => {
  const T0 = Date.UTC(2026, 10, 20, 12, 0, 0) / 1000;
  const log = (entries: Array<Record<string, Json>>): string[] => {
    const lines: string[] = [];
    let prev = GENESIS_HASH;
    entries.forEach((entry, seq) => {
      const r = appendAudit({ prevHash: prev, seq, entry });
      lines.push(r.line);
      prev = r.hash;
    });
    return lines;
  };
  const heldLine = (extra: Record<string, Json>): Record<string, Json> => ({ ts: new Date(T0 * 1000).toISOString(), event: 'held', source: PEER, id: 'id-1', shell: 'sh', command: 'task remote-call', deadline: T0 + 600, waitSeconds: 600, ...extra });
  const options = { now: T0 + 100, isAllowed: () => false };

  it('the audit line of a hold carries the size and hash, and the summary hands them on', () => {
    const digest = inputDigest(payload);
    const summary = summarizeRequests(log([heldLine({ input: digest })]), options);
    expect(summary.waiting[0]?.input).toEqual(digest);
  });
  it('an input that is not a size and a hash is dropped, the request is still listed', () => {
    const summary = summarizeRequests(log([heldLine({ input: { bytes: 'x' } })]), options);
    expect(summary.waiting).toHaveLength(1);
    expect(summary.waiting[0]?.input).toBeUndefined();
  });

  const waiting = (over: Partial<WaitingRequest>): WaitingRequest => ({ id: 'abcdef12-3456-4789-8abc-def012345678', peer: PEER, peerName: 'midgard2', shell: 'sh', command: 'task remote-call', since: NOW - 60, deadline: NOW + 540, ...over });
  const layoutInput = (w: WaitingRequest[]): RequestsLayoutInput => ({ machine: { name: 'thinkcentre', policyMode: 'admin' }, remote: false, adminKeyHere: true, now: NOW, waiting: w, pending: [], pendingTotal: 0, allowedNow: 0, logPresent: true, full: false, age: () => 'now' });

  it('shows the escaped payload, its size and hash, and the declaration to allow it', () => {
    const digest = inputDigest(payload);
    const text = layoutRequests(layoutInput([waiting({ input: digest, inputPreview: { text: '{"op":"get"}\\n', cut: false, suggestion: '--stdin json --stdin-chars letters+digits+space' } })])).join('\n');
    expect(text).toContain(`stdin of abcdef12: ${digest.bytes} bytes, sha256 ${digest.sha256.slice(0, 16)}`);
    expect(text).toContain('{"op":"get"}\\n');
    expect(text).toContain('machine admin allow thinkcentre');
    expect(text).toContain('--stdin json --stdin-chars letters+digits+space');
    expect(text.split('\n').every((l) => /^[\x20-\x7e]*$/.test(l))).toBe(true);
  });
  it('says so when the daemon was not asked or does not hold the payload any more (size and hash only)', () => {
    const text = layoutRequests(layoutInput([waiting({ input: inputDigest(payload) })])).join('\n');
    expect(text).toMatch(/stdin of abcdef12: 12 bytes, sha256/);
    expect(text).toMatch(/payload is kept in the memory of the daemon/);
  });
  it('a request without input shows nothing about stdin', () => {
    expect(layoutRequests(layoutInput([waiting({})])).join('\n')).not.toMatch(/stdin/);
  });
});
