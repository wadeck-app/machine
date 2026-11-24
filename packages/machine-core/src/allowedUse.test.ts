import { describe, expect, it } from 'vitest';
import { lastAcceptedUses } from './allowedUse.js';
import type { AllowedListView } from './allowedList.js';

// The last accepted use of each entry of the policy installed here, read from the audit log lines (newest first). Pure, no I/O.

const PEER = '22222222-2222-4222-8222-222222222222';
const OTHER = '33333333-3333-4333-8333-333333333333';
const line = (entry: Record<string, unknown>): string => JSON.stringify({ seq: 0, prev: 'p', hash: 'h', entry });
const accepted = (ts: string, extra: Record<string, unknown>): string => line({ ts, event: 'accepted', source: PEER, id: 'x', shell: 'sh', command: 'ls', ...extra });
const e = (index: number, shell: 'sh' | 'cmd', text: string, typed = false) => ({ index, shell, text, typed, lifetime: 'permanent' });
const lists: AllowedListView[] = [{ scope: 'default', entries: [e(1, 'sh', 'ls'), e(2, 'sh', 'uptime'), e(3, 'sh', 'orch logs <j:name>', true)] }];

describe('lastAcceptedUses', () => {
  it('the newest accepted line of a shell+command gives the entry its last use (epoch seconds); an unused entry has none', () => {
    const r = lastAcceptedUses([accepted('2026-11-20T10:00:00.000Z', {}), accepted('2026-11-10T10:00:00.000Z', {})], lists, 100);
    expect(r.at.get('default:1')).toBe(Date.parse('2026-11-20T10:00:00.000Z') / 1000);
    expect(r.at.has('default:2')).toBe(false);
    expect(r.complete).toBe(true);
  });

  it('a typed entry is matched by the template the audit names, not by the command text', () => {
    const r = lastAcceptedUses([accepted('2026-11-20T10:00:00.000Z', { command: 'orch logs web', template: 'orch logs <j:name>' })], lists, 100);
    expect(r.at.get('default:3')).toBeDefined();
    expect(r.at.has('default:1')).toBe(false);
  });

  it('a peer with a list of its own is matched in that list only (it replaces the default); another peer in the default list', () => {
    const both: AllowedListView[] = [...lists, { scope: 'peer', peer: { uuid: PEER, name: 'laptop' }, entries: [e(1, 'sh', 'ls')] }];
    const r = lastAcceptedUses([accepted('2026-11-20T10:00:00.000Z', {}), accepted('2026-11-19T10:00:00.000Z', { source: OTHER })], both, 100);
    expect(r.at.get(`peer:${PEER}:1`)).toBe(Date.parse('2026-11-20T10:00:00.000Z') / 1000);
    expect(r.at.get('default:1')).toBe(Date.parse('2026-11-19T10:00:00.000Z') / 1000);
  });

  it('refused, completed and damaged lines are not uses; damaged lines are counted', () => {
    const r = lastAcceptedUses([line({ ts: '2026-11-20T10:00:00.000Z', event: 'refused', source: PEER, shell: 'sh', command: 'ls' }), '{ broken', line({ ts: '2026-11-20T10:00:00.000Z', event: 'completed', id: 'x' })], lists, 100);
    expect(r.at.size).toBe(0);
    expect(r.damaged).toBe(1);
  });

  it('stops at the bound and says the scan is not complete (an unused entry is then "not in the last N lines", never "never")', () => {
    const r = lastAcceptedUses([accepted('2026-11-20T10:00:00.000Z', {}), accepted('2026-11-19T10:00:00.000Z', { command: 'uptime' })], lists, 1);
    expect(r.scanned).toBe(1);
    expect(r.complete).toBe(false);
    expect(r.at.has('default:2')).toBe(false);
  });

  it('stops early once every entry has a use, and then the scan is complete for them', () => {
    const small: AllowedListView[] = [{ scope: 'default', entries: [e(1, 'sh', 'ls')] }];
    const r = lastAcceptedUses([accepted('2026-11-20T10:00:00.000Z', {}), 'never read'], small, 100);
    expect(r.scanned).toBe(1);
    expect(r.complete).toBe(true);
  });
});
