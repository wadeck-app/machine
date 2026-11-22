import { mkdtempSync, rmSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateSigningKeyPair, keyId, signNoticeRecipients, type PolicyBody } from '@wadeck-app/machine-core';
import { installNoticeRecipients, noticeRecipientsFile } from './noticeRecipientsStore.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { initMachine } from './identity.js';
import { isListed, makeRequestsListDeps, requestsAnswer, type RequestsView } from './requestsView.js';
import { FileAuditLog } from './stores.js';

const PEER = '11111111-1111-4111-8111-111111111111';
const NOW = Math.floor(Date.UTC(2026, 10, 20, 12, 0, 0) / 1000);
const iso = (offset: number) => new Date((NOW + offset) * 1000).toISOString();

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'machine-requests-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function writeLog(entries: Array<Record<string, string | number | boolean | null>>): void {
  const log = new FileAuditLog(join(dir, 'audit.log'));
  for (const e of entries) log.write(e);
}

const refusal = (offset: number, command: string) => ({ ts: iso(offset), event: 'refused', source: PEER, reason: 'not-listed', id: `i${offset}`, shell: 'sh', command });

function view(query = {}): RequestsView {
  const answer = requestsAnswer(dir, query, NOW);
  if (!answer.initialized || !answer.ok) throw new Error(`unexpected answer: ${JSON.stringify(answer)}`);
  return answer;
}

describe('requestsAnswer', () => {
  it('says the machine is not initialized instead of showing an empty list', () => {
    expect(requestsAnswer(dir, {}, NOW)).toMatchObject({ initialized: false });
  });

  it('reads the audit log of this machine and lists the pending requests', () => {
    initMachine(dir, 'target');
    writeLog([refusal(-300, 'ls'), refusal(-100, 'ls'), refusal(-50, 'df -h')]);
    const v = view();
    expect(v.self.name).toBe('target');
    expect(v.logPresent).toBe(true);
    expect(v.policyMode).toBe('admin');
    expect(v.summary.pending.map((g) => [g.command, g.count])).toEqual([['df -h', 1], ['ls', 2]]);
    expect(v.summary.chain).toEqual({ ok: true, entries: 3 });
  });

  it('a machine that never received a request has no audit log: said, not an error', () => {
    initMachine(dir, 'target');
    const v = view();
    expect(v.logPresent).toBe(false);
    expect(v.summary.pending).toEqual([]);
  });

  it('reports a broken chain with its line and still returns what is readable', () => {
    initMachine(dir, 'target');
    writeLog([refusal(-300, 'ls'), refusal(-100, 'pwd')]);
    appendFileSync(join(dir, 'audit.log'), '{not json\n');
    const v = view();
    expect(v.summary.chain).toMatchObject({ ok: false, line: 3, trustedEntries: 2 });
    expect(v.summary.pending.map((g) => g.command).sort()).toEqual(['ls', 'pwd']);
  });

  it('applies the history filters and resolves --peer by uuid prefix to the uuid', () => {
    initMachine(dir, 'target');
    writeLog([refusal(-300, 'ls'), { ts: iso(-200), event: 'session-closed', source: PEER, reason: 'peer-revoked' }]);
    expect(view({ kinds: ['session'] }).summary.history.map((h) => h.event)).toEqual(['session-closed']);
    expect(view({ peer: PEER }).summary.history).toHaveLength(2);
  });

  it('refuses a peer reference that matches nothing, with the fix', () => {
    initMachine(dir, 'target');
    writeLog([refusal(-300, 'ls')]);
    const answer = requestsAnswer(dir, { peer: 'nobody' }, NOW);
    expect(answer).toMatchObject({ initialized: true, ok: false });
    if (answer.initialized && !answer.ok) expect(answer.message).toMatch(/nobody.*machine list/s);
  });

  it('marks this machine as holding an admin key only when its key file exists', () => {
    initMachine(dir, 'target');
    expect(view().adminKeyHere).toBe(false);
    writeFileSync(join(dir, '_secrets_', 'admin.key.json'), '{}', { flag: 'w' });
    expect(view().adminKeyHere).toBe(true);
  });
});

describe('makeRequestsListDeps (what the daemon hands to the requests-list exchange)', () => {
  it('has no admin key before the machine is enrolled, and says why in the log', () => {
    initMachine(dir, 'target');
    const logged: string[] = [];
    expect(makeRequestsListDeps(dir, () => NOW, (m) => logged.push(m)).adminPublicKey()).toBeUndefined();
    expect(logged.join('\n')).toMatch(/admin key/);
  });

  it('returns the pending groups of the audit log with the machine and the chain line only', () => {
    initMachine(dir, 'target');
    writeLog([refusal(-300, 'ls'), refusal(-100, 'ls'), refusal(-50, 'df -h')]);
    const data = makeRequestsListDeps(dir, () => NOW, () => undefined).list(1);
    expect(data.machine.name).toBe('target');
    expect(data.policyMode).toBe('admin');
    expect(data.chain).toEqual({ ok: true });
    expect(data.pendingTotal).toBe(2);
    expect(data.pending.map((g) => g.command)).toEqual(['df -h']);
  });

  it('tells the serial of the notice-recipients list it holds, null when it holds none or cannot use it', () => {
    initMachine(dir, 'target');
    expect(makeRequestsListDeps(dir, () => NOW, () => undefined).list(5).noticeRecipientsSerial).toBeNull();
    const admin = generateSigningKeyPair();
    writeFileSync(join(dir, 'admin.json'), JSON.stringify({ v: 1, adminPublicKey: admin.publicKey, adminKeyId: keyId(admin.publicKey) }));
    expect(makeRequestsListDeps(dir, () => NOW, () => undefined).list(5).noticeRecipientsSerial).toBeNull();
    const signed = signNoticeRecipients({ v: 1, adminKeyId: keyId(admin.publicKey), serial: 4242, issuedAt: 4242, recipients: [PEER] }, admin.privateKeyPkcs8);
    installNoticeRecipients(dir, signed, admin.publicKey);
    expect(makeRequestsListDeps(dir, () => NOW, () => undefined).list(5).noticeRecipientsSerial).toBe(4242);
    // A damaged file is reported in the daemon log and answered as "no usable list": the admin then sees it as missing.
    writeFileSync(noticeRecipientsFile(dir), '{not json');
    const logged: string[] = [];
    expect(makeRequestsListDeps(dir, () => NOW, (m) => logged.push(m)).list(5).noticeRecipientsSerial).toBeNull();
    expect(logged.join('\n')).toMatch(/notice-recipients\.json/);
  });

  it('reports a broken chain by its line', () => {
    initMachine(dir, 'target');
    writeLog([refusal(-300, 'ls')]);
    appendFileSync(join(dir, 'audit.log'), '{edited\n');
    expect(makeRequestsListDeps(dir, () => NOW, () => undefined).list(5).chain).toEqual({ ok: false, line: 2 });
  });
});

describe('isListed', () => {
  const entry = { shell: 'sh', command: 'ls' } as const;
  const policy = (extra: Partial<PolicyBody> = {}): PolicyBody => ({ v: 1, target: 't', version: 1, baseVersion: 0, adminKeyId: 'k', issuedAt: 0, notBefore: 0, notAfter: NOW + 10, defaults: [entry], peers: {}, ...extra });

  it('is false without a policy', () => {
    expect(isListed(undefined, PEER, 'sh', 'ls', NOW, 'admin')).toBe(false);
  });
  it('is true for a command of the default list', () => {
    expect(isListed(policy(), PEER, 'sh', 'ls', NOW, 'admin')).toBe(true);
    expect(isListed(policy(), PEER, 'sh', 'pwd', NOW, 'admin')).toBe(false);
    expect(isListed(policy(), PEER, 'bash', 'ls', NOW, 'admin')).toBe(false);
  });
  it('uses ONLY the own list of a peer that has one', () => {
    expect(isListed(policy({ peers: { [PEER]: [] } }), PEER, 'sh', 'ls', NOW, 'admin')).toBe(false);
  });
  it('is true for a listed command that expired or is exhausted: renewing is not a new request', () => {
    expect(isListed(policy({ defaults: [{ ...entry, limits: { expiresAt: NOW - 1 } }] }), PEER, 'sh', 'ls', NOW, 'admin')).toBe(true);
  });
});

describe('requestsAnswer: notices of other machines (request-notices.md)', () => {
  const SENDER = '0a1b2c3d-4e5f-4a6b-9c7d-8e9f0a1b2c3d';
  const stored = (n: number, over: Record<string, unknown> = {}) => ({
    machine: SENDER, machineName: 'thinkcentre', receivedAt: NOW - n, id: `3f1c2d3e-4a5b-4c6d-8e7f-${String(n).padStart(12, '0')}`, peer: PEER, peerName: 'agent-box', shell: 'sh', command: `echo ${n}`, commandTruncated: false, state: 'held', deadline: NOW + 600, ts: NOW - n, ...over,
  });

  it('carries the visible notices, newest first, and drops a held notice whose deadline passed', () => {
    initMachine(dir, 'target');
    writeFileSync(join(dir, 'notices.json'), JSON.stringify({ v: 1, notices: [stored(30), stored(10), stored(20, { deadline: NOW - 1 }), stored(40, { state: 'refused', deadline: null })] }));
    const v = view();
    expect(v.notices.map((n) => n.command)).toEqual(['echo 10', 'echo 30', 'echo 40']);
    expect(v.noticesError).toBeUndefined();
  });

  it('lists the held notices past their deadline apart (expiredNotices, newest first): they are not live, and a refused one is never expired', () => {
    initMachine(dir, 'target');
    writeFileSync(join(dir, 'notices.json'), JSON.stringify({ v: 1, notices: [stored(30, { deadline: NOW - 5 }), stored(10), stored(20, { deadline: NOW - 1 }), stored(40, { state: 'refused', deadline: null })] }));
    const v = view();
    expect(v.notices.map((n) => n.command)).toEqual(['echo 10', 'echo 40']);
    expect(v.expiredNotices.map((n) => n.command)).toEqual(['echo 20', 'echo 30']);
  });

  it('no file: an empty list and no error', () => {
    initMachine(dir, 'target');
    expect(view().notices).toEqual([]);
    expect(view().expiredNotices).toEqual([]);
    expect(view().noticesError).toBeUndefined();
  });

  it('a damaged file gives an empty list and the message naming the file and the fix; the rest of the answer is intact', () => {
    initMachine(dir, 'target');
    writeLog([refusal(-100, 'ls')]);
    writeFileSync(join(dir, 'notices.json'), '{ not json');
    const v = view();
    expect(v.notices).toEqual([]);
    expect(v.noticesError).toContain('notices.json');
    expect(v.noticesError).toContain('Delete it');
    expect(v.summary.pending.map((g) => g.command)).toEqual(['ls']);
  });
});
