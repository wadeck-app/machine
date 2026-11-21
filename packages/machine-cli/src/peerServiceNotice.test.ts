import { randomBytes } from 'node:crypto';
import { HoldTable, applyPolicy, generateSigningKeyPair, keyId, newRequest, signPolicy, signRequest, type Json, type NoticeOutcome, type PolicyBody, type StoredNotice } from '@wadeck-app/machine-core';
import { connectToPeer, type PeerSession } from '@wadeck-app/machine-transport';
import { afterEach, describe, expect, it } from 'vitest';
import { startPeerListener, type PeerServiceDeps } from './peerService.js';
import type { NoticeRequest, RequestNotifier } from './requestNotifier.js';

// Request notices on the peer service (request-notices.md): the recipient side (frames of a trusted peer, stored) and the hooks of the sender side.

const A = '1b4e28ba-2fa1-4d3b-a3f4-0123456789ab';
const B = '9c5d1e2f-3a4b-4c6d-8e7f-abcdef012345';
const CALLER = '3b4e28ba-2fa1-4d3b-a3f4-0123456789ab';
const NOTICE_ID = '0a4e28ba-2fa1-4d3b-a3f4-0123456789ab';
const SHELL = process.platform === 'win32' ? 'cmd' : 'sh';

const closers: Array<() => void> = [];
afterEach(() => {
  while (closers.length > 0) closers.pop()?.();
});

const noticeFrame = (over: Record<string, unknown> = {}) => ({ type: 'request-notice', id: NOTICE_ID, peer: CALLER, peerName: 'caller', shell: 'sh', command: 'echo hi', commandTruncated: false, state: 'refused', deadline: null, ts: 1_800_000_000, ...over });
const endFrame = (over: Record<string, unknown> = {}) => ({ type: 'request-notice-end', id: NOTICE_ID, outcome: 'allowed', ts: 1_800_000_001, ...over });

async function world(over: { notices?: boolean; storeFails?: boolean; notifier?: RequestNotifier; holds?: boolean; policy?: boolean } = {}) {
  const admin = generateSigningKeyPair();
  const a = generateSigningKeyPair();
  const b = generateSigningKeyPair();
  const secret = randomBytes(32);
  const audit: Array<Record<string, Json>> = [];
  const problems: string[] = [];
  const stored: StoredNotice[] = [];
  const ended: Array<{ machine: string; id: string; outcome: string }> = [];
  const runs: unknown[] = [];
  const now = { value: 1_800_000_000 };
  const state = { revoked: false, storeFails: over.storeFails === true };
  let policy: PolicyBody | undefined;
  if (over.policy !== false) {
    const body: PolicyBody = { v: 1, target: B, version: 1, baseVersion: 0, adminKeyId: keyId(admin.publicKey), issuedAt: now.value, notBefore: now.value - 10, notAfter: now.value + 100_000, defaults: [{ shell: SHELL as 'cmd', command: 'echo listed' }], peers: {} };
    const applied = applyPolicy({ version: 0, highestSeen: 0 }, signPolicy(body, admin.privateKeyPkcs8), { adminPublicKey: admin.publicKey, now: now.value, targetUuid: B });
    if (!applied.ok) {
      throw new Error(applied.message);
    }
    policy = applied.body;
  }
  const table = new HoldTable();
  const deps: PeerServiceDeps = {
    self: { uuid: B, name: 'b', createdAt: '', identity: b },
    directory: { lookup: (key) => (key === a.publicKey && !state.revoked ? { peerId: A, name: 'a', pairSecret: secret } : undefined) },
    policy: () => policy,
    usage: { count: () => 0, record: () => undefined },
    audit: { write: (e) => void audit.push(e) },
    now: () => now.value,
    run: async (o) => {
      runs.push(o);
      return { exitCode: 0, stdout: '', stderr: '', timedOut: false, truncated: false, outputNotUtf8: false, durationMs: 1 };
    },
    onProblem: (m) => void problems.push(m),
    ...(over.notices === false
      ? {}
      : {
          notices: {
            record: (notice: StoredNotice) => {
              if (state.storeFails) {
                throw new Error('notices.json cannot be used (not valid JSON)');
              }
              stored.push(notice);
            },
            end: (machine: string, id: string, _now: number, outcome: string) => {
              if (state.storeFails) {
                throw new Error('notices.json cannot be used (not valid JSON)');
              }
              ended.push({ machine, id, outcome });
            },
          },
        }),
    ...(over.holds === true ? { holds: { table, pollMs: 3 } } : {}),
    ...(over.notifier ? { notifier: over.notifier } : {}),
  };
  const listener = await startPeerListener(deps, { host: '127.0.0.1', port: 0 });
  closers.push(() => listener.close());
  const connect = async (): Promise<PeerSession> => {
    const s = await connectToPeer({ identity: a, host: '127.0.0.1', port: listener.port, expectedPeerPublicKey: b.publicKey, pairSecret: secret });
    closers.push(() => s.close());
    return s;
  };
  const exchange = async (frame: unknown): Promise<any> => {
    const s = await connect();
    s.send(frame);
    return await s.next();
  };
  const sendRun = (session: PeerSession, command: string, waitSeconds?: number): string => {
    const body = newRequest({ source: A, target: B, shell: SHELL as 'cmd', command, now: now.value });
    session.send({ type: 'run', request: signRequest(body, a.privateKeyPkcs8), ...(waitSeconds !== undefined ? { waitSeconds } : {}) });
    return body.id;
  };
  return { audit, problems, stored, ended, runs, now, state, connect, exchange, sendRun, table };
}

describe('request notices: recipient side', () => {
  it('stores the notice of a trusted peer under the machine authenticated on the connection and acknowledges it', async () => {
    const w = await world();
    const answer = await w.exchange(noticeFrame({ peerName: 'someone-else' }));
    expect(answer).toEqual({ type: 'notice-ack', id: NOTICE_ID });
    expect(w.stored).toHaveLength(1);
    // The label is the sender of the connection (a, A), never a name inside the frame.
    expect(w.stored[0]).toMatchObject({ machine: A, machineName: 'a', receivedAt: 1_800_000_000, id: NOTICE_ID, peer: CALLER, peerName: 'someone-else', command: 'echo hi', state: 'refused' });
    const line = w.audit.find((e) => e.event === 'request-notice');
    expect(line).toMatchObject({ source: A, id: NOTICE_ID, state: 'refused' });
    // The command stays out of the audit log of the recipient.
    expect(JSON.stringify(w.audit)).not.toContain('echo hi');
    // Information only: nothing ran, no run was audited.
    expect(w.runs).toEqual([]);
    expect(w.audit.map((e) => e.event)).not.toContain('accepted');
  });

  it('the end frame drops the notice of that sender and is acknowledged', async () => {
    const w = await world();
    const answer = await w.exchange(endFrame());
    expect(answer).toEqual({ type: 'notice-ack', id: NOTICE_ID });
    // The outcome the sender reported goes to the store (decision 86): the Requests page tells the person how the hold ended.
    expect(w.ended).toEqual([{ machine: A, id: NOTICE_ID, outcome: 'allowed' }]);
    expect(w.audit.find((e) => e.event === 'request-notice-end')).toMatchObject({ source: A, id: NOTICE_ID, outcome: 'allowed' });
  });

  it('stores nothing for a peer revoked since the session began', async () => {
    const w = await world();
    const s = await w.connect();
    w.state.revoked = true;
    s.send(noticeFrame());
    const answer = (await s.next()) as { type: string; reason: string };
    expect(answer).toMatchObject({ type: 'refused', reason: 'peer-revoked' });
    expect(w.stored).toEqual([]);
  });

  it('refuses a bad frame as bad-notice, audited, and stores nothing', async () => {
    const w = await world();
    const answer = await w.exchange(noticeFrame({ command: 'echo \u0007' }));
    expect(answer).toMatchObject({ type: 'refused', reason: 'bad-notice' });
    expect(String(answer.message)).toContain('request-notice');
    expect(w.audit.find((e) => e.event === 'refused')).toMatchObject({ source: A, reason: 'bad-notice' });
    expect(w.stored).toEqual([]);
    const extra = await w.exchange(noticeFrame({ extra: 1 }));
    expect(extra).toMatchObject({ reason: 'bad-notice' });
    const badEnd = await w.exchange(endFrame({ outcome: 'weird' }));
    expect(badEnd).toMatchObject({ reason: 'bad-notice' });
  });

  it('drops the 31st frame of a minute: refused rate-limited, ONE audit line for the minute', async () => {
    const w = await world();
    const s = await w.connect();
    const answers: Array<{ type: string; reason?: string }> = [];
    for (let i = 0; i < 35; i++) {
      s.send(noticeFrame({ id: `0000000${i % 10}-2fa1-4d3b-a3f4-01234567${String(i).padStart(4, '0')}` }));
      answers.push((await s.next()) as never);
    }
    expect(answers.filter((x) => x.type === 'notice-ack')).toHaveLength(30);
    const limited = answers.filter((x) => x.reason === 'rate-limited');
    expect(limited).toHaveLength(5);
    expect(w.stored).toHaveLength(30);
    const lines = w.audit.filter((e) => e.event === 'request-notice-rate-limited');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ source: A, limit: 30 });
    // A dropped frame is not one audit line each.
    expect(w.audit.filter((e) => e.event === 'refused')).toEqual([]);
    // A minute later the sender is heard again, and the dropped count of the minute is reported once.
    w.now.value += 61;
    s.send(noticeFrame());
    expect(await s.next()).toMatchObject({ type: 'notice-ack' });
    const after = w.audit.filter((e) => e.event === 'request-notice-rate-limited');
    expect(after.at(-1)).toMatchObject({ dropped: 5 });
  });

  it('an older build (no notices dependency) answers unknown-message, as today', async () => {
    const w = await world({ notices: false });
    const answer = await w.exchange(noticeFrame());
    expect(answer).toMatchObject({ type: 'refused', reason: 'unknown-message' });
    const end = await w.exchange(endFrame());
    expect(end).toMatchObject({ type: 'refused', reason: 'unknown-message' });
  });

  it('a damaged store is reported once, answered notice-store-unavailable, and other sessions keep working', async () => {
    const w = await world({ storeFails: true });
    const first = await w.exchange(noticeFrame());
    expect(first).toMatchObject({ type: 'refused', reason: 'notice-store-unavailable' });
    expect(String(first.message)).toContain('deletes <configDir>/notices.json');
    const second = await w.exchange(noticeFrame());
    expect(second).toMatchObject({ reason: 'notice-store-unavailable' });
    expect(w.audit.filter((e) => e.event === 'request-notice-store-failed')).toHaveLength(1);
    expect(w.problems.filter((p) => p.includes('notices.json'))).toHaveLength(1);
    // Another kind of request on a new session is not affected.
    const s = await w.connect();
    w.sendRun(s, 'echo listed');
    expect(await s.next()).toMatchObject({ type: 'result' });
    // The store recovers: the next notice is accepted and the failure can be reported again.
    w.state.storeFails = false;
    expect(await w.exchange(noticeFrame())).toMatchObject({ type: 'notice-ack' });
  });
});

describe('request notices: sender hooks', () => {
  const recorder = () => {
    const calls: Array<{ call: string; request?: NoticeRequest; id?: string; outcome?: NoticeOutcome }> = [];
    const notifier: RequestNotifier = {
      held: (request) => void calls.push({ call: 'held', request }),
      refused: (request) => void calls.push({ call: 'refused', request }),
      ended: (id, outcome) => void calls.push({ call: 'ended', id, outcome }),
      whenIdle: async () => undefined,
      close: () => undefined,
    };
    return { calls, notifier };
  };

  it('a refusal without a wait is reported as refused, with the caller named by the target directory', async () => {
    const r = recorder();
    const w = await world({ notifier: r.notifier, holds: true });
    const s = await w.connect();
    const id = w.sendRun(s, 'echo not-listed');
    expect(await s.next()).toMatchObject({ type: 'refused', reason: 'not-listed' });
    expect(r.calls).toHaveLength(1);
    expect(r.calls[0]).toMatchObject({ call: 'refused', request: { id, peer: A, peerName: 'a', command: 'echo not-listed' } });
  });

  it('a held request is reported as held with its deadline, then ended with the outcome (deadline)', async () => {
    const r = recorder();
    const w = await world({ notifier: r.notifier, holds: true });
    const s = await w.connect();
    const id = w.sendRun(s, 'echo wait-me', 1);
    // The hold waits for the (real) deadline of 1 s on the injected clock: move the clock past it.
    await new Promise((resolve) => setTimeout(resolve, 30));
    w.now.value += 5;
    expect(await s.next()).toMatchObject({ type: 'refused', held: expect.anything() });
    expect(r.calls.map((c) => c.call)).toEqual(['held', 'ended']);
    expect(r.calls[0]).toMatchObject({ request: { id, peer: A, peerName: 'a', shell: SHELL, command: 'echo wait-me', deadline: 1_800_000_001 } });
    expect(r.calls[1]).toMatchObject({ id, outcome: 'deadline' });
  });

  it('a notifier that throws never changes the answer of the request', async () => {
    const boom: RequestNotifier = {
      held: () => {
        throw new Error('boom');
      },
      refused: () => {
        throw new Error('boom');
      },
      ended: () => {
        throw new Error('boom');
      },
      whenIdle: async () => undefined,
      close: () => undefined,
    };
    const w = await world({ notifier: boom, holds: true });
    const s = await w.connect();
    w.sendRun(s, 'echo not-listed');
    expect(await s.next()).toMatchObject({ type: 'refused', reason: 'not-listed' });
    expect(w.problems.join('\n')).toContain('boom');
  });
});
