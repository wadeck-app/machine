import { checkDenyReason } from './hold.js';

// The `request-deny` frame (decision 85): a machine named in the notice-recipients list of a TARGET tells that target to refuse a request it holds.
// Restricting only (hard rule 4): no signature. Who may send it is decided by the target from the authenticated connection, never from this frame.
// Everything here is untrusted input from a peer: strict fixed fields, bounded, printable ASCII. No I/O.

export const MAX_DENY_FRAME_BYTES = 1024;

export interface RequestDeny {
  type: 'request-deny';
  /** The id of the held request (a UUID), or a prefix of at least 6 hex characters as `machine requests` prints it. */
  id: string;
  reason?: string;
}

export interface ParsedRequestDeny {
  id: string;
  reason: string | undefined;
}

const ID = /^[0-9a-f-]{6,36}$/;

export function buildRequestDeny(input: { id: string; reason?: string }): RequestDeny {
  const reason = input.reason?.trim();
  return { type: 'request-deny', id: input.id, ...(reason === undefined || reason === '' ? {} : { reason }) };
}

type Fail = { ok: false; message: string };

export function parseRequestDeny(message: unknown): { ok: true; deny: ParsedRequestDeny } | Fail {
  const fail = (m: string): Fail => ({ ok: false, message: `request-deny: ${m}` });
  if (typeof message !== 'object' || message === null || Array.isArray(message)) {
    return fail('the frame must be an object');
  }
  const m = message as Record<string, unknown>;
  for (const key of Object.keys(m)) {
    if (key !== 'type' && key !== 'id' && key !== 'reason') {
      return fail(`unknown field "${key}"`);
    }
  }
  if (m['type'] !== 'request-deny') {
    return fail('type must be "request-deny"');
  }
  if (typeof m['id'] !== 'string' || !ID.test(m['id'])) {
    return fail('id must be the id of a held request (6 to 36 hexadecimal characters and "-")');
  }
  if (m['reason'] !== undefined && typeof m['reason'] !== 'string') {
    return fail('reason must be text');
  }
  if (typeof m['reason'] === 'string' && Buffer.byteLength(JSON.stringify(message)) > MAX_DENY_FRAME_BYTES) {
    return fail(`the frame is larger than ${MAX_DENY_FRAME_BYTES} bytes`);
  }
  const checked = checkDenyReason(m['reason'] as string | undefined);
  if (!checked.ok) {
    return fail(checked.message);
  }
  return { ok: true, deny: { id: m['id'], reason: checked.reason } };
}
