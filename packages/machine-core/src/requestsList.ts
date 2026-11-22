import { randomBytes, randomUUID } from 'node:crypto';
import { signingInput } from './canonical.js';
import { decodeBase64urlStrict, verifyBytes } from './keys.js';
import type { PolicyMode } from './policy.js';
import { isUuid } from './reference.js';
import { parseCallerAsk } from './callerAsk.js';
import { DEFAULT_PENDING_LIMIT, parseWaitingRenewal, printable, type PendingGroup, type WaitingRequest } from './requests.js';
import { signDocument } from './signed.js';

// The `requests-list` frame pair (decision 74): the ADMIN asks a peer for the requests that peer refused because the command is not
// allowed. One request frame, one answer frame, both read-only: nothing is run, nothing is written, no right is widened.
//
//   request  { "type": "requests-list", "request": { "body": RequestsListBody, "signature": base64url } }
//   answer   RequestsListAnswer (type "requests-list"), or the usual { "type": "refused", "reason", "message" }
//
// The request is signed with the ADMIN key (domain below), so a registered peer without the admin key cannot read what the other peers
// tried. It names the target, the machine whose channel carries it (`source`), a nonce and a lifetime of at most 60 seconds: it cannot be
// replayed, redirected to another target or used from another connection. The answer holds what `machine requests` shows locally and
// nothing else: the machine, its policy mode, the requests it HOLDS right now for `run --wait` (id, peer, shell, command, since, deadline: what
// the owner needs to allow or deny them) and the pending groups (peer, shell, command, count, first and last time).

export const REQUESTS_LIST_DOMAIN = 'machine/requests-list/v1';
export const REQUESTS_LIST_MAX_GROUPS = DEFAULT_PENDING_LIMIT;
/** Held requests an answer may carry: at least the highest limit per machine the owner may set (MAX_HELD_PER_MACHINE_SETTING, 50). */
export const REQUESTS_LIST_MAX_WAITING = 50;
export const REQUESTS_LIST_LIFETIME_SECONDS = 30;
export const REQUESTS_LIST_MAX_LIFETIME_SECONDS = 60;
export const REQUESTS_LIST_SKEW_SECONDS = 30;
/** Requests a peer may send per minute on a server (like the revocation exchanges). */
export const MAX_REQUESTS_LISTS_PER_MINUTE = 6;

export interface RequestsListBody {
  v: 1;
  id: string;
  nonce: string;
  /** UUID of the machine that sends the frame (the admin machine): it must be the one authenticated on the connection. */
  source: string;
  target: string;
  /** Groups wanted: 1 to REQUESTS_LIST_MAX_GROUPS. */
  limit: number;
  issuedAt: number;
  expiresAt: number;
}

export interface SignedRequestsList {
  body: RequestsListBody;
  signature: string;
}

export function newRequestsList(input: { source: string; target: string; limit: number; now: number; lifetimeSeconds?: number }): RequestsListBody {
  return {
    v: 1,
    id: randomUUID(),
    nonce: randomBytes(16).toString('base64url'),
    source: input.source,
    target: input.target,
    limit: input.limit,
    issuedAt: input.now,
    expiresAt: input.now + (input.lifetimeSeconds ?? REQUESTS_LIST_LIFETIME_SECONDS),
  };
}

export function signRequestsList(body: RequestsListBody, adminPrivateKeyPkcs8: Uint8Array): SignedRequestsList {
  return { body, signature: signDocument(REQUESTS_LIST_DOMAIN, body as never, adminPrivateKeyPkcs8) };
}

export type RequestsListFailure = 'malformed' | 'bad-signature' | 'wrong-target' | 'source-mismatch' | 'lifetime-too-long' | 'not-yet-valid' | 'expired';
export type RequestsListResult = { ok: true; body: RequestsListBody } | { ok: false; reason: RequestsListFailure; message: string };

export interface VerifyRequestsListContext {
  /** The pinned admin public key of the verifying machine. */
  adminPublicKey: string;
  selfUuid: string;
  /** UUID of the machine authenticated on this connection. */
  peerUuid: string;
  now: number;
}

function wellFormed(signed: unknown): signed is SignedRequestsList {
  if (typeof signed !== 'object' || signed === null) return false;
  const { body, signature } = signed as { body?: unknown; signature?: unknown };
  if (typeof signature !== 'string' || typeof body !== 'object' || body === null) return false;
  const b = body as Record<string, unknown>;
  if (b['v'] !== 1) return false;
  for (const key of ['id', 'source', 'target']) if (typeof b[key] !== 'string' || !isUuid(b[key] as string)) return false;
  if (typeof b['nonce'] !== 'string') return false;
  try {
    decodeBase64urlStrict(b['nonce'], 16, 'nonce');
  } catch {
    return false;
  }
  if (!Number.isSafeInteger(b['limit']) || (b['limit'] as number) < 1 || (b['limit'] as number) > REQUESTS_LIST_MAX_GROUPS) return false;
  if (!Number.isSafeInteger(b['issuedAt']) || !Number.isSafeInteger(b['expiresAt']) || (b['expiresAt'] as number) <= (b['issuedAt'] as number)) return false;
  return Object.keys(b).length === 8;
}

export function verifyRequestsList(signed: unknown, ctx: VerifyRequestsListContext): RequestsListResult {
  if (!wellFormed(signed)) return { ok: false, reason: 'malformed', message: 'request refused: it is not a well-formed requests-list request' };
  const { body, signature } = signed;
  let input: Uint8Array;
  try {
    input = signingInput(REQUESTS_LIST_DOMAIN, body as never);
  } catch {
    return { ok: false, reason: 'malformed', message: 'request refused: it cannot be canonicalized' };
  }
  if (!verifyBytes(ctx.adminPublicKey, input, signature)) {
    return { ok: false, reason: 'bad-signature', message: 'request refused: only the admin of this network may list the requests, and the signature does not match the admin key pinned on this machine' };
  }
  if (body.target !== ctx.selfUuid) return { ok: false, reason: 'wrong-target', message: 'request refused: it is addressed to another machine' };
  if (body.source !== ctx.peerUuid) return { ok: false, reason: 'source-mismatch', message: 'request refused: it names another machine than the one authenticated on this connection' };
  if (body.expiresAt - body.issuedAt > REQUESTS_LIST_MAX_LIFETIME_SECONDS) {
    return { ok: false, reason: 'lifetime-too-long', message: `request refused: it is valid for longer than ${REQUESTS_LIST_MAX_LIFETIME_SECONDS} seconds` };
  }
  if (ctx.now < body.issuedAt - REQUESTS_LIST_SKEW_SECONDS) return { ok: false, reason: 'not-yet-valid', message: 'request refused: it is dated in the future; check that the clocks of both machines are correct' };
  if (ctx.now > body.expiresAt + REQUESTS_LIST_SKEW_SECONDS) return { ok: false, reason: 'expired', message: 'request refused: it has expired; check that the clocks of both machines are correct' };
  return { ok: true, body };
}

export interface RequestsListData {
  id: string;
  machine: { uuid: string; name: string };
  policyMode: PolicyMode;
  /** Epoch seconds on the answering machine. */
  now: number;
  /** Only the line of a break goes on the wire: the text names local paths. */
  chain: { ok: true } | { ok: false; line: number };
  pendingTotal: number;
  allowedNow: number;
  /** Requests held right now for approval (`run --wait`), soonest deadline first. Always sent whole: a machine holds a handful at most. */
  waiting: WaitingRequest[];
  /** Newest first. */
  pending: PendingGroup[];
  /** Serial of the notice-recipients list this machine holds (request-notices.md); null: it holds none. Absent: an older build, which does not know the field. */
  noticeRecipientsSerial?: number | null;
}

export interface RequestsListAnswer extends RequestsListData {
  type: 'requests-list';
  /** True when groups were left out to fit the frame (or the limit asked): `pendingTotal` says how many there are. */
  truncated: boolean;
}

/** The answer frame: the groups are dropped from the oldest end until the JSON fits `maxBytes` (the frame cap of the channel). */
export function buildRequestsListAnswer(data: RequestsListData, maxBytes: number): RequestsListAnswer {
  const chain = data.chain.ok ? { ok: true as const } : { ok: false as const, line: data.chain.line };
  let pending = data.pending;
  for (;;) {
    const answer: RequestsListAnswer = { type: 'requests-list', ...data, chain, pending, truncated: pending.length < data.pendingTotal };
    if (Buffer.byteLength(JSON.stringify(answer)) <= maxBytes) return answer;
    if (pending.length === 0) throw new Error(`the requests-list answer does not fit the frame limit of ${maxBytes} bytes even without a group`);
    pending = pending.slice(0, pending.length - 1);
  }
}

export type ParsedAnswer = { ok: true; answer: RequestsListAnswer } | { ok: false; message: string };

const asRecord = (v: unknown): Record<string, unknown> | undefined => (typeof v === 'object' && v !== null && !Array.isArray(v) ? Object.fromEntries(Object.entries(v)) : undefined);
const isInt = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;

/** What the admin machine reads from a peer: validated strictly, every text reduced to bounded printable ASCII. */
export function parseRequestsListAnswer(raw: unknown, expectedId: string): ParsedAnswer {
  const bad = (why: string): ParsedAnswer => ({ ok: false, message: `the peer answered with a malformed requests list (${why}): it runs an incompatible version` });
  if (typeof raw !== 'object' || raw === null) return bad('not an object');
  const a = raw as Record<string, unknown>;
  if (a['type'] !== 'requests-list' || a['id'] !== expectedId) return bad('it answers another request');
  const machine = a['machine'] as { uuid?: unknown; name?: unknown } | null;
  if (typeof machine !== 'object' || machine === null || typeof machine.uuid !== 'string' || !isUuid(machine.uuid) || typeof machine.name !== 'string') return bad('machine');
  if (a['policyMode'] !== 'admin' && a['policyMode'] !== 'local') return bad('policyMode');
  if (!isInt(a['now']) || !isInt(a['pendingTotal']) || !isInt(a['allowedNow']) || typeof a['truncated'] !== 'boolean') return bad('counters');
  const chain = a['chain'] as { ok?: unknown; line?: unknown } | null;
  if (typeof chain !== 'object' || chain === null || (chain.ok !== true && !(chain.ok === false && isInt(chain.line)))) return bad('chain');
  if (!Array.isArray(a['pending']) || a['pending'].length > REQUESTS_LIST_MAX_GROUPS) return bad('pending');
  // An older peer has no held requests to tell: the field is absent, not an error.
  const rawWaiting: unknown = a['waiting'] === undefined ? [] : a['waiting'];
  if (!Array.isArray(rawWaiting) || rawWaiting.length > REQUESTS_LIST_MAX_WAITING) {
    return bad('waiting');
  }
  const waiting: WaitingRequest[] = [];
  for (const entry of rawWaiting) {
    const w = asRecord(entry);
    if (w === undefined || typeof w['id'] !== 'string' || !isUuid(w['id']) || typeof w['peer'] !== 'string' || !isUuid(w['peer'])) {
      return bad('a held request');
    }
    if (typeof w['shell'] !== 'string' || typeof w['command'] !== 'string' || !isInt(w['since']) || !isInt(w['deadline'])) {
      return bad('a held request');
    }
    // A renewal that is there must be a valid one: a peer that sends another shape runs an incompatible version, said loudly (never dropped).
    const renewal = w['renewal'] === undefined ? undefined : parseWaitingRenewal(w['renewal']);
    if (w['renewal'] !== undefined && renewal === undefined) {
      return bad('the renewal of a held request');
    }
    // The same for the ask of the caller: another shape is another version, said loudly.
    const asked = w['ask'] === undefined ? undefined : parseCallerAsk(w['ask']);
    if (asked !== undefined && !asked.ok) {
      return bad('the ask of a held request');
    }
    waiting.push({
      id: w['id'],
      peer: w['peer'],
      ...(typeof w['peerName'] === 'string' ? { peerName: printable(w['peerName'], 100) } : {}),
      shell: printable(w['shell'], 16),
      command: printable(w['command']),
      since: w['since'],
      deadline: w['deadline'],
      ...(renewal !== undefined ? { renewal } : {}),
      ...(asked?.ok === true ? { ask: asked.ask } : {}),
    });
  }
  const serial = a['noticeRecipientsSerial'];
  if (serial !== undefined && serial !== null && !isInt(serial)) {
    return bad('noticeRecipientsSerial');
  }
  const pending: PendingGroup[] = [];
  for (const g of a['pending'] as Array<Record<string, unknown>>) {
    if (typeof g !== 'object' || g === null || typeof g['peer'] !== 'string' || typeof g['shell'] !== 'string' || typeof g['command'] !== 'string' || typeof g['reason'] !== 'string') return bad('a group');
    if (!isUuid(g['peer']) || !isInt(g['count']) || !isInt(g['firstSeen']) || !isInt(g['lastSeen'])) return bad('a group');
    pending.push({
      peer: g['peer'],
      ...(typeof g['peerName'] === 'string' ? { peerName: printable(g['peerName'], 100) } : {}),
      shell: printable(g['shell'], 16),
      command: printable(g['command']),
      count: g['count'],
      firstSeen: g['firstSeen'],
      lastSeen: g['lastSeen'],
      reason: printable(g['reason'], 32),
    });
  }
  return {
    ok: true,
    answer: {
      type: 'requests-list',
      id: expectedId,
      machine: { uuid: machine.uuid, name: printable(machine.name, 100) },
      policyMode: a['policyMode'],
      now: a['now'],
      chain: chain.ok === true ? { ok: true } : { ok: false, line: chain.line as number },
      pendingTotal: a['pendingTotal'],
      allowedNow: a['allowedNow'],
      waiting,
      pending,
      truncated: a['truncated'],
      ...(serial === undefined ? {} : { noticeRecipientsSerial: serial }),
    },
  };
}
