// Client of the relay API (relay-api.md v0.2 + pairing claim). The relay is untrusted: this client only moves opaque
// documents. The token is held in a closure and is never part of an error message, a log line or a returned value.

export const DEFAULT_RELAY_URL = 'https://relay.example.test';
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

export interface RelayClientOptions {
  baseUrl: string;
  token?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

export interface ClaimAnswer {
  token: string;
  label: string;
  scopes: string[];
}

export interface CandidacyPost {
  name: string;
  hostname: string;
  identityPublicKey: string;
  random: string;
}

export interface CandidacyPosted {
  id: string;
  createdAt: number;
  expiresAt: number;
}

export type CandidacyStatus = { status: 'pending' } | { status: 'approved'; approval: unknown } | { status: 'rejected' };

export interface PendingCandidacy extends CandidacyPost {
  id: string;
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

export type CandidacyDecision = { decision: 'approve'; approval: unknown } | { decision: 'reject' };

/** The relay URL as the user typed it, validated: https, except plain http on loopback (tests, local relay). No trailing slash. */
export function normalizeRelayUrl(input: string): string {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new Error(`invalid relay URL "${input}": expected something like ${DEFAULT_RELAY_URL}`);
  }
  const loopback = url.hostname === '127.0.0.1' || url.hostname === 'localhost';
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new Error(`relay URL "${input}" must use https (plain http is only accepted for 127.0.0.1 and localhost): use an https URL such as ${DEFAULT_RELAY_URL}`);
  }
  if (url.username !== '' || url.password !== '') throw new Error('the relay URL must not contain credentials: the token is stored separately');
  if (url.search !== '' || url.hash !== '') throw new Error(`relay URL "${input}" must not contain a query or a fragment`);
  return `${url.origin}${url.pathname}`.replace(/\/+$/, '');
}

export interface RelayClient {
  readonly baseUrl: string;
  claimPairing(code: string): Promise<ClaimAnswer>;
  postCandidacy(candidacy: CandidacyPost): Promise<CandidacyPosted>;
  getCandidacy(id: string): Promise<CandidacyStatus>;
  putRecord(uuid: string, record: SignedAddressRecord, etag?: string): Promise<{ etag: string }>;
  heartbeat(uuid: string): Promise<void>;
  getMachines(): Promise<MachineEntry[]>;
  getMachine(uuid: string): Promise<(MachineEntry & { etag?: string }) | undefined>;
  listCandidacies(): Promise<PendingCandidacy[]>;
  decideCandidacy(id: string, decision: CandidacyDecision): Promise<void>;
}

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
    /** Statuses returned as `undefined` instead of an error. */
    accept?: number[];
  }

  async function call(c: Call): Promise<{ status: number; body: Record<string, unknown>; headers: Headers } | undefined> {
    const url = `${baseUrl}${c.path}`;
    const headers: Record<string, string> = { Accept: 'application/json', ...(c.headers ?? {}) };
    if (token !== undefined && !c.pairing) headers.Authorization = `Bearer ${token}`;
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
    const text = await res.text().catch(() => '');
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
      message = `the pairing code was refused${detail}: ask the admin for a new code (Tokens, Add token, "Limited to scopes", machine) and run \`machine join <code>\` again`;
    } else if (c.pairing && status === 409) {
      message = `the pairing code was valid but is now used up${detail}: ask the admin for a new code and run \`machine join <code>\` again`;
    } else if (status === 429) {
      const wait = retryAfterSeconds !== undefined ? `wait ${retryAfterSeconds} s and try again` : 'wait a little and try again';
      message = `the relay ${baseUrl} is rate limiting this request${detail}: ${wait}`;
    } else if (status === 401) {
      message = `the relay ${baseUrl} refused the stored token (invalid or revoked)${detail}: run \`machine join <code>\` again with a new code from the admin`;
    } else if (status === 403) {
      message =
        code === 'full_access_required'
          ? `this call needs a full-access token, a machine token is not enough${detail}`
          : `the relay ${baseUrl} refused this request (403)${detail}: the token may lack the "machine" scope, or the request was malformed; run \`machine join <code>\` again if the token was rotated`;
    } else if (status === 404) {
      message = `not found on the relay ${baseUrl}${detail}: it may have expired (a candidacy lives 15 minutes), or the id is wrong`;
    } else if (status === 409) {
      message = `conflict on the relay ${baseUrl}${detail}: ${code === 'identity_key_in_use' ? 'another token already holds a pending candidacy for this identity key; wait for it to expire (15 minutes) or have the admin reject it' : 'the entry is no longer pending'}`;
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

  const malformed = (what: string) => new RelayError({ status: 0, message: `the relay ${baseUrl} sent an unexpected answer to ${what}: it may be an incompatible version, tell the relay owner` });

  return {
    baseUrl,

    async claimPairing(code) {
      const r = (await call({ method: 'POST', path: '/api/pairings/claim', body: { code }, pairing: true })) as NonNullable<Awaited<ReturnType<typeof call>>>;
      const { token: claimed, label, scopes } = r.body;
      if (typeof claimed !== 'string' || claimed.length === 0) throw malformed('the pairing claim');
      if (!Array.isArray(scopes) || !scopes.includes('machine')) {
        throw new RelayError({
          status: r.status,
          message: `the pairing code gives ${scopes === null ? 'a full-access token' : 'a token without the "machine" scope'}: a machine must never store it, and the token was NOT saved. Ask the admin to open the pairing with "Limited to scopes", machine, and note that the code is now used up`,
        });
      }
      return { token: claimed, label: typeof label === 'string' ? label : '', scopes: scopes.filter((s): s is string => typeof s === 'string') };
    },

    async postCandidacy(candidacy) {
      const r = (await call({ method: 'POST', path: '/api/machines/candidacies', body: candidacy })) as NonNullable<Awaited<ReturnType<typeof call>>>;
      const { id, createdAt, expiresAt } = r.body;
      if (typeof id !== 'string' || typeof createdAt !== 'number' || typeof expiresAt !== 'number') throw malformed('the candidacy post');
      return { id, createdAt, expiresAt };
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
      const r = (await call({ method: 'PUT', path: `/api/machines/${uuidPath(uuid)}`, body: record, ...(etag !== undefined ? { headers: { 'If-Match': etag } } : {}) })) as NonNullable<Awaited<ReturnType<typeof call>>>;
      const newEtag = typeof r.body.etag === 'string' ? r.body.etag : r.headers.get('etag');
      if (newEtag === null || newEtag === undefined) throw malformed('the record write');
      return { etag: newEtag };
    },

    async heartbeat(uuid) {
      await call({ method: 'POST', path: `/api/machines/${uuidPath(uuid)}/heartbeat` });
    },

    async getMachines() {
      const r = (await call({ method: 'GET', path: '/api/machines' })) as NonNullable<Awaited<ReturnType<typeof call>>>;
      if (!Array.isArray(r.body.machines)) throw malformed('the machine list');
      return r.body.machines as MachineEntry[];
    },

    async getMachine(uuid) {
      const r = await call({ method: 'GET', path: `/api/machines/${uuidPath(uuid)}`, accept: [404] });
      if (r === undefined) return undefined;
      return r.body as unknown as MachineEntry & { etag?: string };
    },

    async listCandidacies() {
      const r = (await call({ method: 'GET', path: '/api/machines/candidacies' })) as NonNullable<Awaited<ReturnType<typeof call>>>;
      if (!Array.isArray(r.body.candidacies)) throw malformed('the candidacy list');
      return r.body.candidacies as PendingCandidacy[];
    },

    async decideCandidacy(id, decision) {
      await call({ method: 'PUT', path: `/api/machines/candidacies/${idPath(id)}/decision`, body: decision });
    },
  };
}
