import { describe, expect, it } from 'vitest';
import { layoutHistory, layoutRequests, REQUESTS_WIDTH, type RequestsLayoutInput } from './requestsLayout.js';
import type { HistoryEntry, PendingGroup, WaitingRequest } from './requests.js';
import type { StoredNotice } from './requestNotice.js';

const NOW = 1_800_000_000;
const PEER = '11111111-1111-4111-8111-111111111111';
const age = (at: number, now: number): string => (now - at < 5 ? 'now' : `${Math.round((now - at) / 60)} min ago`);

const held = (n: number, command: string, over: Partial<WaitingRequest> = {}): WaitingRequest => ({ id: `abcdef1${n}-3456-4789-8abc-def012345678`, peer: PEER, peerName: 'midgard2', shell: 'cmd', command, since: NOW - 60, deadline: NOW + 540, ...over });
const group = (command: string, over: Partial<PendingGroup> = {}): PendingGroup => ({ peer: PEER, peerName: 'midgard2', shell: 'sh', command, count: 3, firstSeen: NOW - 7200, lastSeen: NOW - 300, reason: 'not-listed', ...over });

const input = (over: Partial<RequestsLayoutInput> = {}): RequestsLayoutInput => ({
  machine: { name: 'thinkcentre', policyMode: 'admin' },
  remote: false,
  adminKeyHere: true,
  now: NOW,
  waiting: [],
  pending: [],
  pendingTotal: 0,
  allowedNow: 0,
  logPresent: true,
  full: false,
  age,
  ...over,
});

const widest = (lines: string[]): number => Math.max(...lines.map((l) => l.length));
const ascii = (lines: string[]): boolean => lines.every((l) => /^[\x20-\x7e]*$/.test(l));

describe('layoutRequests: structure', () => {
  it('a header with the machine and the counts, WAITING NOW first, then REFUSED, one aligned table row per request', () => {
    const lines = layoutRequests(input({ waiting: [held(1, 'hostname')], pending: [group('ls'), group('df -h', { count: 1 })], pendingTotal: 2 }));
    expect(lines[0]).toBe('thinkcentre (admin mode): 1 waiting now, 2 refused (not allowed)');
    const waitingAt = lines.findIndex((l) => l.startsWith('WAITING NOW'));
    const refusedAt = lines.findIndex((l) => l.startsWith('REFUSED'));
    expect(waitingAt).toBeGreaterThan(0);
    expect(refusedAt).toBeGreaterThan(waitingAt);
    const header = lines[waitingAt + 1] as string;
    const row = lines[waitingAt + 2] as string;
    expect(header).toMatch(/^ {2}ID +FROM +SHELL +LEFT +ASKED +COMMAND$/);
    // The columns are aligned: every title starts where its cell starts.
    for (const title of ['FROM', 'SHELL', 'LEFT', 'ASKED', 'COMMAND']) {
      const cell = { FROM: 'midgard2', SHELL: 'cmd', LEFT: '9 min', ASKED: '1 min ago', COMMAND: 'hostname' }[title] as string;
      expect(row.indexOf(cell, header.indexOf(title))).toBe(header.indexOf(title));
    }
    expect(row).toContain('abcdef11');
    expect(row).not.toContain('abcdef11-3456');
  });

  it('at most ONE line of actions under a section: the exact allow command of the only request', () => {
    const lines = layoutRequests(input({ waiting: [held(1, 'hostname')] }));
    const actions = lines.filter((l) => /^ {2}allow:/.test(l));
    expect(actions).toEqual(['  allow: machine admin allow thinkcentre --shell cmd -- hostname']);
    expect(lines.filter((l) => /^ {2}deny/.test(l))).toEqual([]);
  });

  it('with several requests the action line is a template, not one pair of long lines per row', () => {
    const lines = layoutRequests(input({ waiting: [held(1, 'hostname'), held(2, 'uptime -p')] }));
    const actions = lines.filter((l) => /^ {2}allow:/.test(l));
    expect(actions).toHaveLength(1);
    expect(actions[0]).toContain('machine admin allow thinkcentre --shell <shell> -- <command>');
    expect(actions[0]).toMatch(/--full|--json/);
  });

  it('--full gives the exact allow command of every row', () => {
    const lines = layoutRequests(input({ full: true, waiting: [held(1, 'hostname'), held(2, 'uptime -p')] }));
    expect(lines).toContain('  allow: machine admin allow thinkcentre --shell cmd -- hostname');
    expect(lines).toContain('  allow: machine admin allow thinkcentre --shell cmd -- "uptime -p"');
  });

  it('REFUSED rows show the count and the last time, and the exact allow command when there is one row', () => {
    const lines = layoutRequests(input({ pending: [group('ls')], pendingTotal: 1 }));
    expect(lines.find((l) => /FROM +SHELL +TIMES +LAST +COMMAND/.test(l))).toBeDefined();
    expect(lines.find((l) => /midgard2 +sh +3 +5 min ago +ls$/.test(l))).toBeDefined();
    expect(lines).toContain('  allow: machine admin allow thinkcentre --shell sh -- ls');
  });

  it('says there is nothing to answer, and why when no request ever came', () => {
    expect(layoutRequests(input())[0]).toBe('thinkcentre (admin mode): nothing waiting, no refused request');
    expect(layoutRequests(input({ logPresent: false })).join('\n')).toMatch(/no audit log yet: no request ever reached it/);
  });

  it('mode local: the allow command is the local one and the note says where to run it', () => {
    const lines = layoutRequests(input({ machine: { name: 'thinkcentre', policyMode: 'local' }, pending: [group('ls')], pendingTotal: 1 }));
    expect(lines).toContain('  allow: machine policy allow --shell sh -- ls');
    expect(lines.join('\n')).toMatch(/local passphrase/);
    expect(lines.join('\n')).not.toContain('machine admin allow');
  });

  it('says how many were left out of the list', () => {
    const lines = layoutRequests(input({ pending: [group('ls')], pendingTotal: 5 }));
    expect(lines.join('\n')).toMatch(/showing 1 of 5.*--limit/);
  });

  it('shows the earlier requests that are allowed now, once', () => {
    expect(layoutRequests(input({ allowedNow: 2 })).join('\n')).toMatch(/2 earlier requests are allowed now and not listed/);
  });
});

describe('layoutRequests: notes footer', () => {
  it('at most 3 notes, after one `Notes:` line, each short', () => {
    const lines = layoutRequests(input({ waiting: [held(1, 'hostname')], pending: [group('ls')], pendingTotal: 1, remote: true }));
    const at = lines.indexOf('Notes:');
    expect(at).toBeGreaterThan(0);
    const notes = lines.slice(at + 1);
    expect(notes.length).toBeGreaterThan(0);
    expect(notes.length).toBeLessThanOrEqual(3);
    expect(notes.every((l) => l.startsWith('  - '))).toBe(true);
    expect(lines.filter((l) => l === 'Notes:')).toHaveLength(1);
  });

  it('the deny command is a note (run on the machine that holds the request), with the id column to read', () => {
    const notes = layoutRequests(input({ waiting: [held(1, 'hostname')], remote: true })).join('\n');
    expect(notes).toMatch(/deny: machine requests thinkcentre --deny <id> \[--reason <text>\]/);
  });

  it('a remote listing says how an allow reaches the target and runs the held command', () => {
    const notes = layoutRequests(input({ waiting: [held(1, 'hostname')], remote: true })).join('\n');
    expect(notes).toMatch(/installs it within about a minute/);
  });

  it('shell cmd for a target that may be Linux/macOS: the caller probably needs --shell sh', () => {
    const notes = layoutRequests(input({ waiting: [held(1, 'hostname')], remote: true })).join('\n');
    expect(notes).toMatch(/cmd is a Windows shell/);
    expect(notes).toContain('--shell sh');
    expect(notes).toContain('peer connect thinkcentre --shell sh');
  });

  it('a local view on a Windows machine does not warn about cmd; on Linux it does', () => {
    expect(layoutRequests(input({ waiting: [held(1, 'hostname')], targetPlatform: 'windows' })).join('\n')).not.toMatch(/Windows shell/);
    expect(layoutRequests(input({ waiting: [held(1, 'hostname')], targetPlatform: 'posix' })).join('\n')).toMatch(/Windows shell/);
  });

  it('no cmd request, no shell note', () => {
    expect(layoutRequests(input({ pending: [group('ls')], pendingTotal: 1, remote: true })).join('\n')).not.toMatch(/Windows shell/);
  });
});

describe('layoutRequests: width and characters', () => {
  const long = `echo ${'x'.repeat(300)}`;
  const everything = (over: Partial<RequestsLayoutInput> = {}) => input({ waiting: [held(1, long), held(2, 'uptime -p')], pending: [group(long), group('ls')], pendingTotal: 2, remote: true, ...over });

  it('no line is wider than 100 characters, whatever the command, and everything is ASCII', () => {
    const lines = layoutRequests(everything());
    expect(widest(lines)).toBeLessThanOrEqual(REQUESTS_WIDTH);
    expect(ascii(lines)).toBe(true);
  });

  it('a long command is cut with ... and --full shows all of it, wrapped under the command column', () => {
    const short = layoutRequests(everything());
    expect(short.join('\n')).toContain('...');
    expect(short.join('\n')).not.toContain('x'.repeat(300));
    const full = layoutRequests(everything({ full: true }));
    const table = full.filter((l) => !/^ {2}allow:/.test(l));
    expect(widest(table)).toBeLessThanOrEqual(REQUESTS_WIDTH);
    expect(table.join('').replace(/\s/g, '')).toContain('x'.repeat(300));
  });

  it('a very long machine or peer name does not break the width either', () => {
    const name = 'n'.repeat(80);
    const lines = layoutRequests(input({ machine: { name, policyMode: 'admin' }, waiting: [held(1, 'hostname', { peerName: name })], remote: true }));
    expect(widest(lines.filter((l) => !/allow:/.test(l)))).toBeLessThanOrEqual(REQUESTS_WIDTH);
  });

  it('control characters never reach the output', () => {
    const lines = layoutRequests(input({ waiting: [held(1, 'ls\u001b[2J', { peerName: 'a\u0007b' })] }));
    expect(ascii(lines)).toBe(true);
  });
});

describe('layoutHistory', () => {
  const entry = (over: Partial<HistoryEntry> = {}): HistoryEntry => ({ at: NOW - 600, kind: 'run', event: 'accepted', verified: true, peer: PEER, peerName: 'midgard2', shell: 'sh', command: 'uptime', outcome: 'completed', exitCode: 0, durationMs: 1500, ...over });
  const base = { machineName: 'thinkcentre', now: NOW, full: false, age, when: (at: number, now: number) => `${age(at, now)}`, limitation: 'this machine only' };

  it('a header, one aligned row per entry (when, from, kind, what), the limitation as the only note', () => {
    const lines = layoutHistory({ ...base, history: [entry(), entry({ kind: 'refused', event: 'refused', reason: 'not-listed', command: 'df -h', at: NOW - 60 })], historyTotal: 2, logPresent: true });
    expect(lines[0]).toBe('thinkcentre: history, 2 entries, oldest first');
    expect(lines.join('\n')).toMatch(/WHEN +FROM +KIND +WHAT/);
    expect(lines.join('\n')).toMatch(/10 min ago +midgard2 +run +sh "uptime" -> exit 0 in 1\.5 s/);
    expect(lines.join('\n')).toMatch(/refused +\(not-listed\) sh "df -h"/);
    expect(lines[lines.length - 1]).toBe('  - this machine only');
  });

  it('marks an unverified entry and says how many were left out', () => {
    const lines = layoutHistory({ ...base, history: [entry({ verified: false })], historyTotal: 40, logPresent: true });
    expect(lines.join('\n')).toContain('[UNVERIFIED]');
    expect(lines[0]).toBe('thinkcentre: history, last 1 of 40 entries, oldest first (--limit <n> or --since change the window)');
  });

  it('says why there is nothing, and keeps the width', () => {
    expect(layoutHistory({ ...base, history: [], historyTotal: 0, logPresent: false }).join('\n')).toMatch(/no audit log yet/);
    const lines = layoutHistory({ ...base, history: [entry({ command: 'y'.repeat(400) })], historyTotal: 1, logPresent: true });
    expect(widest(lines)).toBeLessThanOrEqual(REQUESTS_WIDTH);
    expect(ascii(lines)).toBe(true);
  });
});

describe('layoutRequests: notices of other machines (request-notices.md)', () => {
  const OTHER = '22222222-2222-4222-8222-222222222222';
  const notice = (n: number, command: string, over: Partial<StoredNotice> = {}): StoredNotice => ({
    machine: OTHER, machineName: 'laptop', receivedAt: NOW - 120, id: `abcdef1${n}-3456-4789-8abc-def012345678`, peer: PEER, peerName: 'midgard2', shell: 'sh', command, commandTruncated: false, state: 'held', deadline: NOW + 300, ts: NOW - 120, ...over,
  });

  it('lists a held notice in WAITING NOW labelled with its machine, with the exact allow command for THAT machine and the not-verified note', () => {
    const lines = layoutRequests(input({ notices: [notice(1, 'uptime')] }));
    const text = lines.join('\n');
    expect(lines[0]).toBe('thinkcentre (admin mode): nothing waiting, no refused request, 1 reported by other machines');
    expect(text).toMatch(/^WAITING NOW/m);
    expect(text).toMatch(/MACHINE +ID +FROM +SHELL +LEFT +REPORTED +COMMAND/);
    expect(text).toMatch(/laptop +abcdef11 +midgard2 +sh +5 min +2 min ago +uptime/);
    expect(text).toContain('allow: machine admin allow laptop --shell sh -- uptime');
    expect(text).toContain('reported by laptop');
    expect(text).toContain('not verified live');
    expect(text).toContain('Load the other machines');
    expect(text).toContain('`machine requests <machine>`');
    expect(widest(lines)).toBeLessThanOrEqual(REQUESTS_WIDTH);
    expect(ascii(lines)).toBe(true);
  });

  it('lists a refused notice in REFUSED, next to the local rows without mixing them', () => {
    const lines = layoutRequests(input({ pending: [group('ls')], pendingTotal: 1, notices: [notice(1, 'df -h', { state: 'refused', deadline: null })] }));
    const text = lines.join('\n');
    expect(text.match(/^REFUSED/gm)).toHaveLength(1);
    expect(text).toContain('allow: machine admin allow thinkcentre --shell sh -- ls');
    expect(text).toContain('allow: machine admin allow laptop --shell sh -- "df -h"');
  });

  it('shows the command as escaped printable ASCII and never offers an exact allow for a truncated command', () => {
    const lines = layoutRequests(input({ notices: [notice(1, 'echo \u001b[31mred', { commandTruncated: true })] }));
    const text = lines.join('\n');
    expect(ascii(lines)).toBe(true);
    expect(text).not.toContain('allow: machine admin allow laptop --shell sh -- ');
    expect(text).toContain('cut');
  });

  it('several notices: the template for the machine, exact commands with --full', () => {
    const two = [notice(1, 'uptime'), notice(2, 'df -h', { machineName: 'desktop' })];
    expect(layoutRequests(input({ notices: two })).join('\n')).toContain('(exact: --full or --json)');
    const full = layoutRequests(input({ notices: two, full: true })).join('\n');
    expect(full).toContain('allow: machine admin allow laptop --shell sh -- uptime');
    expect(full).toContain('allow: machine admin allow desktop --shell sh -- "df -h"');
  });

  it('no notice, no change: the layout is the one of before', () => {
    expect(layoutRequests(input({ notices: [] }))).toEqual(layoutRequests(input()));
  });
});
