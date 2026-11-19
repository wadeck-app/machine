import { adminLoginFix, fullPairingFix, MACHINE_ADMIN_RELAY_COMMIT } from './adminAccess.js';
// Client of the relay API (relay-api.md v0.2 + pairing claim). The relay is untrusted: this client only moves opaque
// documents. The token is held in a closure and is never part of an error message, a log line or a returned value.

const TIMEOUT_MS = 15_000;

export interface RelayErrorInit {
  status: number;
  /** Machine code of an /api/machines error (`precondition_failed`, ...). Absent for pairing errors and network failures. */
  code?: string;
  /** Human text sent by the relay (pairing errors carry their text in `error`). */
  humanText?: string;
  message: string;
  retryAfterSeconds?: number;
  currentEtag?: string;
}

/** Status 0 means the relay was not reached at all (network failure, timeout). */
export class RelayError extends Error {
  readonly status: number;
  readonly code: string | undefined;
  readonly humanText: string | undefined;
  readonly retryAfterSeconds: number | undefined;
  readonly currentEtag: string | undefined;

  constructor(init: RelayErrorInit) {
    super(init.message);
    this.name = 'RelayError';
    this.status = init.status;
    this.code = init.code;
    this.humanText = init.humanText;
    this.retryAfterSeconds = init.retryAfterSeconds;
    this.currentEtag = init.currentEtag;
  }
}

/** The kinds of token a device login can ask for: a machine token, a machine-admin token (machine rights plus approving machines), a full-access token. */
export type DeviceAccess = 'machine' | 'machine-admin' | 'full';

/**
 * The relay does not support the device login of this access (`machine-admin`: older than poc-node 78fe5b2; `full`: older than poc-node 754a4c5):
 * nothing was stored and nothing falls back to another access by itself, the caller says what the person may choose. `pendingRequest` is true
 * when the relay started another login instead (it ignored the field): that request waits in the console and must be denied.
 */
export class AccessLoginUnsupportedError extends RelayError {
  readonly access: 'machine-admin' | 'full';
  readonly pendingRequest: boolean;
  constructor(init: RelayErrorInit & { access: 'machine-admin' | 'full'; pendingRequest?: boolean }) {
    super(init);
    this.name = 'AccessLoginUnsupportedError';
    this.access = init.access;
    this.pendingRequest = init.pendingRequest === true;
  }
}

export interface RelayClientOptions {
  baseUrl: string;
  token?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

export interface ClaimAnswer {
  token: string;
  label: string;
  /** Exactly ["machine"] for a machine claim; ["machine-admin"] or `null` (full access, legacy) for an admin claim (only `machine admin login` accepts those). */
  scopes: string[] | null;
}

export interface CandidacyPost {
  name: string;
  hostname: string;
  identityPublicKey: string;
  random: string;
  /** Canonical lower-case v4 UUID of this machine: the admin signs the registration for it (relay-api.md, Candidacy). */
  uuid: string;
}

/** Answer of `POST /api/device-login/start`. `deviceCode` is a secret: kept in memory, never printed or stored. */
export interface DeviceLoginStarted {
  deviceCode: string;
  userCode: string;
  expiresIn: number;
  pollIntervalSeconds: number;
  verificationUrl: string;
  /** What the relay says it started: always what was asked for an admin access (anything else is refused by the client). Absent for a machine login of an older relay. */
  access?: DeviceAccess;
}

export type DeviceLoginPoll =
  | { status: 'pending' }
  | { status: 'denied' }
  | { status: 'expired' }
  /** The relay asks for fewer polls: wait `retryAfterSeconds` (absent: the caller picks a longer interval). */
  | { status: 'slow_down'; retryAfterSeconds?: number }
  /** Delivered once. `scopes` is exactly ["machine"] for a machine login, ["machine-admin"] for a machine-admin one and `null` (full access) for a full-access one: anything else is refused by the client. */
  | { status: 'approved'; token: string; label: string; scopes: string[] | null };

export interface CandidacyPosted {
  id: string;
  createdAt: number;
  expiresAt: number;
}

export type CandidacyStatus = { status: 'pending' } | { status: 'approved'; approval: unknown } | { status: 'rejected' };

export interface PendingCandidacy extends Omit<CandidacyPost, 'uuid'> {
  id: string;
  /** Absent for an entry posted by an older `machine join`: `machine admin approve` refuses it. */
  uuid?: string;
  /** Deployed relay (ownership bound at approval): the uuid is already bound to a token. */
  uuidBound?: boolean;
  /** Label of the bound token, or "(revoked token)" when that token is gone. Present when `uuidBound` is true. */
  boundTokenLabel?: string;
  /** True: the uuid is bound to the token that posted this candidacy (a re-approval, not a rebind). */
  boundToCandidateToken?: boolean;
  observedIp: string;
  createdAt: number;
  expiresAt: number;
}

export interface SignedAddressRecord {
  body: { v: 1; uuid: string; addresses: { host: string; port: number }[]; seq: number; issuedAt: number };
  signature: string;
}

export interface MachineEntry {
  uuid: string;
  record: SignedAddressRecord;
  lastSeen: number | null;
  online: boolean;
}

/** One document of an inbox as the relay lists it. `document` is opaque here: the receiver verifies it (machine-core `verifyInboxDocument`). */
export interface InboxEntry {
  id: string;
  document: unknown;
  storedAt: number;
}

export type CandidacyDecision = { decision: 'approve'; approval: unknown } | { decision: 'reject' };

/** The relay URL as the user typed it, validated: https, except plain http on loopback (tests, local relay). No trailing slash. */
export function normalizeRelayUrl(input: string): string {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new Error(`invalid relay URL "${input}": expected something like https://relay.example.com`);
  }
  const loopback = url.hostname === '127.0.0.1' || url.hostname === 'localhost';
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new Error(`relay URL "${input}" must use https (plain http is only accepted for 127.0.0.1 and localhost): use an https URL such as https://relay.example.com`);
  }
  if (url.username !== '' || url.password !== '') throw new Error('the relay URL must not contain credentials: the token is stored separately');
  if (url.search !== '' || url.hash !== '') throw new Error(`relay URL "${input}" must not contain a query or a fragment`);
  return `${url.origin}${url.pathname}`.replace(/\/+$/, '');
}

const MAX_INBOX_PAGE_BYTES = 1024 * 1024;
/** Default cap of an answer: every call has one, a relay is untrusted and must not make this machine buffer an answer of any size. */
const MAX_ANSWER_BYTES = 64 * 1024;
/** One address record (2 KiB) with its envelope. */
const MAX_MACHINE_ANSWER_BYTES = 4 * 1024;
/** 1000 machines of 2 KiB with their presence. */
const MAX_MACHINES_ANSWER_BYTES = 3 * 1024 * 1024;

const formatLimit = (bytes: number): string => (bytes >= 1024 * 1024 ? `${bytes / (1024 * 1024)} MiB` : `${bytes / 1024} KiB`);

/** Reads the body of an answer, giving up (loudly) as soon as it is larger than `max` bytes. */
async function readLimited(res: Response, max: number, baseUrl: string, what: string): Promise<string> {
  const tooLarge = () =>
    new RelayError({ status: 0, message: `the relay ${baseUrl} sent an answer larger than ${formatLimit(max)} for ${what}: it does not follow the contract, tell the relay owner. Reading stopped, nothing from it was used` });
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > max) throw tooLarge();
  if (res.body === null) return '';
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read().catch(() => ({ done: true, value: undefined }));
    if (done) break;
    total += (value as Uint8Array).length;
    if (total > max) {
      await reader.cancel().catch(() => undefined);
      throw tooLarge();
    }
    chunks.push(value as Uint8Array);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export interface RelayClient {
  readonly baseUrl: string;
  /**
   * `access` is the kind of token the caller agrees to store: a machine token (default, `join`: exactly ["machine"]) or an admin one (`admin login <code>`:
   * ["machine-admin"], or full access, which the caller warns about). The other kinds are refused and never returned.
   */
  claimPairing(code: string, access?: 'machine' | 'admin'): Promise<ClaimAnswer>;
  /** Public route (no Authorization header): asks the relay for a request the user confirms in the console. */
  deviceLoginStart(label: string, access?: DeviceAccess): Promise<DeviceLoginStarted>;
  /**
   * Public route (no Authorization header). The deviceCode is sent in the body only, never put in an error. `access` is the kind of token the caller
   * agrees to store: the other kind is refused and never returned.
   */
  deviceLoginPoll(deviceCode: string, access?: DeviceAccess): Promise<DeviceLoginPoll>;
  postCandidacy(candidacy: CandidacyPost): Promise<CandidacyPosted>;
  getCandidacy(id: string): Promise<CandidacyStatus>;
  putRecord(uuid: string, record: SignedAddressRecord, etag?: string): Promise<{ etag: string }>;
  /** `inboxCount` is the number of documents waiting for this machine, or undefined when the relay does not report it (not updated to distribution.md). */
  heartbeat(uuid: string): Promise<{ inboxCount: number | undefined }>;
  /** Admin only (machine-admin scope or full access). The same bytes again are accepted; other bytes under the same id are `id_conflict`. */
  putInboxDocument(uuid: string, document: { body: { id: string } }): Promise<void>;
  /** Every document waiting for `uuid`, oldest first (the loop over `more` and `next` is done here), at most `max` of them when given. The owner of the uuid, or the admin. */
  listInbox(uuid: string, max?: number): Promise<InboxEntry[]>;
  /** Idempotent: an unknown id is not an error. */
  deleteInboxDocument(uuid: string, id: string): Promise<void>;
  /** Admin only: removes the address record, the owner binding and the inbox of `uuid`. A machine the relay does not know is not an error. */
  deleteMachine(uuid: string): Promise<void>;
  getMachines(): Promise<MachineEntry[]>;
  getMachine(uuid: string): Promise<(MachineEntry & { etag?: string }) | undefined>;
  listCandidacies(): Promise<PendingCandidacy[]>;
  decideCandidacy(id: string, decision: CandidacyDecision): Promise<void>;
  /** Public route (no Authorization header): the version of the relay and its uptime. `undefined` when the relay has no such route (an older relay, or not a relay). */
  getVersion(): Promise<RelayVersion | undefined>;
  /** What the relay says about the token in use (scopes: `null` = full access). `undefined` when the relay has no `/api/whoami`. */
  whoami(): Promise<RelayWhoami | undefined>;
}

export interface RelayVersion {
  version: string;
  uptimeSeconds?: number;
}

export interface RelayWhoami {
  scopes: string[] | null;
  label?: string;
}

/** Text from the relay shown on a terminal: printable ASCII only, no escape sequence gets through. */
const printable = (text: string): string => text.replace(/[^\x20-\x7e]/g, '?');

const asObject = (value: unknown): Record<string, unknown> => (typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {});

export function createRelayClient(options: RelayClientOptions): RelayClient {
  const baseUrl = normalizeRelayUrl(options.baseUrl);
  const doFetch = options.fetch ?? globalThis.fetch;
  const token = options.token;
  const timeoutMs = options.timeoutMs ?? TIMEOUT_MS;
  // Canonical form: the relay's scope gate answers 403 (not 400) to an upper-case uuid.
  const uuidPath = (uuid: string) => encodeURIComponent(uuid.toLowerCase());
  const idPath = (id: string) => encodeURIComponent(id);

  interface Call {
    method: string;
    path: string;
    body?: unknown;
    headers?: Record<string, string>;
    /** Pairing routes answer `error` as human text, the others as a code plus `message`. */
    pairing?: boolean;
    /** The pairing is for `machine admin login` (an admin token): the advice in errors differs. */
    forAdmin?: boolean;
    /** Public route (device login): never sends the Authorization header, even when the client holds a token. */
    publicRoute?: boolean;
    /** Statuses returned as `undefined` instead of an error. */
    accept?: number[];
    /** The call is about the inbox of this machine (and this document): errors name them and give the inbox advice. */
    inbox?: { uuid: string; id?: string };
    /** The call writes the address record of this machine: errors name the uuid and the fix. */
    record?: { uuid: string };
    /** The call posts a candidacy: a 409 `candidacy_uuid_changed` is explained for the candidate. */
    candidacyPost?: boolean;
    /** The call is the admin decision on a candidacy: a 429 `too_many_machines` means it is still pending. */
    decision?: boolean;
    /** The answer is read at most this many bytes: a relay is untrusted and must not make this machine buffer an answer of any size. */
    maxBytes?: number;
    /** Names the call in the error of an oversized answer. */
    what?: string;
  }

  async function call(c: Call): Promise<{ status: number; body: Record<string, unknown>; headers: Headers } | undefined> {
    const url = `${baseUrl}${c.path}`;
    const headers: Record<string, string> = { Accept: 'application/json', ...(c.headers ?? {}) };
    if (token !== undefined && !c.pairing && !c.publicRoute) headers.Authorization = `Bearer ${token}`;
    if (c.body !== undefined) headers['Content-Type'] = 'application/json';
    let res: Response;
    try {
      res = await doFetch(url, {
        method: c.method,
        headers,
        ...(c.body !== undefined ? { body: JSON.stringify(c.body) } : {}),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      const name = (e as Error).name;
      const timedOut = name === 'TimeoutError' || name === 'AbortError';
      throw new RelayError({
        status: 0,
        message: timedOut
          ? `the relay ${baseUrl} did not answer within ${Math.round(timeoutMs / 1000)} s: check your connection and the URL, then try again`
          : `cannot reach the relay ${baseUrl} (${(e as Error).message}): check your connection and the URL (--relay <url>), then try again`,
      });
    }
    const text = await readLimited(res, c.maxBytes ?? MAX_ANSWER_BYTES, baseUrl, c.what ?? `${c.method} ${c.path.split('?')[0]}`);
    let body: Record<string, unknown> = {};
    if (text.length > 0) {
      try {
        body = asObject(JSON.parse(text));
      } catch {
        body = {};
      }
    }
    if (res.ok) return { status: res.status, body, headers: res.headers };
    if (c.accept?.includes(res.status)) return undefined;
    throw mapError(c, res.status, body, res.headers);
  }

  /**
   * The advice for a `429 too_many_machines`: the relay states its limit in `limit`, and tells the per-token case from the relay-wide cap by the
   * start of its message ("The relay holds ..."). The limit is configurable on the relay, so it is quoted, never assumed.
   */
  function tooManyMachines(limit: unknown, relayMessage: string | undefined): string {
    const free = 'free places with `machine admin forget-relay-record <machine|uuid>` for machines that are gone';
    const relayWide = relayMessage?.startsWith('The relay holds') === true;
    if (limit === undefined) {
      return relayWide
        ? 'the relay itself is full (it did not state its limit): tell the relay operator'
        : `this token already owns the maximum number of machines (the relay did not state its limit): ${free}`;
    }
    if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1) {
      return `the relay sent an invalid limit (${JSON.stringify(limit)}) with too_many_machines: tell the relay operator (the relay and this machine disagree on the format); ${free}`;
    }
    return relayWide
      ? `the relay itself is full (${limit} machines): tell the relay operator, who can raise its limit or remove machines`
      : `this token already owns the maximum (${limit}) machines; ${free}`;
  }

  function mapError(c: Call, status: number, body: Record<string, unknown>, headers: Headers): RelayError {
    const error = typeof body.error === 'string' ? body.error : undefined;
    const relayMessage = typeof body.message === 'string' ? body.message : undefined;
    const code = c.pairing ? undefined : error;
    const humanText = c.pairing ? error : relayMessage;
    const retryHeader = Number(headers.get('retry-after'));
    const retryBody = typeof body.retryAfterSeconds === 'number' ? body.retryAfterSeconds : undefined;
    const retryAfterSeconds = retryBody ?? (Number.isFinite(retryHeader) && headers.get('retry-after') !== null ? retryHeader : undefined);
    const currentEtag = typeof body.currentEtag === 'string' ? body.currentEtag : undefined;
    const detail = humanText ? `: ${humanText}` : code ? ` (${code})` : '';
    let message: string;
    if (c.pairing && (status === 400 || status === 401)) {
      message = c.forAdmin
        ? `the pairing code was refused${detail}: ${adminLoginFix()}`
        : `the pairing code was refused${detail}: ask the admin for a new code (Tokens, Add token, "Limited to scopes", machine) and run \`machine join <code>\` again`;
    } else if (c.pairing && status === 409) {
      message = `the pairing code was valid but is now used up${detail}: ${c.forAdmin ? adminLoginFix() : 'ask the admin for a new code and run `machine join <code>` again'}`;
    } else if (status === 403 && code === 'not_registered') {
      // The relay binds a uuid to a machine token only when the admin approves the candidacy (relay-api.md, ownership bound at approval).
      // The relay's own text comes first (in `detail`), then the client hint.
      message = `the relay ${baseUrl} does not know this machine as approved (not_registered)${detail}: this machine is not approved yet: run machine join and ask the admin to approve it`;
    } else if (c.record && status === 403 && code === 'not_owner') {
      message = `the relay ${baseUrl} refused the address record of this machine ${c.record.uuid} (not_owner)${detail}: another token is bound to this uuid (a uuid is bound to the token of the candidacy the admin approved): either the token of this machine was replaced, or the admin approved a candidacy of ANOTHER token for this uuid, which also withholds the inbox of this machine. Run \`machine join --resume\` (same token) or \`machine join <code> --force\` (new token) and ask the admin to approve the new candidacy: approving replaces the binding with the token of this machine (the admin is warned that it is a rebind); this daemon then publishes again by itself`;
    } else if (c.decision && status === 429 && code === 'too_many_machines') {
      // The relay's own text goes last: it ends with advice of its own and would break the sentence of ours.
      message = `the relay ${baseUrl} refused to approve this machine (too_many_machines): ${tooManyMachines(body.limit, relayMessage)}. The candidacy is still pending and nothing was approved: once there is room, run \`machine admin approve <id>\` again${relayMessage ? `. The relay said: ${relayMessage}` : ''}`;
    } else if (c.record && status === 429 && code === 'too_many_machines') {
      message = `the relay ${baseUrl} refused the address record of machine ${c.record.uuid} (too_many_machines): ${tooManyMachines(body.limit, relayMessage)}${relayMessage ? `. The relay said: ${relayMessage}` : ''}`;
    } else if (c.record && status === 400) {
      message = `the relay ${baseUrl} refused the address record of machine ${c.record.uuid} (${code ?? '400'})${detail}: the relay and this machine disagree on the record format, tell the relay owner and update machine`;
    } else if (c.inbox && status === 409 && code === 'id_conflict') {
      message = `the inbox of machine ${c.inbox.uuid} already holds a DIFFERENT document under the id ${c.inbox.id ?? '(unknown)'} (id_conflict)${detail}: the same document was built again with other bytes (a sealed secret is random). It is already on the relay; if the machine consumed it and you need it again, run \`machine admin distribute\``;
    } else if (c.inbox && status === 429 && code === 'too_many_documents') {
      message = `the inbox of machine ${c.inbox.uuid} is full${detail}: that machine is not draining it (its daemon is stopped, or it cannot read its inbox). Start the daemon there and check \`machine status\`; if the machine is gone run \`machine admin revoke <machine>\`, which also removes its inbox`;
    } else if (c.inbox && status === 429 && code === 'relay_inbox_full') {
      message = `the relay ${baseUrl} has no room left for inbox documents (relay_inbox_full)${detail}: this is the relay as a whole, not this machine; tell the relay owner, then run \`machine admin distribute <machine>\` again`;
    } else if (c.inbox && status === 403 && code === 'not_owner') {
      message = `this token does not own the inbox of machine ${c.inbox.uuid} (not_owner)${detail}: another token is bound to this uuid (the binding is made when the admin approves a candidacy). If the token of this machine was replaced, run \`machine join --resume\` (same token) or \`machine join <code> --force\` (new token) and ask the admin to approve the new candidacy: approving replaces the binding`;
    } else if (c.inbox && status === 413) {
      message = `the relay ${baseUrl} refused a document of this size (body_too_large)${detail}: a request is at most 32 KiB and a document at most 16 KiB; a policy this big must be split or reduced`;
    } else if (c.inbox && status === 400 && (code === 'invalid_cursor' || code === 'invalid_id')) {
      message = `the relay ${baseUrl} refused the inbox request (${code})${detail}: the relay and this machine disagree on the inbox format, tell the relay owner and update machine`;
    } else if (c.inbox && status === 404) {
      message = `the relay ${baseUrl} answered 404 for the inbox of machine ${c.inbox.uuid}${detail}: the relay may not be updated to the distribution contract (distribution.md), tell the relay owner`;
    } else if (status === 429) {
      const wait = retryAfterSeconds !== undefined ? `wait ${retryAfterSeconds} s and try again` : 'wait a little and try again';
      message = `the relay ${baseUrl} is rate limiting this request${detail}: ${wait}`;
    } else if (status === 401) {
      message = `the relay ${baseUrl} refused the stored token (invalid or revoked)${detail}: run \`machine join <code>\` again with a new code from the admin`;
    } else if (status === 403) {
      message =
        code === 'full_access_required' || code === 'scope_denied'
          ? `this call is for the admin of the machine network and the token used is a plain machine token (${code})${detail}: ${adminLoginFix()}`
          : `the relay ${baseUrl} refused this request (403)${detail}: the token may lack the "machine" scope, or the request was malformed; run \`machine join <code>\` again if the token was rotated`;
    } else if (status === 404) {
      message = `not found on the relay ${baseUrl}${detail}: it may have expired (a candidacy lives 15 minutes), or the id is wrong`;
    } else if (c.candidacyPost && status === 409 && code === 'candidacy_uuid_changed') {
      message = `the relay ${baseUrl} refused the candidacy (candidacy_uuid_changed)${detail}: this identity key already has a candidacy with another uuid (the uuid of an identity key never changes). That entry must expire (15 minutes) or an admin must reject it (\`machine admin approve <id> --reject\`); run \`machine join --resume\` after it is gone`;
    } else if (status === 409) {
      message =`conflict on the relay ${baseUrl}${detail}: ${code === 'identity_key_in_use' ? 'another token already holds a pending candidacy for this identity key; wait for it to expire (15 minutes) or have the admin reject it' : 'the entry is no longer pending'}`;
    } else if (status === 412) {
      message = `the record changed on the relay${detail}: read it again (current etag ${currentEtag ?? 'unknown'}) and retry`;
    } else if (status === 503 || status >= 500) {
      message = `the relay ${baseUrl} failed (${status})${detail}: try again in a moment, and tell the relay owner if it persists`;
    } else {
      message = `the relay ${baseUrl} refused the request (${status})${detail}: check the request and the relay version`;
    }
    return new RelayError({
      status,
      ...(code !== undefined ? { code } : {}),
      ...(humanText !== undefined ? { humanText } : {}),
      message,
      ...(retryAfterSeconds !== undefined ? { retryAfterSeconds } : {}),
      ...(currentEtag !== undefined ? { currentEtag } : {}),
    });
  }

  const malformed = (what: string, field?: string) => new RelayError({ status: 0, message: `the relay ${baseUrl} sent an unexpected answer to ${what}${field !== undefined ? ` (${field})` : ''}: it may be an incompatible version, tell the relay owner` });
  // The relay dates a candidacy with ISO 8601 strings (found against the real relay); the rest of this program counts epoch seconds.
  const presenceInSeconds = (entry: Record<string, unknown>, what: string): Record<string, unknown> => ({ ...entry, lastSeen: entry.lastSeen === null || entry.lastSeen === undefined ? null : epochSecondsOf(entry.lastSeen, what, 'lastSeen') });
  const epochSecondsOf = (value: unknown, what: string, field: string): number => {
    const ms = typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(value) ? Date.parse(value) : Number.NaN;
    if (!Number.isFinite(ms)) throw malformed(what, `${field} is not an ISO 8601 date`);
    return Math.floor(ms / 1000);
  };

  return {
    baseUrl,

    async claimPairing(code, access = 'machine') {
      const r = (await call({ method: 'POST', path: '/api/pairings/claim', body: { code }, pairing: true, ...(access === 'admin' ? { forAdmin: true } : {}) })) as NonNullable<Awaited<ReturnType<typeof call>>>;
      const { token: claimed, label, scopes } = r.body;
      if (typeof claimed !== 'string' || claimed.length === 0) throw malformed('the pairing claim');
      if (access === 'admin') {
        // The preferred token is limited to ["machine-admin"]; a full-access one (null) still works, the caller warns that it can manage tokens.
        const adminScoped = Array.isArray(scopes) && scopes.length === 1 && scopes[0] === 'machine-admin';
        if (scopes !== null && !adminScoped) {
          throw new RelayError({
            status: r.status,
            message: `the pairing code gives a token whose scopes are ${Array.isArray(scopes) ? JSON.stringify(scopes) : 'unknown'}: it could not list or decide candidacies (it needs exactly ["machine-admin"], or full access), and the token was NOT saved. This code is now used up: open a new pairing limited to the machine-admin scope: ${adminLoginFix()}`,
          });
        }
        return { token: claimed, label: typeof label === 'string' ? label : '', scopes: adminScoped ? ['machine-admin'] : null };
      }
      if (!Array.isArray(scopes) || !scopes.includes('machine') || scopes.includes('machine-admin')) {
        throw new RelayError({
          status: r.status,
          message: `the pairing code gives ${scopes === null ? 'a full-access token' : (Array.isArray(scopes) && scopes.includes('machine-admin')) ? 'a machine-admin token' : 'a token without the "machine" scope'}: a machine must never store it, and the token was NOT saved. Ask the admin to open the pairing with "Limited to scopes", machine, and note that the code is now used up`,
        });
      }
      return { token: claimed, label: typeof label === 'string' ? label : '', scopes: scopes.filter((s): s is string => typeof s === 'string') };
    },

    async deviceLoginStart(label, access = 'machine') {
      let r;
      try {
        // A machine login sends the label only: it is the request every relay understands.
        r = (await call({ method: 'POST', path: '/api/device-login/start', body: access === 'machine' ? { label } : { label, access }, publicRoute: true })) as NonNullable<Awaited<ReturnType<typeof call>>>;
      } catch (e) {
        if (access !== 'machine' && e instanceof RelayError && e.status === 400 && e.code === 'invalid_body') {
          const text = e.humanText ? `: ${e.humanText}` : '';
          throw new AccessLoginUnsupportedError({
            status: 400,
            code: 'invalid_body',
            access,
            ...(e.humanText !== undefined ? { humanText: e.humanText } : {}),
            message:
              access === 'machine-admin'
                ? `the relay ${baseUrl} predates the \`machine-admin\` scope (${MACHINE_ADMIN_RELAY_COMMIT}): it refused access "machine-admin" with 400 invalid_body${text}. Nothing was stored and no full-access token was requested (nothing falls back to full access by itself). Tell the relay owner to update and redeploy it`
                : `the relay ${baseUrl} does not support the full-access login yet (it refused the "access" field with 400 invalid_body${text}): it is an older version, tell the relay owner to update it. Meanwhile use a pairing code: ${fullPairingFix()}`,
          });
        }
        if (e instanceof RelayError && (e.status === 404 || e.status === 405)) {
          throw new RelayError({ status: e.status, message: `the relay ${baseUrl} does not offer device login (it may not be updated yet): ask the admin for a pairing code (relay console: Tokens, Add token, "Limited to scopes", machine) and run \`machine join <code>\`` });
        }
        throw e;
      }
      const { deviceCode, userCode, expiresIn, pollIntervalSeconds, verificationUrl } = r.body;
      if (typeof deviceCode !== 'string' || deviceCode.length === 0 || typeof userCode !== 'string' || userCode.length === 0) throw malformed('the device login start');
      if (typeof expiresIn !== 'number' || !(expiresIn > 0) || typeof pollIntervalSeconds !== 'number' || !(pollIntervalSeconds > 0) || typeof verificationUrl !== 'string') throw malformed('the device login start');
      const said = r.body.access;
      if (access !== 'machine' && said !== access) {
        const started = said === undefined || said === 'machine' ? 'a MACHINE login' : `a login with access ${JSON.stringify(said)}`;
        const answered = said === undefined ? 'without saying which access' : `with access ${JSON.stringify(said)}`;
        throw new AccessLoginUnsupportedError({
          status: r.status,
          access,
          pendingRequest: true,
          message:
            access === 'machine-admin'
              ? `the relay ${baseUrl} predates the \`machine-admin\` scope (${MACHINE_ADMIN_RELAY_COMMIT}): it answered ${answered} and started ${started} instead. Nothing was stored; deny the request "${label}" in the relay console (Tokens). Tell the relay owner to update and redeploy it`
              : `the relay ${baseUrl} does not support the full-access login yet: it answered ${answered} and started ${started} instead (it is an older version, tell the relay owner to update it). Nothing was stored; deny the request "${label}" in the relay console (Tokens). Meanwhile use a pairing code: ${fullPairingFix()}`,
        });
      }
      return { deviceCode, userCode, expiresIn, pollIntervalSeconds, verificationUrl, ...(said === 'machine' || said === 'machine-admin' || said === 'full' ? { access: said } : {}) };
    },

    async deviceLoginPoll(deviceCode, access = 'machine') {
      let r;
      try {
        r = (await call({ method: 'POST', path: '/api/device-login/poll', body: { deviceCode }, publicRoute: true })) as NonNullable<Awaited<ReturnType<typeof call>>>;
      } catch (e) {
        // `slow_down` is an answer to obey, not a failure.
        // A decoy of the console's six codes was clicked: the relay denied the request (the poll says denied, or 409 request_denied).
        if (e instanceof RelayError && e.status === 409 && e.code === 'request_denied') return { status: 'denied' };
        if (e instanceof RelayError && e.status === 429 && e.code === 'slow_down') return { status: 'slow_down', ...(e.retryAfterSeconds !== undefined ? { retryAfterSeconds: e.retryAfterSeconds } : {}) };
        throw e;
      }
      const { status, token: delivered, label, scopes } = r.body;
      if (status === 'pending' || status === 'denied' || status === 'expired') return { status };
      if (status === 'slow_down') return { status, ...(typeof r.body.retryAfterSeconds === 'number' ? { retryAfterSeconds: r.body.retryAfterSeconds } : {}) };
      if (status === 'approved') {
        if (typeof delivered !== 'string' || delivered.length === 0 || typeof label !== 'string' || label.length === 0) throw malformed('the device login poll');
        const said = r.body.access;
        if (access !== 'machine') {
          // An admin login stores only what was asked for, and only when the relay says so: the access AND the scopes must be exactly those.
          const exact = said === access && (access === 'full' ? scopes === null : Array.isArray(scopes) && scopes.length === 1 && scopes[0] === 'machine-admin');
          if (!exact) {
            const got = `${said === undefined ? 'a token without saying its access' : `a token with access ${JSON.stringify(said)}`} and ${scopes === undefined ? 'no scopes field' : `scopes ${JSON.stringify(scopes)}`}`;
            const wanted = access === 'full' ? 'access "full" with scopes null' : 'access "machine-admin" with scopes ["machine-admin"]';
            throw new RelayError({
              status: r.status,
              message:
                access === 'machine-admin'
                  ? `the machine-admin login was approved but the relay ${baseUrl} delivered ${got} instead of ${wanted}: it is not the token that was asked for (an older relay cannot give this scope), tell the relay owner. The token was NOT saved: revoke "${printable(label)}" in the relay console (Tokens)`
                  : `the full-access login was approved but the relay ${baseUrl} delivered ${got} instead of ${wanted}: it is an older version that does not support the full-access login, tell the relay owner. The token was NOT saved: revoke "${printable(label)}" in the relay console (Tokens), then use a pairing code: ${fullPairingFix()}`,
            });
          }
          return { status, token: delivered, label, scopes: access === 'full' ? null : ['machine-admin'] };
        }
        // Same rule as the pairing claim: a machine never stores anything but a machine-scoped token. The token is dropped here.
        // A relay that predates the access field says nothing: only then may the access be absent.
        if (!Array.isArray(scopes) || scopes.length !== 1 || scopes[0] !== 'machine' || (said !== undefined && said !== 'machine')) {
          throw new RelayError({
            status: r.status,
            message: `the device login gave ${scopes === null ? 'a full-access token' : `a token ${said === undefined ? '' : `with access ${JSON.stringify(said)} and `}whose scopes are ${Array.isArray(scopes) ? JSON.stringify(scopes) : 'unknown'} instead of exactly ["machine"]`}: a machine must never store it, and the token was NOT saved. Revoke "${printable(label)}" in the relay console (Tokens), tell the relay owner, then run \`machine join\` again`,
          });
        }
        return { status, token: delivered, label, scopes: ['machine'] };
      }
      throw malformed('the device login poll');
    },

    async postCandidacy(candidacy) {
      const r = (await call({ method: 'POST', path: '/api/machines/candidacies', body: candidacy, candidacyPost: true })) as NonNullable<Awaited<ReturnType<typeof call>>>;
      const { id, createdAt, expiresAt } = r.body;
      if (typeof id !== 'string') throw malformed('the candidacy post', 'id');
      return { id, createdAt: epochSecondsOf(createdAt, 'the candidacy post', 'createdAt'), expiresAt: epochSecondsOf(expiresAt, 'the candidacy post', 'expiresAt') };
    },

    async getCandidacy(id) {
      const r = (await call({ method: 'GET', path: `/api/machines/candidacies/${idPath(id)}` })) as NonNullable<Awaited<ReturnType<typeof call>>>;
      const status = r.body.status;
      if (status === 'pending') return { status };
      if (status === 'rejected') return { status };
      if (status === 'approved') return { status, approval: r.body.approval };
      throw malformed('the candidacy read');
    },

    async putRecord(uuid, record, etag) {
      const r = (await call({ method: 'PUT', path: `/api/machines/${uuidPath(uuid)}`, body: record, record: { uuid: uuid.toLowerCase() }, ...(etag !== undefined ? { headers: { 'If-Match': etag } } : {}) })) as NonNullable<Awaited<ReturnType<typeof call>>>;
      const newEtag = typeof r.body.etag === 'string' ? r.body.etag : r.headers.get('etag');
      if (newEtag === null || newEtag === undefined) throw malformed('the record write');
      return { etag: newEtag };
    },

    async heartbeat(uuid) {
      const r = (await call({ method: 'POST', path: `/api/machines/${uuidPath(uuid)}/heartbeat` })) as NonNullable<Awaited<ReturnType<typeof call>>>;
      const count = asObject(r.body.inbox).count;
      return { inboxCount: typeof count === 'number' && Number.isSafeInteger(count) && count >= 0 ? count : undefined };
    },

    async putInboxDocument(uuid, document) {
      const id = (document as { body?: { id?: unknown } } | null)?.body?.id;
      if (typeof id !== 'string' || id.length === 0) throw new Error('the document has no body.id: build it with machine-core buildDocument');
      await call({ method: 'PUT', path: `/api/machines/${uuidPath(uuid)}/inbox/${idPath(id)}`, body: document, inbox: { uuid: uuid.toLowerCase(), id } });
    },

    async listInbox(uuid, max) {
      const entries: InboxEntry[] = [];
      const seen = new Set<string>();
      let after: string | undefined;
      // 256 documents per inbox, 32 per page: a relay that goes on much longer is not following the contract.
      for (let page = 0; page < 64; page++) {
        // The cursor parameter is named `after` here: the contract only says "next" (to confirm with the relay owner).
        const query = after === undefined ? '' : `?after=${encodeURIComponent(after)}`;
        const r = (await call({ method: 'GET', path: `/api/machines/${uuidPath(uuid)}/inbox${query}`, inbox: { uuid: uuid.toLowerCase() }, maxBytes: MAX_INBOX_PAGE_BYTES, what: 'one inbox page (32 documents of at most 16 KiB)' })) as NonNullable<Awaited<ReturnType<typeof call>>>;
        const documents = r.body.documents;
        if (!Array.isArray(documents)) throw malformed('the inbox list');
        for (const d of documents) {
          const entry = asObject(d);
          if (typeof entry.id !== 'string' || !('document' in entry)) throw malformed('the inbox list');
          entries.push({ id: entry.id, document: entry.document, storedAt: epochSecondsOf(entry.storedAt, 'the inbox list', 'storedAt') });
        }
        if (max !== undefined && entries.length >= max) return entries.slice(0, max);
        if (r.body.more !== true) return entries;
        const next = r.body.next;
        if (typeof next !== 'string' || next.length === 0 || seen.has(next)) throw malformed('the inbox list (it announces more documents without a new "next")');
        seen.add(next);
        after = next;
      }
      throw malformed('the inbox list (it never ends)');
    },

    async deleteInboxDocument(uuid, id) {
      await call({ method: 'DELETE', path: `/api/machines/${uuidPath(uuid)}/inbox/${idPath(id)}`, inbox: { uuid: uuid.toLowerCase(), id } });
    },

    async deleteMachine(uuid) {
      await call({ method: 'DELETE', path: `/api/machines/${uuidPath(uuid)}`, accept: [404], inbox: { uuid: uuid.toLowerCase() } });
    },

    async getMachines() {
      const r = (await call({ method: 'GET', path: '/api/machines', maxBytes: MAX_MACHINES_ANSWER_BYTES, what: 'the machine list (1000 records of 2 KiB at most)' })) as NonNullable<Awaited<ReturnType<typeof call>>>;
      if (!Array.isArray(r.body.machines)) throw malformed('the machine list');
      return (r.body.machines as Record<string, unknown>[]).map((m) => presenceInSeconds(m, 'the machine list') as unknown as MachineEntry);
    },

    async getMachine(uuid) {
      const r = await call({ method: 'GET', path: `/api/machines/${uuidPath(uuid)}`, accept: [404], maxBytes: MAX_MACHINE_ANSWER_BYTES, what: 'one machine record (2 KiB at most)' });
      if (r === undefined) return undefined;
      return presenceInSeconds(r.body, 'the machine record') as unknown as MachineEntry & { etag?: string };
    },

    async listCandidacies() {
      const r = (await call({ method: 'GET', path: '/api/machines/candidacies' })) as NonNullable<Awaited<ReturnType<typeof call>>>;
      if (!Array.isArray(r.body.candidacies)) throw malformed('the candidacy list');
      return (r.body.candidacies as Record<string, unknown>[]).map((c) => ({ ...c, createdAt: epochSecondsOf(c.createdAt, 'the candidacy list', 'createdAt'), expiresAt: epochSecondsOf(c.expiresAt, 'the candidacy list', 'expiresAt') })) as unknown as PendingCandidacy[];
    },

    async decideCandidacy(id, decision) {
      await call({ method: 'PUT', path: `/api/machines/candidacies/${idPath(id)}/decision`, body: decision, decision: true });
    },

    async getVersion() {
      const r = await call({ method: 'GET', path: '/api/version', publicRoute: true, accept: [404] });
      if (r === undefined) return undefined;
      if (typeof r.body.version !== 'string' || r.body.version.length === 0) throw malformed('the relay version');
      const uptime = r.body.uptimeSeconds;
      return { version: printable(r.body.version), ...(typeof uptime === 'number' && Number.isFinite(uptime) && uptime >= 0 ? { uptimeSeconds: uptime } : {}) };
    },

    async whoami() {
      const r = await call({ method: 'GET', path: '/api/whoami', accept: [404] });
      if (r === undefined) return undefined;
      const { scopes, label } = r.body;
      if (scopes !== null && !(Array.isArray(scopes) && scopes.every((s) => typeof s === 'string'))) throw malformed('whoami', 'scopes');
      return { scopes: scopes as string[] | null, ...(typeof label === 'string' ? { label: printable(label) } : {}) };
    },
  };
}
