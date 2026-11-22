import { describe, expect, it } from 'vitest';
import type { SignedDocument } from '@wadeck-app/machine-core';
import { createDirectDelivery, describeAttempt, type DeliverSession } from './directDelivery.js';
import type { PeerToReach } from './peerConnect.js';

// The sender side of `deliver-document` (decision 86): connect once (3 s), send the sealed document, read the acknowledgement. Every way it can fail
// returns a cause for the person and lets the caller use the relay inbox.

const TO = { uuid: '9c5d1e2f-3a4b-4c6d-8e7f-abcdef012345', name: 'thinkcentre' };
const DOC = { body: { v: 2, kind: 'policy', to: TO.uuid, id: 'abcdefghijklmnopqrstuv', issuedAt: 1, expiresAt: 2, payload: { sealed: 'zzz' } }, signature: 'sig' } as unknown as SignedDocument;
const PEER: PeerToReach = { peerId: TO.uuid, name: 'thinkcentre', identityPublicKey: 'k', pairSecret: Buffer.alloc(32) };

interface Fake extends DeliverSession {
  sent: unknown[];
  closed: boolean;
}

function session(answer: () => Promise<unknown>): Fake {
  const s: Fake = {
    sent: [],
    closed: false,
    send: (m) => void s.sent.push(m),
    next: answer,
    close: () => void (s.closed = true),
  };
  return s;
}

const NOW = 1_795_343_366;

function make(over: { now?: number; answer?: () => Promise<unknown>; connect?: () => Promise<DeliverSession>; peer?: PeerToReach | undefined; ackTimeoutMs?: number } = {}) {
  const sessions: Fake[] = [];
  const connects: string[] = [];
  const clock = { t: 1000 };
  const delivery = createDirectDelivery({
    peerOf: () => ('peer' in over ? over.peer : PEER),
    connect: async (peer) => {
      connects.push(peer.name);
      if (over.connect) {
        return await over.connect();
      }
      const s = session(over.answer ?? (async () => ({ type: 'deliver-ack', id: DOC.body.id, outcome: 'installed' })));
      sessions.push(s);
      return s;
    },
    clock: () => (clock.t += 400),
    now: () => over.now ?? NOW,
    ...(over.ackTimeoutMs !== undefined ? { ackTimeoutMs: over.ackTimeoutMs } : {}),
  });
  return { delivery, sessions, connects };
}

describe('direct delivery', () => {
  it('sends the document as the deliver-document frame and reports the outcome with the time it took', async () => {
    const w = make();
    const r = await w.delivery(TO, DOC);
    expect(r).toEqual({ ok: true, outcome: 'installed', ms: 400 });
    expect(w.sessions[0]?.sent).toEqual([{ type: 'deliver-document', document: DOC }]);
    expect(w.sessions[0]?.closed).toBe(true);
  });

  it('keeps the clock the target reported in its acknowledgement', async () => {
    const w = make({ answer: async () => ({ type: 'deliver-ack', id: DOC.body.id, outcome: 'installed', peerNow: NOW - 5 }) });
    expect(await w.delivery(TO, DOC)).toEqual({ ok: true, outcome: 'installed', ms: 400, peerNow: NOW - 5 });
  });

  it('a not-yet-valid refusal carries the MEASURED skew and the fix, from the clock of the target', async () => {
    const w = make({ answer: async () => ({ type: 'refused', reason: 'not-yet-valid', message: 'policy refused (not-yet-valid): policy can be applied from 2026-11-22T10:29:26.000Z', peerNow: NOW - 196 }) });
    const r = await w.delivery(TO, DOC);
    expect(r).toMatchObject({ ok: false, code: 'refused', peerNow: NOW - 196 });
    if (!r.ok) {
      expect(r.cause).toContain("thinkcentre's clock is 3 min 16 s behind this machine (its time 10:26:10, this machine 10:29:26): fix its time sync");
      expect(r.cause).not.toContain('check the clocks');
    }
  });

  it('a refusal without peerNow (an older build) keeps the target message as it is', async () => {
    const w = make({ answer: async () => ({ type: 'refused', reason: 'not-yet-valid', message: 'policy refused (not-yet-valid): later' }) });
    const r = await w.delivery(TO, DOC);
    expect(r).toMatchObject({ ok: false, cause: expect.stringMatching(/thinkcentre refused the document \(not-yet-valid\): policy refused/) });
  });

  it('reports already-installed as a delivery too', async () => {
    const w = make({ answer: async () => ({ type: 'deliver-ack', id: DOC.body.id, outcome: 'already-installed' }) });
    expect(await w.delivery(TO, DOC)).toMatchObject({ ok: true, outcome: 'already-installed' });
  });

  it('a refusal is not a delivery: the reason and the message of the target are the cause', async () => {
    const w = make({ answer: async () => ({ type: 'refused', reason: 'install-refused', message: 'policy refused (rollback): older' }) });
    const r = await w.delivery(TO, DOC);
    expect(r).toMatchObject({ ok: false, code: 'refused', cause: expect.stringMatching(/thinkcentre refused the document \(install-refused\): policy refused \(rollback\)/) });
    expect(w.sessions[0]?.closed).toBe(true);
  });

  it('an older build (unknown-message) says to update it', async () => {
    const w = make({ answer: async () => ({ type: 'refused', reason: 'unknown-message', message: 'this machine only understands {"type":"run"} requests' }) });
    expect(await w.delivery(TO, DOC)).toMatchObject({ ok: false, code: 'peer-too-old', cause: expect.stringMatching(/older build.*machine cli update/) });
  });

  it('a target that cannot be reached is unreachable with the connection error as cause, and is not tried again by the same delivery', async () => {
    const w = make({
      connect: async () => {
        throw new Error('cannot reach 10.0.0.5:47921: connect timed out');
      },
    });
    const first = await w.delivery(TO, DOC);
    expect(first).toMatchObject({ ok: false, code: 'unreachable', cause: expect.stringMatching(/connect timed out/) });
    const second = await w.delivery(TO, DOC);
    expect(second).toMatchObject({ ok: false, code: 'unreachable', cause: expect.stringMatching(/connect timed out/) });
    expect(w.connects).toHaveLength(1);
  });

  it('no acknowledgement in time is no-answer, and the connection is closed', async () => {
    const w = make({ answer: () => new Promise(() => undefined), ackTimeoutMs: 20 });
    expect(await w.delivery(TO, DOC)).toMatchObject({ ok: false, code: 'no-answer', cause: expect.stringMatching(/no answer from thinkcentre within 20 ms/) });
    expect(w.sessions[0]?.closed).toBe(true);
  });

  it('a connection that breaks before the answer is no-answer with the reason', async () => {
    const w = make({
      answer: async () => {
        throw new Error('connection closed');
      },
    });
    expect(await w.delivery(TO, DOC)).toMatchObject({ ok: false, code: 'no-answer', cause: expect.stringMatching(/connection closed/) });
  });

  it('an answer that is not an acknowledgement is unexpected, never a success', async () => {
    const w = make({ answer: async () => ({ type: 'result', id: 'x' }) });
    expect(await w.delivery(TO, DOC)).toMatchObject({ ok: false, code: 'unexpected-answer', cause: expect.stringMatching(/not an acknowledgement/) });
  });

  it('a machine this one does not trust cannot be reached directly (nothing is connected)', async () => {
    const w = make({ peer: undefined });
    expect(await w.delivery(TO, DOC)).toMatchObject({ ok: false, code: 'unknown-peer' });
    expect(w.connects).toHaveLength(0);
  });

  it('an acknowledgement for another document is not a delivery', async () => {
    const w = make({ answer: async () => ({ type: 'deliver-ack', id: 'otherotherotherotherot', outcome: 'installed' }) });
    expect(await w.delivery(TO, DOC)).toMatchObject({ ok: false, code: 'unexpected-answer' });
  });
});

describe('describeAttempt', () => {
  it('words a direct delivery for the success colour', () => {
    expect(describeAttempt('thinkcentre', { ok: true, outcome: 'installed', ms: 412 })).toBe('Delivered directly to thinkcentre (installed, 0.4 s)');
    expect(describeAttempt('thinkcentre', { ok: true, outcome: 'already-installed', ms: 12 })).toBe('Delivered directly to thinkcentre (already-installed, 0.0 s)');
  });

  it('words a fallback with its cause for the warning colour', () => {
    expect(describeAttempt('thinkcentre', { ok: false, code: 'unreachable', cause: 'connect timed out', ms: 3000 })).toBe(
      'thinkcentre is not reachable directly: stored in the relay inbox, it installs it when it comes back (next poll within 60 s, or 5 s while it holds a request). Cause: connect timed out',
    );
  });
});
