import { describe, expect, it } from 'vitest';
import { appendAudit, GENESIS_HASH } from './audit.js';
import type { Json } from './canonical.js';
import { DEFAULT_HISTORY_LIMIT, DEFAULT_PENDING_LIMIT, allowCommand, describeHistory, shellQuote, summarizeRequests, type HistoryEntry, type SummarizeOptions } from './requests.js';

const THINK = '11111111-1111-4111-8111-111111111111';
const LAPTOP = '22222222-2222-4222-8222-222222222222';
const T0 = Date.UTC(2026, 10, 20, 12, 0, 0) / 1000;
const iso = (offsetSeconds: number) => new Date((T0 + offsetSeconds) * 1000).toISOString();

/** A real hash-chained log: the lines are built with appendAudit, exactly as the daemon writes them. */
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

const refused = (at: number, source: string, extra: Record<string, Json> = {}): Record<string, Json> => ({
  ts: iso(at), event: 'refused', source, reason: 'not-listed', id: `id-${at}`, shell: 'sh', command: 'ls', ...extra,
});

const names: Record<string, string> = { [THINK]: 'thinkcentre', [LAPTOP]: 'laptop' };
const base = (extra: Partial<SummarizeOptions> = {}): SummarizeOptions => ({ now: T0 + 1000, isAllowed: () => false, nameOf: (uuid) => names[uuid], ...extra });

describe('summarizeRequests: pending', () => {
  it('groups the refused-not-allowed requests by peer, shell and command with count, first and last seen and the name', () => {
    const lines = log([refused(0, THINK), refused(60, THINK), refused(120, THINK), refused(30, THINK, { shell: 'bash' }), refused(40, LAPTOP)]);
    const r = summarizeRequests(lines, base());
    expect(r.chain).toEqual({ ok: true, entries: 5 });
    expect(r.pendingTotal).toBe(3);
    const group = r.pending.find((g) => g.peer === THINK && g.shell === 'sh');
    expect(group).toEqual({ peer: THINK, peerName: 'thinkcentre', shell: 'sh', command: 'ls', count: 3, firstSeen: T0, lastSeen: T0 + 120, reason: 'not-listed' });
    expect(r.pending.find((g) => g.shell === 'bash')?.count).toBe(1);
    expect(r.pending.find((g) => g.peer === LAPTOP)?.peerName).toBe('laptop');
  });

  it('lists the newest group first', () => {
    const r = summarizeRequests(log([refused(0, THINK, { command: 'a' }), refused(100, THINK, { command: 'b' }), refused(50, THINK, { command: 'c' })]), base());
    expect(r.pending.map((g) => g.command)).toEqual(['b', 'c', 'a']);
  });

  it('leaves the name out when it cannot be resolved (a revoked or unknown peer)', () => {
    const r = summarizeRequests(log([refused(0, 'ffffffff-ffff-4fff-8fff-ffffffffffff')]), base());
    expect(r.pending[0]).not.toHaveProperty('peerName');
  });

  it('drops a command that the current policy now allows, and counts it', () => {
    const lines = log([refused(0, THINK, { command: 'ls' }), refused(1, THINK, { command: 'pwd' })]);
    const r = summarizeRequests(lines, base({ isAllowed: (peer, shell, command) => peer === THINK && shell === 'sh' && command === 'ls' }));
    expect(r.pending.map((g) => g.command)).toEqual(['pwd']);
    expect(r.pendingTotal).toBe(1);
    expect(r.allowedNow).toBe(1);
  });

  it('keeps a command refused for lack of a policy, and ignores the other refusals (expired, exhausted, busy, signature...)', () => {
    const lines = log([
      refused(0, THINK, { reason: 'no-policy', command: 'uptime' }),
      refused(1, THINK, { reason: 'expired', command: 'a' }),
      refused(2, THINK, { reason: 'exhausted', command: 'b' }),
      refused(3, THINK, { reason: 'busy', command: 'c' }),
      refused(4, THINK, { reason: 'replay' }),
      { ts: iso(5), event: 'refused', source: THINK, reason: 'bad-signature' },
    ]);
    const r = summarizeRequests(lines, base());
    expect(r.pending.map((g) => [g.command, g.reason])).toEqual([['uptime', 'no-policy']]);
  });

  it('caps the number of groups and says how many there are (T-21)', () => {
    const entries = Array.from({ length: 5 }, (_, i) => refused(i, THINK, { command: `cmd${i}` }));
    const r = summarizeRequests(log(entries), base({ pendingLimit: 2 }));
    expect(r.pending.map((g) => g.command)).toEqual(['cmd4', 'cmd3']);
    expect(r.pendingTotal).toBe(5);
    expect(DEFAULT_PENDING_LIMIT).toBe(100);
  });

  it('shows only printable ASCII: a control sequence in an old log never reaches the terminal', () => {
    const r = summarizeRequests(log([refused(0, THINK, { command: 'ls\u001b[31m\u0007' })]), base());
    expect(r.pending[0]?.command).toBe('ls?[31m?');
  });

  it('is empty on an empty log', () => {
    const r = summarizeRequests([], base());
    expect(r).toMatchObject({ chain: { ok: true, entries: 0 }, pending: [], pendingTotal: 0, history: [], historyTotal: 0, skipped: 0 });
  });
});

describe('summarizeRequests: history', () => {
  const runLog = (): string[] =>
    log([
      { ts: iso(0), event: 'accepted', source: THINK, id: 'r1', shell: 'sh', command: 'ls' },
      { ts: iso(2), event: 'completed', id: 'r1', exitCode: 0, timedOut: false, truncated: false, durationMs: 1500 },
      refused(10, LAPTOP, { reason: 'not-listed', command: 'pwd' }),
      { ts: iso(20), event: 'accepted', source: LAPTOP, id: 'r2', shell: 'sh', command: 'sleep 9' },
      { ts: iso(21), event: 'failed', id: 'r2', error: 'spawn failed' },
      { ts: iso(30), event: 'session-closed', source: THINK, reason: 'too-many-refusals', refusals: 21 },
      { ts: iso(40), event: 'document-accepted', kind: 'policy' },
    ]);

  it('merges an accepted run with its completion (exit code, duration) and keeps the order of the log', () => {
    const r = summarizeRequests(runLog(), base());
    expect(r.history.map((h) => h.kind)).toEqual(['run', 'refused', 'run', 'session', 'document']);
    expect(r.history[0]).toMatchObject({ kind: 'run', at: T0, peer: THINK, peerName: 'thinkcentre', shell: 'sh', command: 'ls', id: 'r1', outcome: 'completed', exitCode: 0, durationMs: 1500, timedOut: false });
    expect(r.history[1]).toMatchObject({ kind: 'refused', peer: LAPTOP, reason: 'not-listed', command: 'pwd' });
    expect(r.history[2]).toMatchObject({ kind: 'run', outcome: 'failed', error: 'spawn failed' });
    expect(r.history[3]).toMatchObject({ kind: 'session', event: 'session-closed', reason: 'too-many-refusals', peer: THINK });
    expect(r.historyTotal).toBe(5);
  });

  it('marks an accepted run that never completed (a crash or a cut)', () => {
    const r = summarizeRequests(log([{ ts: iso(0), event: 'accepted', source: THINK, id: 'x', shell: 'sh', command: 'ls' }]), base());
    expect(r.history[0]).toMatchObject({ kind: 'run', outcome: 'accepted' });
    expect(r.history[0]).not.toHaveProperty('exitCode');
  });

  it('filters by peer', () => {
    const r = summarizeRequests(runLog(), base({ history: { peer: LAPTOP } }));
    expect(r.history.map((h) => h.peer)).toEqual([LAPTOP, LAPTOP]);
  });

  it('filters by kind', () => {
    const r = summarizeRequests(runLog(), base({ history: { kinds: ['refused', 'session'] } }));
    expect(r.history.map((h) => h.kind)).toEqual(['refused', 'session']);
  });

  it('filters by since (epoch seconds, inclusive)', () => {
    const r = summarizeRequests(runLog(), base({ history: { since: T0 + 20 } }));
    expect(r.history.map((h) => h.at)).toEqual([T0 + 20, T0 + 30, T0 + 40]);
  });

  it('keeps the most recent entries under a limit, still in chronological order, and reports the total', () => {
    const r = summarizeRequests(runLog(), base({ history: { limit: 2 } }));
    expect(r.history.map((h) => h.kind)).toEqual(['session', 'document']);
    expect(r.historyTotal).toBe(5);
    expect(DEFAULT_HISTORY_LIMIT).toBe(50);
  });

  it('does not let the pending groups depend on the history filter', () => {
    const r = summarizeRequests(runLog(), base({ history: { peer: THINK } }));
    expect(r.pending.map((g) => g.command)).toEqual(['pwd']);
  });
});

describe('summarizeRequests: chain', () => {
  it('reports a broken chain with its line, keeps the verified part and flags what follows as unverified, never pending', () => {
    const lines = log([refused(0, THINK, { command: 'ls' }), refused(1, THINK, { command: 'pwd' }), refused(2, THINK, { command: 'whoami' })]);
    lines[1] = (lines[1] as string).replace('"pwd"', '"EVIL"');
    const r = summarizeRequests(lines, base());
    expect(r.chain).toMatchObject({ ok: false, line: 2, trustedEntries: 1, unverifiedEntries: 2, unreadableLines: 0 });
    if (!r.chain.ok) expect(r.chain.message).toContain('line 2');
    expect(r.pending.map((g) => g.command)).toEqual(['ls']);
    expect(r.history.map((h) => [h.command, h.verified])).toEqual([['ls', true], ['EVIL', false], ['whoami', false]]);
  });

  it('counts the lines after the break that cannot be read at all', () => {
    const lines = log([refused(0, THINK), refused(1, THINK)]);
    lines.push('{not json');
    lines[1] = 'garbage';
    const r = summarizeRequests(lines, base());
    expect(r.chain).toMatchObject({ ok: false, line: 2, trustedEntries: 1, unverifiedEntries: 0, unreadableLines: 2 });
  });

  it('counts, instead of hiding, a verified entry without a usable time or shape', () => {
    const r = summarizeRequests(log([{ event: 'refused', source: THINK, reason: 'not-listed', shell: 'sh', command: 'ls' }, refused(5, THINK)]), base());
    expect(r.skipped).toBe(1);
    expect(r.pending[0]?.count).toBe(1);
  });
});

describe('shellQuote and allowCommand', () => {
  it('leaves a plain word alone and quotes the rest', () => {
    expect(shellQuote('ls')).toBe('ls');
    expect(shellQuote('df -h')).toBe('"df -h"');
    expect(shellQuote('echo $HOME')).toBe(`'echo $HOME'`);
    expect(shellQuote(`echo "$HOME" 'x'`)).toBe('"echo \\"\\$HOME\\" \'x\'"');
  });

  it('builds the admin command, or the local one in mode local', () => {
    expect(allowCommand({ shell: 'sh', command: 'df -h' }, { name: 'laptop', policyMode: 'admin' })).toBe('machine admin allow laptop --shell sh -- "df -h"');
    expect(allowCommand({ shell: 'sh', command: 'ls' }, { name: 'laptop', policyMode: 'local' })).toBe('machine policy allow --shell sh -- ls');
  });
});

describe('typed entries in the history (typed-parameters.md): the template that matched, the rule that failed', () => {
  it('a refusal carries the local detail, and describeHistory prints it', () => {
    const lines = log([refused(0, THINK, { command: 'orch logs build --tail 9999', detail: 'closest typed entry "orch logs <j:name> --tail <n:int(1,500)>": token 5: int: outside the allowed range' })]);
    const r = summarizeRequests(lines, base());
    expect(r.history[0]).toMatchObject({ kind: 'refused', detail: 'closest typed entry "orch logs <j:name> --tail <n:int(1,500)>": token 5: int: outside the allowed range' });
    expect(describeHistory(r.history[0] as HistoryEntry)).toBe('(not-listed) sh "orch logs build --tail 9999": closest typed entry "orch logs <j:name> --tail <n:int(1,500)>": token 5: int: outside the allowed range');
  });

  it('an accepted run names the template that let it through', () => {
    const lines = log([{ ts: iso(0), event: 'accepted', source: THINK, id: 'r1', shell: 'sh', command: 'orch logs build --tail 5', template: 'orch logs <j:name> --tail <n:int(1,500)>' }, { ts: iso(1), event: 'completed', id: 'r1', exitCode: 0, durationMs: 100 }]);
    const r = summarizeRequests(lines, base());
    expect(r.history[0]).toMatchObject({ kind: 'run', template: 'orch logs <j:name> --tail <n:int(1,500)>' });
    expect(describeHistory(r.history[0] as HistoryEntry)).toBe('sh "orch logs build --tail 5" -> exit 0 in 0.1 s [typed: orch logs <j:name> --tail <n:int(1,500)>]');
  });

  it('an entry without them prints as before', () => {
    const lines = log([refused(0, THINK)]);
    expect(describeHistory(summarizeRequests(lines, base()).history[0] as HistoryEntry)).toBe('(not-listed) sh "ls"');
  });
});

describe('summarizeRequests: waiting (held requests, hold-for-approval)', () => {
  const held = (at: number, id: string, extra: Record<string, Json> = {}): Record<string, Json> => ({ ts: iso(at), event: 'held', source: THINK, id, shell: 'sh', command: 'ls', deadline: T0 + at + 600, waitSeconds: 600, ...extra });
  const ended = (at: number, id: string, outcome = 'allowed'): Record<string, Json> => ({ ts: iso(at), event: 'hold-ended', source: THINK, id, outcome });

  it('lists a held request that has no end and whose deadline is ahead, with its countdown data and the peer name', () => {
    const r = summarizeRequests(log([held(0, 'h1')]), base({ now: T0 + 100 }));
    expect(r.waiting).toEqual([{ id: 'h1', peer: THINK, peerName: 'thinkcentre', shell: 'sh', command: 'ls', since: T0, deadline: T0 + 600 }]);
  });

  it('does not list a hold that ended (allowed, denied, deadline, disconnected)', () => {
    const r = summarizeRequests(log([held(0, 'h1'), ended(10, 'h1', 'denied'), held(20, 'h2')]), base({ now: T0 + 100 }));
    expect(r.waiting.map((w) => w.id)).toEqual(['h2']);
  });

  it('does not list a hold whose deadline passed even when nobody wrote its end (daemon crash)', () => {
    const r = summarizeRequests(log([held(0, 'h1')]), base({ now: T0 + 601 }));
    expect(r.waiting).toEqual([]);
  });

  it('does not list a hold that predates the last start of the daemon (a restart ends every hold)', () => {
    const r = summarizeRequests(log([held(0, 'h1'), { ts: iso(50), event: 'daemon-started' }, held(60, 'h2')]), base({ now: T0 + 100 }));
    expect(r.waiting.map((w) => w.id)).toEqual(['h2']);
  });

  it('lists the soonest deadline first', () => {
    const r = summarizeRequests(log([held(0, 'late', { deadline: T0 + 900 }), held(5, 'soon', { deadline: T0 + 300 })]), base({ now: T0 + 10 }));
    expect(r.waiting.map((w) => w.id)).toEqual(['soon', 'late']);
  });

  it('never lists a hold read after a break of the chain (unverified)', () => {
    const lines = log([held(0, 'h1'), held(1, 'h2')]);
    lines[1] = lines[1]!.replace('h2', 'hX');
    const r = summarizeRequests(lines, base({ now: T0 + 10 }));
    expect(r.waiting.map((w) => w.id)).toEqual(['h1']);
  });

  it('a held request is not a refusal: it makes no pending group until it is refused', () => {
    const r = summarizeRequests(log([held(0, 'h1')]), base({ now: T0 + 10 }));
    expect(r.pendingTotal).toBe(0);
  });

  it('shows the hold events in the history in words', () => {
    const r = summarizeRequests(log([held(0, 'h1'), ended(10, 'h1', 'denied')]), base({ now: T0 + 100, history: { kinds: ['session'] } }));
    const text = r.history.map((h) => describeHistory(h));
    expect(text[0]).toContain('held');
    expect(text[1]).toContain('denied');
  });
});
