import { randomBytes, randomUUID } from 'node:crypto';
import { decodeBase64urlStrict, verifyBytes } from './keys.js';
import { signingInput } from './canonical.js';
import { parseCallerAsk, type CallerAsk } from './callerAsk.js';
import { INPUT_MAX_BYTES_CEILING } from './inputDeclaration.js';
import { SHELLS, commandTextProblem, type Shell } from './policy.js';
import { isUuid } from './reference.js';
import { signDocument } from './signed.js';

// A command request: signed by the SOURCE machine's identity key, bound to one target, short-lived, single-use (T-04, T-29).
// The channel already authenticates the peer; the signature makes the request itself attributable and non-replayable
// on another target or after expiry.

export const REQUEST_DOMAIN = 'machine/request/v1';
export const MAX_REQUEST_LIFETIME_SECONDS = 60;
export const DEFAULT_REQUEST_LIFETIME_SECONDS = 30;
export const REQUEST_SKEW_SECONDS = 30;

export interface RequestBody {
  v: 1;
  id: string;
  nonce: string;
  source: string;
  target: string;
  shell: Shell;
  command: string;
  issuedAt: number;
  expiresAt: number;
  /**
   * What the caller asks the OWNER for (`machine run --times/--for/--why`, decision 96): inside the signed body, present only when asked (10 keys instead of 9).
   * An older target refuses the shape as malformed: nothing runs (fail closed). It only pre-fills the owner's Allow, it grants nothing.
   */
  ask?: CallerAsk;
  /**
   * The payload sent on stdin (stdin-input.md, decision 114): its size and SHA-256, inside the signed body (R3). Present only when a payload travels (a tenth or
   * eleventh key); an older target refuses the shape as malformed, so it never ignores an input (fail closed). The payload itself is NOT signed: its hash is.
   */
  input?: { bytes: number; sha256: string };
}

export interface SignedRequest {
  body: RequestBody;
  signature: string;
}

export function newRequest(input: { source: string; target: string; shell: Shell; command: string; now: number; lifetimeSeconds?: number; ask?: CallerAsk; input?: { bytes: number; sha256: string } }): RequestBody {
  return {
    v: 1,
    id: randomUUID(),
    nonce: randomBytes(16).toString('base64url'),
    source: input.source,
    target: input.target,
    shell: input.shell,
    command: input.command,
    issuedAt: input.now,
    expiresAt: input.now + (input.lifetimeSeconds ?? DEFAULT_REQUEST_LIFETIME_SECONDS),
    ...(input.ask !== undefined ? { ask: input.ask } : {}),
    ...(input.input !== undefined ? { input: { bytes: input.input.bytes, sha256: input.input.sha256 } } : {}),
  };
}

export function signRequest(body: RequestBody, privateKeyPkcs8: Uint8Array): SignedRequest {
  return { body, signature: signDocument(REQUEST_DOMAIN, body as never, privateKeyPkcs8) };
}

export type RequestFailure = 'malformed' | 'bad-signature' | 'wrong-target' | 'bad-ask' | 'lifetime-too-long' | 'not-yet-valid' | 'expired';
export type RequestResult = { ok: true; body: RequestBody } | { ok: false; reason: RequestFailure; message: string };

export interface VerifyRequestContext {
  /** Identity key of the registered source machine (from its admin-signed registration). */
  sourcePublicKey: string;
  /** UUID of the machine verifying: the request must be addressed to it. */
  selfUuid: string;
  now: number;
  skewSeconds?: number;
}

function malformed(why: string): RequestResult {
  return { ok: false, reason: 'malformed', message: `request refused: ${why}` };
}

function wellFormed(signed: unknown): signed is SignedRequest {
  if (typeof signed !== 'object' || signed === null) return false;
  const { body, signature } = signed as { body?: unknown; signature?: unknown };
  if (typeof signature !== 'string' || typeof body !== 'object' || body === null) return false;
  const b = body as Record<string, unknown>;
  if (b.v !== 1) return false;
  if (typeof b.id !== 'string' || !isUuid(b.id) || typeof b.source !== 'string' || !isUuid(b.source) || typeof b.target !== 'string' || !isUuid(b.target)) return false;
  if (typeof b.nonce !== 'string') return false;
  try {
    decodeBase64urlStrict(b.nonce, 16, 'nonce');
  } catch {
    return false;
  }
  if (typeof b.shell !== 'string' || !(SHELLS as readonly string[]).includes(b.shell)) return false;
  if (typeof b.command !== 'string' || commandTextProblem(b.command) !== undefined) return false;
  if (!Number.isSafeInteger(b.issuedAt) || !Number.isSafeInteger(b.expiresAt) || (b.expiresAt as number) <= (b.issuedAt as number)) return false;
  // The ask and the input are optional keys (9 to 11 in all); the content of the ask is checked after the signature (a refusal with the fix, not a generic malformed).
  let keys = 9;
  if ('ask' in b) {
    if (typeof b.ask !== 'object' || b.ask === null || Array.isArray(b.ask)) return false;
    keys += 1;
  }
  if ('input' in b) {
    const i = b.input as Record<string, unknown> | null;
    if (typeof i !== 'object' || i === null || Array.isArray(i) || Object.keys(i).length !== 2) return false;
    if (!Number.isSafeInteger(i.bytes) || (i.bytes as number) < 0 || (i.bytes as number) > INPUT_MAX_BYTES_CEILING) return false;
    if (typeof i.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(i.sha256)) return false;
    keys += 1;
  }
  return Object.keys(b).length === keys;
}

export function verifyRequest(signed: unknown, ctx: VerifyRequestContext): RequestResult {
  if (!wellFormed(signed)) return malformed('the request is not a well-formed machine request');
  const { body, signature } = signed;
  let input: Uint8Array;
  try {
    input = signingInput(REQUEST_DOMAIN, body as never);
  } catch {
    return malformed('the request cannot be canonicalized');
  }
  if (!verifyBytes(ctx.sourcePublicKey, input, signature)) {
    return { ok: false, reason: 'bad-signature', message: 'request refused: the signature does not match the registered key of the source machine' };
  }
  if (body.ask !== undefined) {
    const asked = parseCallerAsk(body.ask);
    if (!asked.ok) {
      return { ok: false, reason: 'bad-ask', message: `request refused: ${asked.message}; fix the --times, --for or --why of \`machine run\` (nothing was held, nothing ran; the target never clamps what a caller asks)` };
    }
  }
  if (body.target !== ctx.selfUuid) {
    return { ok: false, reason: 'wrong-target', message: 'request refused: it is addressed to another machine' };
  }
  if (body.expiresAt - body.issuedAt > MAX_REQUEST_LIFETIME_SECONDS) {
    return { ok: false, reason: 'lifetime-too-long', message: `request refused: it is valid for longer than ${MAX_REQUEST_LIFETIME_SECONDS} seconds` };
  }
  const skew = ctx.skewSeconds ?? REQUEST_SKEW_SECONDS;
  if (ctx.now < body.issuedAt - skew) {
    return { ok: false, reason: 'not-yet-valid', message: 'request refused: it is dated in the future; check that the clocks of both machines are correct' };
  }
  if (ctx.now > body.expiresAt + skew) {
    return { ok: false, reason: 'expired', message: 'request refused: it has expired; check that the clocks of both machines are correct' };
  }
  return { ok: true, body };
}

export type ReplayResult = { ok: true } | { ok: false; reason: 'replay' | 'busy'; message: string };

/** Remembers nonces until their request can no longer be accepted. Full of live entries means refusing, never forgetting. */
export class ReplayCache {
  private readonly seen = new Map<string, number>();

  constructor(private readonly maxEntries: number = 4096) {}

  accept(source: string, nonce: string, expiresAt: number, now: number, skewSeconds: number = REQUEST_SKEW_SECONDS): ReplayResult {
    for (const [key, until] of this.seen) if (until < now) this.seen.delete(key);
    const key = `${source}:${nonce}`;
    if (this.seen.has(key)) return { ok: false, reason: 'replay', message: 'request refused: this request was already received' };
    if (this.seen.size >= this.maxEntries) {
      return { ok: false, reason: 'busy', message: 'request refused: too many recent requests are being tracked; retry shortly' };
    }
    this.seen.set(key, expiresAt + skewSeconds);
    return { ok: true };
  }

  size(): number {
    return this.seen.size;
  }
}
