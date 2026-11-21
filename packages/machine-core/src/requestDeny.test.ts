import { describe, expect, it } from 'vitest';
import { MAX_DENY_FRAME_BYTES, buildRequestDeny, parseRequestDeny } from './requestDeny.js';

const ID = '3f1c2d3e-4a5b-4c6d-8e7f-0a1b2c3d4e5f';

describe('request-deny frame (decision 85)', () => {
  it('builds a small frame and parses it back, with and without a reason', () => {
    const plain = buildRequestDeny({ id: ID });
    expect(plain).toEqual({ type: 'request-deny', id: ID });
    expect(parseRequestDeny(plain)).toEqual({ ok: true, deny: { id: ID, reason: undefined } });
    const withReason = buildRequestDeny({ id: ID, reason: '  not now  ' });
    expect(parseRequestDeny(withReason)).toEqual({ ok: true, deny: { id: ID, reason: 'not now' } });
    expect(Buffer.byteLength(JSON.stringify(withReason))).toBeLessThan(MAX_DENY_FRAME_BYTES);
  });

  it('accepts an id prefix of at least 6 hex characters (what `machine requests` prints)', () => {
    expect(parseRequestDeny({ type: 'request-deny', id: ID.slice(0, 8) })).toMatchObject({ ok: true });
  });

  it('refuses unknown fields, a wrong type, a bad id and a bad reason, each with its cause', () => {
    expect(parseRequestDeny({ type: 'request-deny', id: ID, extra: 1 })).toMatchObject({ ok: false, message: expect.stringMatching(/unknown field "extra"/) });
    expect(parseRequestDeny({ type: 'request-denyy', id: ID })).toMatchObject({ ok: false });
    expect(parseRequestDeny({ type: 'request-deny', id: 'x;y' })).toMatchObject({ ok: false, message: expect.stringMatching(/id/) });
    expect(parseRequestDeny({ type: 'request-deny' })).toMatchObject({ ok: false, message: expect.stringMatching(/id/) });
    expect(parseRequestDeny({ type: 'request-deny', id: ID, reason: 42 })).toMatchObject({ ok: false, message: expect.stringMatching(/reason must be text/) });
    expect(parseRequestDeny({ type: 'request-deny', id: ID, reason: 'café' })).toMatchObject({ ok: false, message: expect.stringMatching(/printable ASCII/) });
    expect(parseRequestDeny({ type: 'request-deny', id: ID, reason: 'x'.repeat(201) })).toMatchObject({ ok: false, message: expect.stringMatching(/at most 200/) });
    expect(parseRequestDeny(null)).toMatchObject({ ok: false });
  });
});
