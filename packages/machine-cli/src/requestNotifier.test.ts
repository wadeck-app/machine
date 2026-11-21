import type { Json } from '@wadeck-app/machine-core';
import { describe, expect, it } from 'vitest';
import { createRequestNotifier, type NoticePeer, type NotifierSession, type RequestNotifierDeps } from './requestNotifier.js';

// The sender side of request notices (request-notices.md): best effort, never blocks a request, backs off from an older build.

const SELF = '9c5d1e2f-3a4b-4c6d-8e7f-abcdef012345';
const ADMIN = '1b4e28ba-2fa1-4d3b-a3f4-0123456789ab';
const OTHER = '2b4e28ba-2fa1-4d3b-a3f4-0123456789ab';
const CALLER = '3b4e28ba-2fa1-4d3b-a3f4-0123456789ab';
const id = (n: number): string => `0000000${n}-0000-4000-8000-000000000000`;

const peerOf = (uuid: string): NoticePeer | undefined =>
  uuid === ADMIN || uuid === OTHER ? ({ peerId: uuid, name: uuid === ADMIN ? 'admin' : 'other', identityPublicKey: 'k', pairSecret: Buffer.alloc(32) } as NoticePeer) : undefined;

interface Script {
  /** The answer of the n-th connection (0-based), or a function; default: an ack. */
  answer?: (frame: { type: string; id: string }, n: number) => unknown;
  connectFails?: string;
  silent?: boolean;
}

function setup(over: Partial<RequestNotifierDeps> = {}, script: Script = {}) {
  const audit: Array<Record<string, Json>> = [];
  const frames: Array<{ type: string; id: string; [k: string]: unknown }> = [];
  const sleeps: number[] = [];
  const clock = { value: 1_800_000_000 };
  let connects = 0;
  const connect = async (): Promise<NotifierSession> => {
    const n = connects++;
    if (script.connectFails !== undefined) {
      throw new Error(script.connectFails);
    }
    let sent: { type: string; id: string } | undefined;
    return {
      send: (m) => {
        sent = m as { type: string; id: string };
        frames.push(m as never);
      },
      next: () => (script.silent ? new Promise(() => undefined) : Promise.resolve(script.answer ? script.answer(sent as never, n) : { type: 'notice-ack', id: sent?.id })),
      close: () => undefined,
    };
  };
  const notifier = createRequestNotifier({
    self: { uuid: SELF, name: 'laptop' },
    recipients: () => [ADMIN],
    peerOf,
    connect,
    audit: (e) => audit.push(e),
    problem: () => undefined,
    now: () => clock.value,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    ackTimeoutMs: 20,
    ...over,
  });
  return { notifier, audit, frames, sleeps, clock, connects: () => connects };
}

const request = (n: number) => ({ id: id(n), peer: CALLER, peerName: 'caller', shell: 'sh' as const, command: `echo ${n}`, deadline: 1_800_000_600 });

describe('request notifier', () => {
  it('sends one request-notice per held request to the recipient and nothing else', async () => {
    const t = setup();
    t.notifier.held(request(1));
    await t.notifier.whenIdle();
    expect(t.frames).toHaveLength(1);
    expect(t.frames[0]).toMatchObject({ type: 'request-notice', id: id(1), peer: CALLER, peerName: 'caller', shell: 'sh', command: 'echo 1', commandTruncated: false, state: 'held', deadline: 1_800_000_600, ts: 1_800_000_000 });
    expect(t.audit).toEqual([]);
  });

  it('sends state refused with a null deadline for a refusal that was not held', async () => {
    const t = setup();
    t.notifier.refused(request(1));
    await t.notifier.whenIdle();
    expect(t.frames[0]).toMatchObject({ type: 'request-notice', state: 'refused', deadline: null });
  });

  it('sends the end of a hold with its outcome', async () => {
    const t = setup();
    t.notifier.held(request(1));
    t.notifier.ended(id(1), 'allowed');
    await t.notifier.whenIdle();
    expect(t.frames.map((f) => f.type)).toEqual(['request-notice', 'request-notice-end']);
    expect(t.frames[1]).toMatchObject({ id: id(1), outcome: 'allowed' });
  });

  it('never sends to itself, and a recipient that is not a trusted peer gets ONE notice-undelivered', async () => {
    const t = setup({ recipients: () => [SELF, CALLER] });
    t.notifier.held(request(1));
    t.notifier.held(request(2));
    await t.notifier.whenIdle();
    expect(t.frames).toEqual([]);
    expect(t.audit.filter((e) => e.event === 'notice-undelivered')).toHaveLength(1);
    expect(t.audit[0]).toMatchObject({ event: 'notice-undelivered', recipient: CALLER, cause: 'recipient-not-a-peer' });
  });

  it('offline recipient: exactly 3 attempts 30 s apart, then ONE notice-undelivered naming the cause', async () => {
    const t = setup({}, { connectFails: 'connect ECONNREFUSED 10.0.0.2:47921' });
    t.notifier.held(request(1));
    await t.notifier.whenIdle();
    expect(t.connects()).toBe(3);
    expect(t.sleeps).toEqual([30_000, 30_000]);
    const undelivered = t.audit.filter((e) => e.event === 'notice-undelivered');
    expect(undelivered).toHaveLength(1);
    expect(undelivered[0]).toMatchObject({ recipient: ADMIN, recipientName: 'admin', id: id(1), attempts: 3 });
    expect(String(undelivered[0]?.cause)).toContain('unreachable');
    expect(String(undelivered[0]?.cause)).toContain('ECONNREFUSED');
    expect(JSON.stringify(t.audit)).not.toContain('echo 1');
  });

  it('a recipient that does not answer within the limit is a timeout, after 3 attempts', async () => {
    const t = setup({}, { silent: true });
    t.notifier.held(request(1));
    await t.notifier.whenIdle();
    expect(t.connects()).toBe(3);
    expect(String(t.audit[0]?.cause)).toContain('timeout');
  });

  it('stops retrying the start notice once the hold ended, and still attempts the end notice', async () => {
    let ended: (() => void) | undefined;
    const t = setup(
      {
        sleep: async () => {
          ended?.();
        },
      },
      { connectFails: 'down' },
    );
    ended = () => {
      ended = undefined;
      t.notifier.ended(id(1), 'deadline');
    };
    t.notifier.held(request(1));
    await t.notifier.whenIdle();
    // start: attempt 1, then (hold ended during the wait) no retry; end: 3 attempts.
    expect(t.connects()).toBe(1 + 3);
    expect(t.audit.filter((e) => e.event === 'notice-undelivered')).toHaveLength(1);
    expect(t.audit[0]).toMatchObject({ id: id(1), kind: 'request-notice-end' });
  });

  it('no recipient list: ONE notice-no-recipient per process telling what to run', async () => {
    const t = setup({ recipients: () => undefined });
    t.notifier.held(request(1));
    t.notifier.refused(request(2));
    t.notifier.ended(id(1), 'allowed');
    await t.notifier.whenIdle();
    expect(t.frames).toEqual([]);
    const lines = t.audit.filter((e) => e.event === 'notice-no-recipient');
    expect(lines).toHaveLength(1);
    expect(String(lines[0]?.message)).toContain('machine admin distribute laptop');
    expect(String(lines[0]?.message)).toContain('machine cli update');
  });

  it('an older recipient (unknown-message): ONE frame and ONE notice-recipient-outdated for 5 held requests in the hour', async () => {
    const t = setup({}, { answer: () => ({ type: 'refused', reason: 'unknown-message', message: 'old' }) });
    for (let n = 1; n <= 5; n++) {
      t.notifier.held(request(n));
    }
    await t.notifier.whenIdle();
    expect(t.frames).toHaveLength(1);
    const lines = t.audit.filter((e) => e.event === 'notice-recipient-outdated');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ recipient: ADMIN, recipientName: 'admin' });
    expect(String(lines[0]?.message)).toContain('machine cli update');
    expect(t.audit.filter((e) => e.event === 'notice-undelivered')).toEqual([]);
    // After the hour the recipient is tried again.
    t.clock.value += 3601;
    t.notifier.held(request(6));
    await t.notifier.whenIdle();
    expect(t.frames).toHaveLength(2);
  });

  it('another refusal reason is a cause, retried, then ONE notice-undelivered', async () => {
    const t = setup({}, { answer: () => ({ type: 'refused', reason: 'rate-limited', message: 'slow down' }) });
    t.notifier.held(request(1));
    await t.notifier.whenIdle();
    expect(t.connects()).toBe(3);
    expect(String(t.audit[0]?.cause)).toContain('refused: rate-limited');
  });

  it('keeps at most 16 pending notices per recipient: the oldest is dropped with one audit line', async () => {
    const t = setup({ maxPending: 2, ackTimeoutMs: 5 }, { silent: true });
    t.notifier.held(request(1));
    t.notifier.held(request(2));
    t.notifier.held(request(3));
    await t.notifier.whenIdle();
    const dropped = t.audit.filter((e) => e.event === 'notice-undelivered' && e.cause === 'too-many-pending');
    expect(dropped).toHaveLength(1);
    expect(dropped[0]).toMatchObject({ id: id(1) });
  });

  it('a damaged recipients file is reported and notifies nobody, never throws', async () => {
    const problems: string[] = [];
    const t = setup({
      recipients: () => {
        throw new Error('notice-recipients.json cannot be used');
      },
      problem: (m) => problems.push(m),
    });
    expect(() => t.notifier.held(request(1))).not.toThrow();
    await t.notifier.whenIdle();
    expect(problems.join('\n')).toContain('notice-recipients.json cannot be used');
    expect(t.frames).toEqual([]);
  });
});
