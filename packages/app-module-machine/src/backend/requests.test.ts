import { appendAudit, GENESIS_HASH, summarizeRequests, type Json } from '@wadeck-app/machine-core';
import { describe, expect, it } from 'vitest';
import { remoteRequestsPage, requestsPage, RequestsAnswerError } from './requests.js';

const PEER = '11111111-1111-4111-8111-111111111111';
const SELF = '22222222-2222-4222-8222-222222222222';
const NOW = Math.floor(Date.UTC(2026, 10, 20, 22, 0, 0) / 1000);
const iso = (offset: number) => new Date((NOW + offset) * 1000).toISOString();

/** A real hash-chained log, the lines the daemon writes. */
function lines(entries: Array<Record<string, Json>>): string[] {
  const out: string[] = [];
  let prev = GENESIS_HASH;
  entries.forEach((entry, seq) => {
    const r = appendAudit({ prevHash: prev, seq, entry });
    out.push(r.line);
    prev = r.hash;
  });
  return out;
}

const refusal = (offset: number, command: string): Record<string, Json> => ({ ts: iso(offset), event: 'refused', source: PEER, reason: 'not-listed', id: `i${offset}`, shell: 'sh', command });

/** What the daemon command `requests` answers (the same reader as the CLI), through JSON like the real HTTP call. */
function daemonAnswer(audit: string[], over: Record<string, unknown> = {}): unknown {
  const summary = summarizeRequests(audit, { now: NOW, isAllowed: () => false, nameOf: (u) => (u === PEER ? 'thinkcentre' : undefined) });
  return JSON.parse(JSON.stringify({ initialized: true, ok: true, self: { uuid: SELF, name: 'target' }, policyMode: 'admin', adminKeyHere: false, logFile: '/x/audit.log', logPresent: true, now: NOW, summary, problems: [], ...over }));
}

describe('requestsPage (the Requests page, local machine)', () => {
  const audit = lines([
    refusal(-3 * 3600, 'ls'),
    refusal(-300, 'ls'),
    refusal(-60, 'df -h'),
    { ts: iso(-30), event: 'accepted', source: PEER, id: 'r1', shell: 'sh', command: 'uptime' },
    { ts: iso(-29), event: 'completed', id: 'r1', exitCode: 0, timedOut: false, truncated: false, durationMs: 1500 },
    { ts: iso(-10), event: 'session-closed', source: PEER, reason: 'too-many-refusals', refusals: 21 },
  ]);

  it('builds the pending rows, newest first, with humanized ages and the exact next command', () => {
    const page = requestsPage(daemonAnswer(audit), NOW);
    expect(page.count).toBe(2);
    expect(page.pending.map((p) => p.command)).toEqual(['df -h', 'ls']);
    expect(page.pending[1]).toMatchObject({
      peerText: 'thinkcentre',
      shell: 'sh',
      countText: '2 times',
      firstSeenText: '3 h ago',
      lastSeenText: '5 min ago',
      nextCommand: 'machine admin allow target --shell sh -- ls',
    });
    expect(page.pending[0]?.nextCommand).toBe('machine admin allow target --shell sh -- "df -h"');
  });

  it('builds the history rows: runs with exit code and duration, refusals with their reason, session events', () => {
    const page = requestsPage(daemonAnswer(audit), NOW);
    const text = page.history.map((h) => `${h.kind}: ${h.text}`);
    expect(text).toContain('run: sh "uptime" -> exit 0 in 1.5 s');
    expect(text).toContain('refused: (not-listed) sh "df -h"');
    expect(text).toContain('session: session-closed (too-many-refusals)');
    expect(page.history.at(-1)?.whenText).toBe('10 s ago');
  });

  it('says in mode local that the command is run on the machine itself', () => {
    const page = requestsPage(daemonAnswer(audit, { policyMode: 'local' }), NOW);
    expect(page.pending[0]?.nextCommand).toBe('machine policy allow --shell sh -- "df -h"');
    expect(page.pending[0]?.nextWhere).toMatch(/on target/);
  });

  it('carries the broken chain as a warning with the line, and keeps what is readable', () => {
    const broken = [...audit];
    broken[3] = (broken[3] as string).replace('uptime', 'EVIL');
    const page = requestsPage(daemonAnswer(broken), NOW);
    expect(page.chainOk).toBe(false);
    expect(page.chainText).toMatch(/broken at line 4/);
    expect(page.chainText).toMatch(/Keep a copy/);
    expect(page.pending.length).toBe(2);
    expect(page.history.some((h) => h.unverified)).toBe(true);
  });

  it('says there is no audit log yet rather than showing a bare empty table', () => {
    const page = requestsPage(daemonAnswer([], { logPresent: false }), NOW);
    expect(page.pending).toEqual([]);
    expect(page.emptyMessage).toMatch(/no request ever reached this machine/i);
  });

  it('says what is true about the other machines: the admin machine loads them from the page, any other one is told where to go', () => {
    const admin = requestsPage(daemonAnswer(audit, { adminKeyHere: true }), NOW);
    expect(admin.remote).toEqual({ available: true, note: '' });
    expect(admin.remoteNote).toMatch(/other trusted machines/);
    expect(admin.remoteNote).toMatch(/admin passphrase/);
    expect(admin.remoteNote).not.toMatch(/THIS machine|cannot ask a peer/);
    const other = requestsPage(daemonAnswer(audit, { adminKeyHere: false }), NOW);
    expect(other.remote.available).toBe(false);
    expect(other.remote.note).toMatch(/Only the admin machine/);
    expect(other.remote.note).toMatch(/machine requests <machine>/);
    expect(other.remoteNote).toBe(other.remote.note);
  });

  describe('the Allow button (decision 76)', () => {
    it('is offered on the admin machine in mode admin: the rows carry what the confirmation names (machine, shell, exact command)', () => {
      const page = requestsPage(daemonAnswer(audit, { adminKeyHere: true }), NOW);
      expect(page.allow).toEqual({ available: true, machine: { uuid: SELF, name: 'target' }, note: '' });
      expect(page.pending.map((p) => [p.shell, p.command])).toEqual([['sh', 'df -h'], ['sh', 'ls']]);
    });

    it('is not offered without the admin key here, and says where to do it', () => {
      const page = requestsPage(daemonAnswer(audit, { adminKeyHere: false }), NOW);
      expect(page.allow.available).toBe(false);
      expect(page.allow.note).toMatch(/only the admin machine can allow/i);
      expect(page.allow.note).toMatch(/machine admin allow/);
    });

    it('is not offered in mode local: that machine signs its own list, the note names `machine policy allow`', () => {
      const page = requestsPage(daemonAnswer(audit, { adminKeyHere: true, policyMode: 'local' }), NOW);
      expect(page.allow.available).toBe(false);
      expect(page.allow.note).toMatch(/manages its own allow list/);
      expect(page.allow.note).toMatch(/machine policy allow/);
    });
  });

  it('shows no verification code and nothing from the keys', () => {
    expect(JSON.stringify(requestsPage(daemonAnswer(audit), NOW))).not.toMatch(/verification|code"/i);
  });

  it('refuses an answer that is not what the daemon command returns, with the fix', () => {
    expect(() => requestsPage({ nope: true }, NOW)).toThrow(RequestsAnswerError);
    expect(() => requestsPage({ nope: true }, NOW)).toThrow(/machine cli update/);
  });

  it('a daemon that is not initialized is reported with its own message', () => {
    expect(() => requestsPage({ initialized: false, message: 'run machine init' }, NOW)).toThrow(/machine init/);
  });
});

describe('requestsPage: request notices (request-notices.md, phase 2)', () => {
  const REPORTER = '33333333-3333-4333-8333-333333333333';
  const REQ = 'aaaa1111-0000-4000-8000-000000000000';
  const stored = (over: Record<string, unknown> = {}) => ({ machine: REPORTER, machineName: 'laptop', receivedAt: NOW - 20, id: REQ, peer: PEER, peerName: 'thinkcentre', shell: 'sh', command: 'ls -l', commandTruncated: false, state: 'held', deadline: NOW + 580, ts: NOW - 30, ...over });

  it('turns a held notice into a row of the machine that REPORTED it, counting down from the hold length minus the time since it arrived (no clock of the target needed)', () => {
    const page = requestsPage(daemonAnswer([], { notices: [stored()] }), NOW);
    expect(page.noticesError).toBe('');
    expect(page.notices).toEqual([
      { id: REQ, machine: REPORTER, machineName: 'laptop', peerText: 'thinkcentre', peer: PEER, shell: 'sh', command: 'ls -l', commandTruncated: false, state: 'held', secondsLeft: 590, receivedAt: NOW - 20 },
    ]);
  });

  it('a refused notice has no countdown', () => {
    const page = requestsPage(daemonAnswer([], { notices: [stored({ state: 'refused', deadline: null })] }), NOW);
    expect(page.notices[0]).toMatchObject({ state: 'refused', secondsLeft: null });
  });

  it('the countdown never goes below zero', () => {
    const page = requestsPage(daemonAnswer([], { notices: [stored({ deadline: NOW - 100, ts: NOW - 130, receivedAt: NOW - 120 })] }), NOW);
    expect(page.notices[0]?.secondsLeft).toBe(0);
  });

  it('notices do not count in the tab indicator (they are not verified here)', () => {
    expect(requestsPage(daemonAnswer([], { notices: [stored()] }), NOW).count).toBe(0);
  });

  it('a damaged store is reported with the daemon message, never silently', () => {
    const page = requestsPage(daemonAnswer([], { notices: [], noticesError: 'notices.json is damaged: delete it' }), NOW);
    expect(page.notices).toEqual([]);
    expect(page.noticesError).toBe('notices.json is damaged: delete it');
  });

  it('an older daemon that does not report notices is named, with the fix', () => {
    const page = requestsPage(daemonAnswer([]), NOW);
    expect(page.notices).toEqual([]);
    expect(page.noticesError).toMatch(/does not report request notices.*machine cli update/);
  });

  it('a notices field that is not a list is reported', () => {
    const page = requestsPage(daemonAnswer([], { notices: 'x' }), NOW);
    expect(page.noticesError).toMatch(/unexpected.*machine cli update/);
  });

  it('a notice that is not shaped like a stored notice is reported and skipped, the others stay', () => {
    const page = requestsPage(daemonAnswer([], { notices: [{ nope: 1 }, stored()] }), NOW);
    expect(page.notices).toHaveLength(1);
    expect(page.noticesError).toMatch(/1 request notice.*not shown/);
  });
});

describe('remoteRequestsPage', () => {
  it('humanizes the peer answer like the local pending list, with the command to run for that peer', () => {
    const page = remoteRequestsPage(
      {
        type: 'requests-list',
        id: 'x',
        machine: { uuid: SELF, name: 'laptop' },
        policyMode: 'admin',
        now: NOW,
        chain: { ok: true },
        pendingTotal: 3,
        allowedNow: 1,
        truncated: true,
        waiting: [],
        pending: [{ peer: PEER, peerName: 'thinkcentre', shell: 'sh', command: 'ls', count: 1, firstSeen: NOW - 600, lastSeen: NOW - 600, reason: 'not-listed' }],
      },
      NOW,
    );
    expect(page.machine.name).toBe('laptop');
    expect(page.pending[0]).toMatchObject({ countText: '1 time', nextCommand: 'machine admin allow laptop --shell sh -- ls', lastSeenText: '10 min ago' });
    expect(page.notes.join(' ')).toMatch(/Showing 1 of 3/);
    expect(page.notes.join(' ')).toMatch(/1 earlier request/);
  });

  it('carries the requests the peer HOLDS: seconds left by the clock of the peer, the exact allow command for that peer, an Allow capability, and no Deny button', () => {
    const page = remoteRequestsPage(
      {
        type: 'requests-list',
        id: 'x',
        machine: { uuid: SELF, name: 'laptop' },
        policyMode: 'admin',
        now: NOW + 3000,
        chain: { ok: true },
        pendingTotal: 0,
        allowedNow: 0,
        truncated: false,
        waiting: [{ id: 'aaaa1111-0000-4000-8000-000000000000', peer: PEER, peerName: 'thinkcentre', shell: 'cmd', command: 'hostname', since: NOW + 2940, deadline: NOW + 3540 }],
        pending: [],
      },
      NOW,
    );
    expect(page.waiting).toHaveLength(1);
    expect(page.waiting[0]).toMatchObject({ id: 'aaaa1111-0000-4000-8000-000000000000', peerText: 'thinkcentre', shell: 'cmd', command: 'hostname', secondsLeft: 540, askedText: '60 s ago', nextCommand: 'machine admin allow laptop --shell cmd -- hostname' });
    expect(page.allow).toEqual({ available: true, machine: { uuid: SELF, name: 'laptop' }, note: '' });
    expect(page.count).toBe(1);
    // The Deny of a request held elsewhere goes through the daemon (decision 85): the note names the CLI form.
    expect(page.denyNote).toMatch(/machine requests laptop --deny <id>/);
  });

  it('a peer in mode local cannot be allowed from the admin machine: the capability says why and the command is the local one', () => {
    const page = remoteRequestsPage(
      { type: 'requests-list', id: 'x', machine: { uuid: SELF, name: 'laptop' }, policyMode: 'local', now: NOW, chain: { ok: true }, pendingTotal: 0, allowedNow: 0, truncated: false, waiting: [{ id: 'aaaa1111-0000-4000-8000-000000000000', peer: PEER, shell: 'sh', command: 'ls', since: NOW - 5, deadline: NOW + 100 }], pending: [] },
      NOW,
    );
    expect(page.allow.available).toBe(false);
    expect(page.allow.note).toMatch(/laptop manages its own allow list/);
    expect(page.waiting[0]?.nextCommand).toBe('machine policy allow --shell sh -- ls');
  });
});

describe('requestsPage (held requests, `machine run --wait`)', () => {
  const held = (offset: number, id: string, command: string, deadlineOffset: number): Record<string, Json> => ({ ts: iso(offset), event: 'held', source: PEER, id, shell: 'sh', command, deadline: NOW + deadlineOffset });
  const audit = lines([held(-60, 'h1', 'df -h', 540), held(-20, 'h2', 'ls', 100), refusal(-300, 'uptime')]);

  it('lists the held requests soonest deadline first, with the seconds left computed from the daemon clock', () => {
    const page = requestsPage(daemonAnswer(audit), NOW + 10);
    expect(page.waiting.map((w) => w.command)).toEqual(['ls', 'df -h']);
    expect(page.waiting[0]).toMatchObject({ id: 'h2', peer: PEER, peerText: 'thinkcentre', shell: 'sh', secondsLeft: 100, askedText: '30 s ago', nextCommand: 'machine admin allow target --shell sh -- ls' });
    expect(page.waiting[1]).toMatchObject({ id: 'h1', secondsLeft: 540, nextCommand: 'machine admin allow target --shell sh -- "df -h"' });
    expect(page.waiting[0]?.nextWhere).toMatch(/admin machine/);
  });

  it('uses the clock of the daemon, not the one of this process, for the seconds left', () => {
    const answer = daemonAnswer(audit, { now: NOW + 50 });
    expect(requestsPage(answer, NOW + 5000).waiting[0]?.secondsLeft).toBe(50);
  });

  it('counts waiting and pending together for the tab indicator', () => {
    const page = requestsPage(daemonAnswer(audit), NOW);
    expect(page.pending).toHaveLength(1);
    expect(page.count).toBe(3);
  });

  it('says in mode local that the owner runs `machine policy allow` on the machine', () => {
    const page = requestsPage(daemonAnswer(audit, { policyMode: 'local' }), NOW);
    expect(page.waiting[0]?.nextCommand).toBe('machine policy allow --shell sh -- ls');
    expect(page.waiting[0]?.nextWhere).toMatch(/on target/);
  });

  it('has an empty list, not a missing one, when nothing is held', () => {
    const page = requestsPage(daemonAnswer(lines([refusal(-300, 'ls')])), NOW);
    expect(page.waiting).toEqual([]);
    expect(page.count).toBe(1);
  });

  it('an answer without `waiting` (a daemon older than the module) is refused with the fix, not shown as empty', () => {
    const answer = daemonAnswer(audit) as { summary: Record<string, unknown> };
    delete answer.summary['waiting'];
    expect(() => requestsPage(answer, NOW)).toThrow(/machine cli update/);
  });
});
