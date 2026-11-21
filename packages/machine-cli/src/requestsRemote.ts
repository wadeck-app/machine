import { newRequestsList, parseRequestsListAnswer, printable, signRequestsList, type RequestsListAnswer, type SignedRequestsList } from '@wadeck-app/machine-core';
import type { PeerSession } from '@wadeck-app/machine-transport';

// Client side of the `requests-list` frame pair (machine-core requestsList.ts, decision 74): the admin machine asks a peer for the
// requests it refused because the command is not allowed. Read-only on both sides.

export const REQUESTS_ANSWER_TIMEOUT_MS = 15_000;
export const PEER_TOO_OLD_MESSAGE = 'the peer is too old to list its requests (it does not know the requests-list message): update it with `machine cli update` on that machine';

export interface ListRequestsInput {
  /** The admin key, unlocked by the caller (one passphrase) and dropped after the call. */
  adminPrivateKeyPkcs8: Uint8Array;
  /** UUID of this machine (the one authenticated on the connection). */
  source: string;
  target: string;
  /** 1 to 100 groups. */
  limit: number;
  /** Epoch seconds. */
  now: number;
  timeoutMs?: number;
}

/** `warnings`: problems of this machine's own bookkeeping that do not change the answer (shown, never fatal). */
export type ListRequestsResult = { ok: true; answer: RequestsListAnswer; warnings?: string[] } | { ok: false; reason: string; message: string };

/** Signs a request with the admin key (CLI path) and sends it. */
export async function listRequestsOnPeer(session: PeerSession, input: ListRequestsInput): Promise<ListRequestsResult> {
  const body = newRequestsList({ source: input.source, target: input.target, limit: input.limit, now: input.now });
  return sendSignedRequestsList(session, signRequestsList(body, input.adminPrivateKeyPkcs8), input.timeoutMs);
}

/** Sends a request that was signed elsewhere (the browser, through the module backend) and reads the answer. */
export async function sendSignedRequestsList(session: PeerSession, signed: SignedRequestsList, timeoutMs: number = REQUESTS_ANSWER_TIMEOUT_MS): Promise<ListRequestsResult> {
  session.send({ type: 'requests-list', request: signed });
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`no answer from the peer within ${timeoutMs} ms: it may be busy or unreachable; check \`machine status\` on the peer machine`)), timeoutMs);
  });
  let answer: unknown;
  try {
    answer = await Promise.race([session.next(), deadline]);
  } finally {
    clearTimeout(timer);
  }
  if (typeof answer === 'object' && answer !== null && (answer as { type?: unknown }).type === 'refused') {
    const refused = answer as { reason?: unknown; message?: unknown };
    const reason = typeof refused.reason === 'string' ? refused.reason : 'refused';
    // An older build refuses any message other than `run` as `unknown-message`.
    if (reason === 'unknown-message') return { ok: false, reason: 'peer-too-old', message: PEER_TOO_OLD_MESSAGE };
    // The text comes from the peer: bounded printable ASCII only.
    return { ok: false, reason: printable(reason, 40), message: typeof refused.message === 'string' ? printable(refused.message, 400) : 'the peer refused the request' };
  }
  const parsed = parseRequestsListAnswer(answer, signed.body.id);
  return parsed.ok ? { ok: true, answer: parsed.answer } : { ok: false, reason: 'malformed-answer', message: parsed.message };
}
