import { describe, expect, it } from 'vitest';
import { PEER_TOO_OLD_DENY_MESSAGE, denyOnPeer } from './denyRemote.js';

// The sender side of `request-deny` (decision 85): one frame, one answer, every failure with its cause and fix.

const ID = '3f1c2d3e-4a5b-4c6d-8e7f-0a1b2c3d4e5f';

const session = (answer: unknown | Error) => {
  const sent: unknown[] = [];
  return {
    sent,
    send: (m: unknown) => void sent.push(m),
    next: () => (answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer)),
    close: () => undefined,
  };
};

describe('denyOnPeer', () => {
  it('sends request-deny with the id and the trimmed reason and returns the acknowledged id', async () => {
    const s = session({ type: 'deny-ack', id: ID });
    expect(await denyOnPeer(s as never, { id: ID.slice(0, 8), reason: ' not now ', peerName: 'thinkcentre' })).toEqual({ ok: true, id: ID });
    expect(s.sent).toEqual([{ type: 'request-deny', id: ID.slice(0, 8), reason: 'not now' }]);
  });

  it('an older target (unknown-message) says to update it on that machine', async () => {
    const r = await denyOnPeer(session({ type: 'refused', reason: 'unknown-message', message: 'x' }) as never, { id: ID, peerName: 'thinkcentre' });
    expect(r).toMatchObject({ ok: false, reason: 'peer-too-old' });
    expect((r as { message: string }).message).toContain('machine cli update');
    expect((r as { message: string }).message).toContain('thinkcentre');
    expect(PEER_TOO_OLD_DENY_MESSAGE('thinkcentre')).toContain('thinkcentre');
  });

  it('a refusal of the target keeps its reason and its message (bounded printable text)', async () => {
    const r = await denyOnPeer(session({ type: 'refused', reason: 'not-a-recipient', message: 'it does not list you: run `machine admin notify-to`' }) as never, { id: ID, peerName: 'thinkcentre' });
    expect(r).toEqual({ ok: false, reason: 'not-a-recipient', message: 'it does not list you: run `machine admin notify-to`' });
  });

  it('an answer that is not an ack is reported as an incompatible version, not as success', async () => {
    expect(await denyOnPeer(session({ type: 'result' }) as never, { id: ID, peerName: 't' })).toMatchObject({ ok: false, reason: 'unexpected-answer' });
    expect(await denyOnPeer(session({ type: 'deny-ack', id: 12 }) as never, { id: ID, peerName: 't' })).toMatchObject({ ok: false, reason: 'unexpected-answer' });
  });

  it('no answer within the limit says so with the check to make', async () => {
    const never = { send: () => undefined, next: () => new Promise<never>(() => undefined), close: () => undefined };
    const r = await denyOnPeer(never as never, { id: ID, peerName: 'thinkcentre', timeoutMs: 20 });
    expect(r).toMatchObject({ ok: false, reason: 'no-answer', message: expect.stringMatching(/thinkcentre.*20 ms.*machine status/) });
  });

  it('a connection that breaks mid-answer is a named failure', async () => {
    const r = await denyOnPeer(session(new Error('connection closed')) as never, { id: ID, peerName: 'thinkcentre' });
    expect(r).toMatchObject({ ok: false, reason: 'no-answer', message: expect.stringContaining('connection closed') });
  });
});
