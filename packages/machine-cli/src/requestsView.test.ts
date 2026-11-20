import { mkdtempSync, rmSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PolicyBody } from '@wadeck-app/machine-core';
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
