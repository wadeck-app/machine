import { describe, expect, it } from 'vitest';
import { MAX_DELIVER_FRAME_BYTES, MAX_DELIVERS_PER_MINUTE, buildDeliverDocument, parseDeliverAck, parseDeliverDocument } from './documentDelivery.js';

const DOC = { body: { v: 2, kind: 'policy', to: 'x', id: 'abcdefghijklmnopqrstuv', issuedAt: 1, expiresAt: 2, payload: { sealed: 'zzz' } }, signature: 'sig' };

describe('deliver-document frame (decision 86)', () => {
  it('builds a frame that carries the signed document untouched and parses it back', () => {
    const frame = buildDeliverDocument(DOC as never);
    expect(frame).toEqual({ type: 'deliver-document', document: DOC });
    expect(parseDeliverDocument(frame)).toEqual({ ok: true, document: DOC });
  });

  it('refuses a frame that is not exactly {type, document}, each with its cause', () => {
    expect(parseDeliverDocument(null)).toMatchObject({ ok: false, message: expect.stringMatching(/must be an object/) });
    expect(parseDeliverDocument({ type: 'deliver-document' })).toMatchObject({ ok: false, message: expect.stringMatching(/document/) });
    expect(parseDeliverDocument({ type: 'deliver-document', document: 'x' })).toMatchObject({ ok: false, message: expect.stringMatching(/document/) });
    expect(parseDeliverDocument({ type: 'deliver-document', document: [] })).toMatchObject({ ok: false });
    expect(parseDeliverDocument({ type: 'deliver-document', document: DOC, extra: 1 })).toMatchObject({ ok: false, message: expect.stringMatching(/unknown field "extra"/) });
    expect(parseDeliverDocument({ type: 'other', document: DOC })).toMatchObject({ ok: false, message: expect.stringMatching(/type/) });
  });

  it('refuses a frame larger than the document cap, before anything reads the document', () => {
    const big = { ...DOC, signature: 'x'.repeat(MAX_DELIVER_FRAME_BYTES) };
    expect(parseDeliverDocument({ type: 'deliver-document', document: big })).toMatchObject({ ok: false, message: expect.stringMatching(/larger than/) });
  });

  it('allows 30 deliveries per minute per sender', () => {
    expect(MAX_DELIVERS_PER_MINUTE).toBe(30);
  });

  it('reads an ack: installed or already-installed only, anything else is not an acknowledgement', () => {
    expect(parseDeliverAck({ type: 'deliver-ack', id: 'abcdefghijklmnopqrstuv', outcome: 'installed' })).toEqual({ ok: true, id: 'abcdefghijklmnopqrstuv', outcome: 'installed' });
    expect(parseDeliverAck({ type: 'deliver-ack', id: 'abcdefghijklmnopqrstuv', outcome: 'already-installed' })).toMatchObject({ ok: true, outcome: 'already-installed' });
    expect(parseDeliverAck({ type: 'deliver-ack', id: 'abc', outcome: 'maybe' })).toMatchObject({ ok: false });
    expect(parseDeliverAck({ type: 'refused', reason: 'x', message: 'y' })).toMatchObject({ ok: false });
    expect(parseDeliverAck('nope')).toMatchObject({ ok: false });
  });
});
