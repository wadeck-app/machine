import { randomBytes } from 'node:crypto';
import { HoldTable, applyPolicy, generateSigningKeyPair, keyId, newRequest, signPolicy, signRequest, type Json, type PolicyBody, type PolicyEntry } from '@wadeck-app/machine-core';
import type { RunOptions, RunResult } from '@wadeck-app/machine-exec';
import { connectToPeer, type PeerSession } from '@wadeck-app/machine-transport';
import { afterEach, describe, expect, it } from 'vitest';
import { runOnPeer, startPeerListener, type PeerAnswer, type PeerServiceDeps } from './peerService.js';

// Hold of a refused request (hold-for-approval.md): `run` with a wait is kept open on the target until an Allow runs it, a Deny or the deadline refuses it.

const A = '1b4e28ba-2fa1-4d3b-a3f4-0123456789ab';
const B = '9c5d1e2f-3a4b-4c6d-8e7f-abcdef012345';
const SHELL = process.platform === 'win32' ? 'cmd' : 'sh';

const closers: Array<() => void> = [];
afterEach(() => {
  while (closers.length > 0) closers.pop()?.();
});

class MemoryUsage {
  readonly counts = new Map<string, number>();
  count(key: string): number {
    return this.counts.get(key) ?? 0;
  }
  record(key: string): void {
    this.counts.set(key, this.count(key) + 1);
  }
}

class MemoryAudit {
  readonly entries: Array<Record<string, Json>> = [];
  write(entry: Record<string, Json>): void {
    this.entries.push(entry);
  }
  events(): string[] {
    return this.entries.map((e) => String(e.event));
  }
}

const okResult = (): RunResult => ({ exitCode: 0, stdout: 'out', stderr: '', timedOut: false, truncated: false, outputNotUtf8: false, durationMs: 1 });

/** Poll until the condition holds: the service answers on its own timers. */
async function until(what: string, condition: () => boolean): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > 3000) {
      throw new Error(`timed out waiting for ${what}`);
    }
    await new Promise((r) => setTimeout(r, 2));
  }
}

async function world(over: { holds?: HoldTable; capSeconds?: number; noHolds?: boolean; auditFails?: () => boolean } = {}) {
  const admin = generateSigningKeyPair();
  const a = generateSigningKeyPair();
  const b = generateSigningKeyPair();
  const secret = randomBytes(32);
  const usage = new MemoryUsage();
  const audit = new MemoryAudit();
  const runs: RunOptions[] = [];
  const now = { value: 1_800_000_000 };
  const state = { revoked: false };
  const table = over.holds ?? new HoldTable();
  let policy: PolicyBody | undefined;
  const setPolicy = (entries: PolicyEntry[]) => {
    const body: PolicyBody = {
      v: 1,
      target: B,
      version: (policy?.version ?? 0) + 1,
      baseVersion: policy?.version ?? 0,
      adminKeyId: keyId(admin.publicKey),
      issuedAt: now.value,
      notBefore: now.value - 10,
      notAfter: now.value + 100_000,
      defaults: entries,
      peers: {},
    };
    const applied = applyPolicy({ version: policy?.version ?? 0, highestSeen: policy?.version ?? 0 }, signPolicy(body, admin.privateKeyPkcs8), { adminPublicKey: admin.publicKey, now: now.value, targetUuid: B });
    if (!applied.ok) {
      throw new Error(applied.message);
    }
    policy = applied.body;
  };
  setPolicy([{ shell: SHELL as 'cmd', command: 'echo listed' }]);
  const deps: PeerServiceDeps = {
    self: { uuid: B, name: 'b', createdAt: '', identity: b },
    directory: { lookup: (key) => (key === a.publicKey && !state.revoked ? { peerId: A, name: 'a', pairSecret: secret } : undefined) },
    policy: () => policy,
    usage,
    audit: {
      write: (e) => {
        if (over.auditFails?.() === true && e.event === 'held') {
          throw new Error('disk full');
        }
        audit.write(e);
      },
    },
    now: () => now.value,
    run: async (o) => {
      runs.push(o);
      return okResult();
    },
    onProblem: () => undefined,
    ...(over.noHolds ? {} : { holds: { table, pollMs: 3, ...(over.capSeconds !== undefined ? { capSeconds: over.capSeconds } : {}) } }),
  };
  const listener = await startPeerListener(deps, { host: '127.0.0.1', port: 0 });
  closers.push(() => listener.close());
  const connect = async (): Promise<PeerSession> => {
    const s = await connectToPeer({ identity: a, host: '127.0.0.1', port: listener.port, expectedPeerPublicKey: b.publicKey, pairSecret: secret });
    closers.push(() => s.close());
    return s;
  };
  const send = (session: PeerSession, command: string, waitSeconds?: number): string => {
    const body = newRequest({ source: A, target: B, shell: SHELL as 'cmd', command, now: now.value });
    session.send({ type: 'run', request: signRequest(body, a.privateKeyPkcs8), ...(waitSeconds !== undefined ? { waitSeconds } : {}) });
    return body.id;
  };
  return { a, audit, runs, now, state, table, setPolicy, connect, send, usage };
}

const answerOf = async (session: PeerSession): Promise<PeerAnswer> => (await session.next()) as PeerAnswer;

describe('hold of a refused request', () => {
  it('without a wait the refusal is immediate, as before', async () => {
    const w = await world();
    const s = await w.connect();
    w.send(s, 'echo later');
    expect(await answerOf(s)).toMatchObject({ type: 'refused', reason: 'not-listed' });
    expect(w.table.list()).toHaveLength(0);
    expect(w.audit.events()).toEqual(['refused']);
  });

  it('keeps the request open, lists it as held, then runs it once an Allow matches and answers the normal result', async () => {
    const w = await world();
    const s = await w.connect();
    const id = w.send(s, 'echo later', 600);
    await until('the hold', () => w.table.list().length === 1);
    expect(w.table.list()[0]).toMatchObject({ id, peer: A, command: 'echo later', waitSeconds: 600 });
    expect(w.audit.entries.find((e) => e.event === 'held')).toMatchObject({ source: A, id, shell: SHELL, command: 'echo later', deadline: w.now.value + 600, waitSeconds: 600 });
    expect(w.runs).toHaveLength(0);
    w.setPolicy([{ shell: SHELL as 'cmd', command: 'echo later' }]);
    expect(await answerOf(s)).toMatchObject({ type: 'result', id, exitCode: 0 });
    expect(w.runs).toHaveLength(1);
    expect(w.audit.events()).toEqual(['daemon-started', 'held', 'hold-ended', 'accepted', 'completed']);
    expect(w.audit.entries.find((e) => e.event === 'hold-ended')).toMatchObject({ id, outcome: 'allowed' });
    expect(w.table.list()).toHaveLength(0);
  });

  it('serves the next request of the same session after the hold (the wait for the connection state is handed back)', async () => {
    const w = await world();
    const s = await w.connect();
    w.send(s, 'echo later', 600);
    await until('the hold', () => w.table.list().length === 1);
    w.setPolicy([{ shell: SHELL as 'cmd', command: 'echo later' }]);
    expect(await answerOf(s)).toMatchObject({ type: 'result' });
    w.send(s, 'echo listed-not-any-more');
    expect(await answerOf(s)).toMatchObject({ type: 'refused', reason: 'not-listed' });
  });

  it('an Allow that is a one-call entry runs the held command once', async () => {
    const w = await world();
    const s = await w.connect();
    w.send(s, 'echo later', 600);
    await until('the hold', () => w.table.list().length === 1);
    w.setPolicy([{ shell: SHELL as 'cmd', command: 'echo later', limits: { maxCalls: 1 } }]);
    expect(await answerOf(s)).toMatchObject({ type: 'result' });
    expect([...w.usage.counts.values()]).toEqual([1]);
    w.send(s, 'echo later');
    expect(await answerOf(s)).toMatchObject({ type: 'refused', reason: 'exhausted' });
    expect(w.runs).toHaveLength(1);
  });

  it('a Deny answers refused: denied at once, with the reason, and runs nothing', async () => {
    const w = await world();
    const s = await w.connect();
    const id = w.send(s, 'echo later', 600);
    await until('the hold', () => w.table.list().length === 1);
    expect(w.table.deny(id, 'not on a Friday')).toMatchObject({ ok: true });
    const answer = await answerOf(s);
    expect(answer).toMatchObject({ type: 'refused', id, reason: 'denied' });
    expect((answer as { message: string }).message).toContain('not on a Friday');
    expect(w.runs).toHaveLength(0);
    expect(w.audit.events()).toEqual(['daemon-started', 'held', 'hold-ended', 'refused']);
    expect(w.audit.entries.find((e) => e.event === 'hold-ended')).toMatchObject({ outcome: 'denied', note: 'not on a Friday' });
    expect(w.audit.entries.find((e) => e.event === 'refused')).toMatchObject({ reason: 'denied' });
  });

  it('a Deny without a reason says that the owner denied it', async () => {
    const w = await world();
    const s = await w.connect();
    const id = w.send(s, 'echo later', 600);
    await until('the hold', () => w.table.list().length === 1);
    w.table.deny(id, undefined);
    const answer = (await answerOf(s)) as { message: string };
    expect(answer.message).toMatch(/denied/);
  });

  it('the deadline answers refused: not-listed and names the wait, runs nothing, and the refusal is listed as pending (one refusal)', async () => {
    const w = await world();
    const s = await w.connect();
    const id = w.send(s, 'echo later', 600);
    await until('the hold', () => w.table.list().length === 1);
    w.now.value += 600;
    const answer = await answerOf(s);
    expect(answer).toMatchObject({ type: 'refused', id, reason: 'not-listed' });
    expect((answer as { message: string }).message).toContain('waited 10m, nobody answered');
    expect(w.runs).toHaveLength(0);
    expect(w.audit.events()).toEqual(['daemon-started', 'held', 'hold-ended', 'refused']);
    expect(w.audit.entries.find((e) => e.event === 'hold-ended')).toMatchObject({ outcome: 'deadline' });
    expect(w.audit.entries.find((e) => e.event === 'refused')).toMatchObject({ reason: 'not-listed', shell: SHELL, command: 'echo later' });
  });

  it('caps a wait above its maximum and says so in the answer', async () => {
    const w = await world({ capSeconds: 120 });
    const s = await w.connect();
    w.send(s, 'echo later', 3600);
    await until('the hold', () => w.table.list().length === 1);
    expect(w.table.list()[0]).toMatchObject({ waitSeconds: 120, requestedSeconds: 3600, capped: true });
    w.now.value += 120;
    const answer = (await answerOf(s)) as { message: string; held?: unknown };
    expect(answer.message).toContain('capped');
    expect(answer.message).toContain('2m');
    expect(answer.held).toEqual({ waitSeconds: 120, requestedSeconds: 3600, capped: true });
  });

  it('drops the hold and audits it when the caller disconnects, and frees the slot', async () => {
    const w = await world();
    const s = await w.connect();
    w.send(s, 'echo later', 600);
    await until('the hold', () => w.table.list().length === 1);
    s.close();
    await until('the hold to end', () => w.table.list().length === 0);
    expect(w.audit.entries.find((e) => e.event === 'hold-ended')).toMatchObject({ outcome: 'disconnected' });
    expect(w.runs).toHaveLength(0);
  });

  it('refuses at once, and runs nothing, when the peer is revoked during the hold', async () => {
    const w = await world();
    const s = await w.connect();
    w.send(s, 'echo later', 600);
    await until('the hold', () => w.table.list().length === 1);
    w.state.revoked = true;
    w.setPolicy([{ shell: SHELL as 'cmd', command: 'echo later' }]);
    expect(await answerOf(s)).toMatchObject({ type: 'refused', reason: 'peer-revoked' });
    expect(w.runs).toHaveLength(0);
    expect(w.audit.entries.find((e) => e.event === 'hold-ended')).toMatchObject({ outcome: 'revoked' });
  });

  it('keeps waiting when a new policy version still does not list the command', async () => {
    const w = await world();
    const s = await w.connect();
    w.send(s, 'echo later', 600);
    await until('the hold', () => w.table.list().length === 1);
    w.setPolicy([{ shell: SHELL as 'cmd', command: 'echo something else' }]);
    await new Promise((r) => setTimeout(r, 30));
    expect(w.table.list()).toHaveLength(1);
    expect(w.runs).toHaveLength(0);
    w.now.value += 600;
    expect(await answerOf(s)).toMatchObject({ type: 'refused', reason: 'not-listed' });
    expect(w.runs).toHaveLength(0);
  });

  it('refuses as usual when the entry that matches after the wait is already expired (same authorize as a fresh request)', async () => {
    const w = await world();
    const s = await w.connect();
    w.send(s, 'echo later', 600);
    await until('the hold', () => w.table.list().length === 1);
    w.setPolicy([{ shell: SHELL as 'cmd', command: 'echo later', limits: { expiresAt: w.now.value - 5 } }]);
    expect(await answerOf(s)).toMatchObject({ type: 'refused', reason: 'expired' });
    expect(w.runs).toHaveLength(0);
    expect(w.audit.entries.find((e) => e.event === 'hold-ended')).toMatchObject({ outcome: 'refused' });
  });

  it('refuses a third held request of the same peer at once, naming the limit', async () => {
    const w = await world();
    const s1 = await w.connect();
    const s2 = await w.connect();
    const s3 = await w.connect();
    w.send(s1, 'echo one', 600);
    w.send(s2, 'echo two', 600);
    await until('two holds', () => w.table.list().length === 2);
    w.send(s3, 'echo three', 600);
    const answer = await answerOf(s3);
    expect(answer).toMatchObject({ type: 'refused', reason: 'hold-limit-peer' });
    expect(w.table.list()).toHaveLength(2);
    expect(w.runs).toHaveLength(0);
  });

  it('refuses a held request beyond the limit of the machine', async () => {
    const w = await world({ holds: new HoldTable({ perMachine: 1 }) });
    const s1 = await w.connect();
    const s2 = await w.connect();
    w.send(s1, 'echo one', 600);
    await until('the hold', () => w.table.list().length === 1);
    w.send(s2, 'echo two', 600);
    expect(await answerOf(s2)).toMatchObject({ type: 'refused', reason: 'hold-limit-machine' });
  });

  it('a held request counts as one refusal for the session cap: only when it is finally refused', async () => {
    const w = await world();
    const s = await w.connect();
    w.send(s, 'echo later', 600);
    await until('the hold', () => w.table.list().length === 1);
    expect(w.audit.events().filter((e) => e === 'refused')).toHaveLength(0);
    w.now.value += 600;
    await answerOf(s);
    expect(w.audit.events().filter((e) => e === 'refused')).toHaveLength(1);
  });

  it('refuses the hold when the audit cannot record it (no audit, no hold), and runs nothing', async () => {
    const w = await world({ auditFails: () => true });
    const s = await w.connect();
    w.send(s, 'echo later', 600);
    expect(await answerOf(s)).toMatchObject({ type: 'refused', reason: 'audit-unavailable' });
    expect(w.table.list()).toHaveLength(0);
  });

  it('refuses a wait that is not a whole number of seconds, naming the field', async () => {
    const w = await world();
    const s = await w.connect();
    w.send(s, 'echo later', 'ten' as unknown as number);
    const answer = await answerOf(s);
    expect(answer).toMatchObject({ type: 'refused', reason: 'bad-wait' });
    expect((answer as { message: string }).message).toContain('waitSeconds');
    w.send(s, 'echo later', 0);
    expect(await answerOf(s)).toMatchObject({ type: 'refused', reason: 'bad-wait' });
  });

  it('a target without holds answers the refusal at once (an older build, or holds disabled)', async () => {
    const w = await world({ noHolds: true });
    const s = await w.connect();
    w.send(s, 'echo later', 600);
    expect(await answerOf(s)).toMatchObject({ type: 'refused', reason: 'not-listed' });
  });

  it('a held request does not hold a command that is listed: it runs at once', async () => {
    const w = await world();
    const s = await w.connect();
    w.send(s, 'echo listed', 600);
    expect(await answerOf(s)).toMatchObject({ type: 'result' });
    expect(w.table.list()).toHaveLength(0);
    expect(w.audit.events()).toEqual(['accepted', 'completed']);
  });

  it('a second message while a request is held is refused and the hold goes on', async () => {
    const w = await world();
    const s = await w.connect();
    w.send(s, 'echo later', 600);
    await until('the hold', () => w.table.list().length === 1);
    s.send({ type: 'run', request: {} });
    expect(await answerOf(s)).toMatchObject({ type: 'refused', reason: 'unexpected-message' });
    expect(w.table.list()).toHaveLength(1);
    w.setPolicy([{ shell: SHELL as 'cmd', command: 'echo later' }]);
    expect(await answerOf(s)).toMatchObject({ type: 'result' });
  });
});

describe('runOnPeer with a wait', () => {
  const ask = async (w: Awaited<ReturnType<typeof world>>, session: PeerSession, command: string, extra: Partial<Parameters<typeof runOnPeer>[1]> = {}) =>
    runOnPeer(session, { identity: w.a, source: A, target: B, shell: SHELL as 'cmd', command, now: w.now.value, ...extra });

  it('returns the result of a command allowed during the wait', async () => {
    const w = await world();
    const s = await w.connect();
    const pending = ask(w, s, 'echo later', { waitSeconds: 600 });
    await until('the hold', () => w.table.list().length === 1);
    w.setPolicy([{ shell: SHELL as 'cmd', command: 'echo later' }]);
    expect(await pending).toMatchObject({ type: 'result', exitCode: 0 });
  });

  it('calls the progress callback with the seconds left while it waits', async () => {
    const w = await world();
    const s = await w.connect();
    const ticks: number[] = [];
    const pending = ask(w, s, 'echo later', { waitSeconds: 600, progress: { everyMs: 15, onTick: (left) => ticks.push(left) } });
    await until('two ticks', () => ticks.length >= 2);
    w.table.deny(w.table.list()[0]!.id, undefined);
    await pending;
    expect(ticks[0]).toBeLessThanOrEqual(600);
    expect(ticks[0]).toBeGreaterThan(590);
    const count = ticks.length;
    await new Promise((r) => setTimeout(r, 40));
    expect(ticks).toHaveLength(count);
  });

  it('names the likely cause when the connection ends while the request is held', async () => {
    const w = await world();
    const s = await w.connect();
    const pending = ask(w, s, 'echo later', { waitSeconds: 600 });
    await until('the hold', () => w.table.list().length === 1);
    s.close();
    await expect(pending).rejects.toThrow(/waiting for approval/);
  });
});
