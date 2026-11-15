import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomBytes } from 'node:crypto';
import { completeDraft } from './approvalDraft.js';

// Test helper (not shipped logic): a fake relay implementing the routes of relay-api.md v0.2 that the client uses,
// on a real local HTTP server. It enforces what the real one does that matters to the client: scopes, canonical
// lower-case uuids (403 otherwise), compare-and-set on records.

export interface FakeRelayOptions {
  /** Pairing code accepted once. */
  code?: string;
  /** Scopes of the claimed token: `null` means full access. */
  scopes?: string[] | null;
  /** Second pairing code, claimed by `admin login`: its token has scopes `adminScopes` (default null = full access). */
  adminCode?: string;
  adminScopes?: string[] | null;
  token?: string;
  label?: string;
  /** User code returned by the device login start (default BCDF-GH23). */
  deviceUserCode?: string;
  /** expiresIn announced by the device login start (default 300; tests set a huge value to check the client cap). */
  deviceExpiresIn?: number;
  /** Scopes of the token delivered by an approved device login (default ["machine"]). */
  deviceScopes?: string[] | null;
  /** User code of a FULL-ACCESS device login (access "full"; default KLMN-PQ23: it differs from `deviceUserCode`, both may be pending together). */
  deviceFullUserCode?: string;
  /**
   * How the relay treats `access: "full"` on the device login start. "supported" (default): poc-node 754a4c5 (the answer carries access, the poll
   * delivers the full-access token with scopes null). "rejects": an OLDER relay, the unknown field is `400 invalid_body`. "ignores": a relay that drops
   * the field and starts a machine login (the answer has no access). "delivers-machine": the start says full, the poll delivers a machine token.
   */
  fullLogin?: 'supported' | 'rejects' | 'ignores' | 'delivers-machine';
  /**
   * How the relay treats `access: "machine-admin"` on the device login start. "supported" (default): poc-node 78fe5b2 (the poll delivers a distinct
   * token per login with scopes ["machine-admin"]). "rejects": an OLDER relay, the value is `400 invalid_body`. "ignores": a relay that drops the
   * field and starts a machine login. "delivers-machine" / "delivers-full": the start says machine-admin, the poll delivers another kind of token.
   */
  machineAdminLogin?: 'supported' | 'rejects' | 'ignores' | 'delivers-machine' | 'delivers-full';
  /**
   * What the poll of a DENIED request answers: "status" (default, the relay's own code: `{ status: "denied" }`) or "conflict" (`409 request_denied`, as
   * the coordinator reported for poc-node 7e0b586). The client must treat both the same.
   */
  deniedPoll?: 'status' | 'conflict';
  /** User code of a MACHINE-ADMIN device login (default ADMN-7K42). */
  machineAdminUserCode?: string;
  /** Inbox limits of distribution.md (defaults: 256 documents per inbox, 64 MiB for all inboxes). */
  inboxLimits?: { perInbox?: number; globalBytes?: number };
  /** Documents per page of the inbox listing (default 32, as the contract says). */
  inboxPageSize?: number;
  /** More pairing codes, each claimed once and giving its OWN machine token, labelled "<label>-2", "<label>-3", ... (two machines on one relay). */
  moreCodes?: string[];
  /**
   * Machines one token may hold (approved uuids bound to it); a NEW binding past it is `429 too_many_machines` with `limit`. Default 10, the default of
   * the relay without `machines-config.json` (1..1000 there). Only new bindings are counted: a token above the limit keeps its machines.
   */
  maxMachinesPerToken?: number;
  /** Machines the whole relay may hold (default 1000): the same code, `limit` 1000 and a message starting with "The relay holds". */
  maxMachinesOnRelay?: number;
}

// Models the DEPLOYED relay (relay-api.md, "Ownership bound at approval", poc-owner 719f36f): a machine token can write records, heartbeat and
// read its inbox only for a uuid bound at approval to the token that posted the candidacy. The uuid is required in a candidacy; an unbound uuid
// is 403 not_registered; the admin list carries `uuidBound`, `boundTokenLabel` and `boundToCandidateToken`; the first writer binds nothing.

export interface FakeInboxDocument {
  id: string;
  document: unknown;
  storedAt: number;
}

export interface FakeDeviceLogin {
  userCode: string;
  label: string;
  status: 'pending' | 'approved' | 'denied' | 'expired';
  /** Kind of token asked at the start (what the relay recorded). */
  access: 'machine' | 'machine-admin' | 'full';
  /** What the console offers: the real code among five decoys, shuffled (empty for a full-access request: its approver types the code). */
  choices: string[];
  /** Label delivered on approval (the relay may add a suffix). */
  deliveredLabel?: string;
}

export interface FakeRelay {
  url: string;
  token: string;
  /** Token given by the second pairing code (full access unless `adminScopes` says otherwise). */
  adminToken: string;
  /** Tokens delivered by machine-admin device logins, in order (each login gets its own). */
  machineAdminTokens: string[];
  /** The first token delivered by a machine-admin device login (throws when none was delivered). */
  readonly machineAdminToken: string;
  /** Every request received: method, path and the Authorization header. */
  requests: { method: string; path: string; authorization: string | undefined; body: unknown }[];
  candidacies: Map<string, Record<string, unknown> & { status: string }>;
  /** Device logins by deviceCode (a secret in real life: tests read it here to check that it is never printed). */
  deviceLogins: Map<string, FakeDeviceLogin>;
  /**
   * The console approves the oldest pending device login (the one whose request label is `request`, when given); `label` is what the relay
   * delivers (it may carry a "-2" suffix).
   */
  deviceApprove: (options?: { label?: string; request?: string }) => void;
  deviceDeny: () => void;
  /** The six codes the console offers for the pending request showing `userCode` (absent: the first pending one with choices). */
  deviceChoices: (userCode?: string) => string[];
  /** The person clicks a code in the console: the right one approves, a decoy denies the request at once (409 request_denied), as poc-node 7e0b586. */
  deviceClick: (code: string) => { status: number; error?: string };
  deviceExpire: () => void;
  /** Next answer forced on a path prefix (one shot), optionally only for one HTTP method. */
  force: (pathPrefix: string, status: number, body: unknown, headers?: Record<string, string>, method?: string) => void;
  /**
   * Admin side, tests only: the decision the admin console would send with a full-access token. Like the real admin, it
   * adds the `random` of the candidacy to the approval unless the approval already has one or `bind: false` is given.
   */
  approve: (id: string, approval: unknown, options?: { bind?: boolean }) => void;
  reject: (id: string) => void;
  /** The relay forgot the candidacy (15 minutes passed, or a restart): the candidate gets a 404. */
  expire: (id: string) => void;
  /** Plant a pending candidacy as the relay would list it (tests of the admin side). */
  addCandidacy: (id: string, fields: Record<string, unknown>) => void;
  /** The token `uuid` is bound to (undefined: unbound). Tests only: the real relay binds at approval, which `approve` also does. */
  setOwner: (uuid: string, token: string | undefined) => void;
  /** The console revokes a machine token: it answers 401 from now on, and the admin list names it "(revoked token)". */
  revokeMachineToken: (token: string) => void;
  /** Another machine token (scope machine): tests with two machines on one relay. Returns it. */
  addMachineToken: (label?: string) => string;
  /** The clock of the relay in epoch seconds (presence: lastSeen and online). Default: the real clock. */
  setClock: (now: () => number) => void;
  /** The documents waiting for `uuid`, oldest first. */
  inbox: (uuid: string) => FakeInboxDocument[];
  /** Ids of the candidacies still pending, oldest first. */
  pendingIds: () => string[];
  close: () => Promise<void>;
}

/** The relay's refusal of an admin call by a machine token (poc-node routes.js `requireAdmin`: always `full_access_required`). */
const ADMIN_ONLY = 'This call is for the admin of the machine network: a full-access token or a token with the machine-admin scope. A machine token cannot list candidacies, decide on them, write an inbox document or delete a machine.';

const CODE_ALPHABET = 'BCDFGHJKLMNPQRSTVWXZ23456789';
/** A code that looks like a user code and is not `not`. */
function decoyCode(not: string): string {
  for (;;) {
    const raw = Array.from(randomBytes(8), (b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('');
    const code = `${raw.slice(0, 4)}-${raw.slice(4)}`;
    if (code !== not) return code;
  }
}
function shuffle<T>(items: T[]): T[] {
  return items.map((item) => ({ item, key: randomBytes(2).readUInt16BE() })).sort((a, b) => a.key - b.key).map((x) => x.item);
}

/** ISO 8601 of an epoch in seconds: how the real relay dates a candidacy. */
const iso = (epochSeconds: number): string => new Date(epochSeconds * 1000).toISOString();

export async function startFakeRelay(options: FakeRelayOptions = {}): Promise<FakeRelay> {
  const code = options.code ?? '12345678';
  const token = options.token ?? `tok_${randomBytes(12).toString('hex')}`;
  const scopes = options.scopes === undefined ? ['machine'] : options.scopes;
  let codeUsed = false;
  let adminCodeUsed = false;
  const adminCode = options.adminCode ?? '87654321';
  const adminScopes = options.adminScopes === undefined ? null : options.adminScopes;
  const adminToken = `adm_${randomBytes(12).toString('hex')}`;
  const forced: { prefix: string; status: number; body: unknown; headers: Record<string, string>; method: string | undefined }[] = [];
  const records = new Map<string, { record: unknown; etag: number; text: string }>();
  // Presence is in memory only (relay-api.md): the time of the last PUT or heartbeat of the owner.
  const lastSeen = new Map<string, number>();
  const baseLabel = options.label ?? 'machine-pairing';
  // Token -> label, for every machine token of this relay.
  const machineTokens = new Map<string, string>([[token, baseLabel]]);
  const maxMachinesPerToken = options.maxMachinesPerToken ?? 10;
  const maxMachinesOnRelay = options.maxMachinesOnRelay ?? 1000;
  const extraCodes = (options.moreCodes ?? []).map((c, i) => ({ code: c, used: false, token: `tok_${randomBytes(12).toString('hex')}`, label: `${baseLabel}-${i + 2}` }));
  // The token that posted each candidacy: what an approval binds the uuid to (never served).
  const postedBy = new Map<string, string>();
  let clock: () => number = () => Math.floor(Date.now() / 1000);
  const ONLINE_SECONDS = 120;
  const MAX_RECORD_BYTES = 2048;
  const candidacies: FakeRelay['candidacies'] = new Map();
  const requests: FakeRelay['requests'] = [];
  const deviceLogins: FakeRelay['deviceLogins'] = new Map();
  const owners = new Map<string, string>();
  const inboxes = new Map<string, Map<string, FakeInboxDocument & { text: string }>>();
  const perInbox = options.inboxLimits?.perInbox ?? 256;
  const globalBytes = options.inboxLimits?.globalBytes ?? 64 * 1024 * 1024;
  const pageSize = options.inboxPageSize ?? 32;
  const inboxBytes = () => [...inboxes.values()].reduce((sum, box) => sum + [...box.values()].reduce((s, d) => s + d.text.length, 0), 0);
  const ID_PATTERN = /^[A-Za-z0-9_-]{22}$/;
  const deviceScopes = options.deviceScopes === undefined ? ['machine'] : options.deviceScopes;
  const fullLogin = options.fullLogin ?? 'supported';
  const machineAdminLogin = options.machineAdminLogin ?? 'supported';
  const machineAdminTokens: string[] = [];
  const pendingDevice = (request?: string): FakeDeviceLogin => {
    const entry = [...deviceLogins.values()].find((d) => d.status === 'pending' && (request === undefined || d.label === request));
    if (!entry) throw new Error(`fake relay: no pending device login${request !== undefined ? ` with the label "${request}"` : ''}`);
    return entry;
  };

  // The limit applies at approval: a token already holding the maximum of OTHER uuids cannot get one more (the candidacy stays pending).
  // Only a NEW binding is checked (the real relay, poc-node 6edc6f7): re-approving a uuid the token already owns always works, and a token
  // above the limit keeps every machine. Returns the refusal (body of the 429), or undefined.
  const overLimit = (id: string): { limit: number; message: string } | undefined => {
    const entry = candidacies.get(id);
    const poster = postedBy.get(id);
    if (entry === undefined || typeof entry.uuid !== 'string' || poster === undefined) return undefined;
    if (owners.get(entry.uuid) === poster) return undefined;
    if (owners.size >= maxMachinesOnRelay) {
      return { limit: maxMachinesOnRelay, message: `The relay holds ${maxMachinesOnRelay} machines already: no new machine can be approved until some are removed (DELETE /api/machines/<uuid>) or the operator raises the limit.` };
    }
    if ([...owners.values()].filter((owner) => owner === poster).length >= maxMachinesPerToken) {
      return { limit: maxMachinesPerToken, message: `This token already owns the maximum number of machines (${maxMachinesPerToken}), possibly machines that are gone. Free places with DELETE /api/machines/<uuid>, then approve again.` };
    }
    return undefined;
  };
  // The approval binds the uuid of the candidacy to the token that posted it, replacing any earlier binding.
  const bindAtApproval = (id: string) => {
    const entry = candidacies.get(id);
    const poster = postedBy.get(id);
    if (entry !== undefined && typeof entry.uuid === 'string' && poster !== undefined) owners.set(entry.uuid, poster);
  };
  const presence = (uuid: string) => {
    const seen = lastSeen.get(uuid);
    // ISO 8601 like the real relay (null before any write).
    return { lastSeen: seen === undefined ? null : iso(seen), online: seen !== undefined && clock() - seen < ONLINE_SECONDS };
  };
  const send = (res: ServerResponse, status: number, body?: unknown, headers: Record<string, string> = {}) => {
    res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
    res.end(body === undefined ? undefined : JSON.stringify(body));
  };
  const err = (res: ServerResponse, status: number, error: string, message: string, extra: object = {}) => send(res, status, { success: false, error, message, serverTime: 1, ...extra });

  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const raw = Buffer.concat(chunks).toString('utf8');
    const body = raw.length > 0 ? (JSON.parse(raw) as Record<string, unknown>) : undefined;
    const path = (req.url ?? '').split('?')[0] as string;
    const method = req.method ?? 'GET';
    const authorization = req.headers.authorization;
    requests.push({ method, path, authorization, body });

    const forcedAt = forced.findIndex((f) => path.startsWith(f.prefix) && (f.method === undefined || f.method === method));
    if (forcedAt !== -1) {
      const [f] = forced.splice(forcedAt, 1) as [(typeof forced)[number]];
      return send(res, f.status, f.body, f.headers);
    }

    if (method === 'POST' && path === '/api/pairings/claim') {
      const given = String((body as { code?: unknown } | undefined)?.code ?? '').replace(/[\s-]/g, '');
      if (given === adminCode && !adminCodeUsed) {
        adminCodeUsed = true;
        return send(res, 200, { success: true, serverTime: 1, token: adminToken, label: 'admin-pairing', scopes: adminScopes });
      }
      const extra = extraCodes.find((c) => c.code === given && !c.used);
      if (extra !== undefined) {
        extra.used = true;
        machineTokens.set(extra.token, extra.label);
        return send(res, 200, { success: true, serverTime: 1, token: extra.token, label: extra.label, scopes });
      }
      if (codeUsed || given !== code) return send(res, 401, { success: false, error: 'Invalid or expired code.', serverTime: 1 });
      codeUsed = true;
      return send(res, 200, { success: true, serverTime: 1, token, label: options.label ?? 'machine-pairing', scopes });
    }

    // Device login: public routes, the Authorization header is ignored.
    if (method === 'POST' && path === '/api/device-login/start') {
      const label = (body as { label?: unknown } | undefined)?.label;
      const asked = (body as { access?: unknown } | undefined)?.access;
      // The real relay accepts `label` and `access` ("machine", "machine-admin" or "full") only; an older one knows `label` only.
      if (Object.keys(body ?? {}).some((k) => k !== 'label' && !(k === 'access' && fullLogin !== 'rejects'))) return err(res, 400, 'invalid_body', 'unexpected field');
      if (asked !== undefined && asked !== 'machine' && asked !== 'full' && asked !== 'machine-admin') return err(res, 400, 'invalid_body', 'access must be "machine" (default), "machine-admin" or "full"');
      // A relay older than the machine-admin scope knows "machine" and "full" only.
      if (asked === 'machine-admin' && machineAdminLogin === 'rejects') return err(res, 400, 'invalid_body', 'access must be "machine" (default) or "full"');
      if (typeof label !== 'string' || !/^[A-Za-z0-9 _.-]{1,64}$/.test(label)) return err(res, 400, 'invalid_body', 'label: 1-64 characters, letters, digits, space, _ . -');
      const deviceCode = randomBytes(32).toString('base64url');
      // "ignores": the field is dropped, a machine login starts and the answer carries no access.
      const dropped = (asked === 'full' && fullLogin === 'ignores') || (asked === 'machine-admin' && machineAdminLogin === 'ignores');
      const access: FakeDeviceLogin['access'] = dropped || asked === undefined ? 'machine' : asked;
      const userCode = access === 'full' ? (options.deviceFullUserCode ?? 'KLMN-PQ23') : access === 'machine-admin' ? (options.machineAdminUserCode ?? 'ADMN-7K42') : (options.deviceUserCode ?? 'BCDF-GH23');
      const decoys = access === 'full' ? [] : Array.from({ length: 5 }, () => decoyCode(userCode));
      deviceLogins.set(deviceCode, { userCode, label, status: 'pending', access, choices: access === 'full' ? [] : shuffle([userCode, ...decoys]) });
      const answered = asked === undefined || dropped ? {} : { access };
      return send(res, 201, { success: true, serverTime: 1, ...answered, deviceCode, userCode, expiresIn: options.deviceExpiresIn ?? 300, pollIntervalSeconds: 3, verificationUrl: `https://relay.example/device?code=${userCode}` });
    }
    // The console list (full-access token only): the choices of every pending request.
    if (method === 'GET' && path === '/api/device-login') {
      const bearerToken = (authorization ?? '').replace(/^Bearer /, '');
      if (bearerToken !== adminToken && !machineTokens.has(bearerToken)) return err(res, 401, 'unauthorized', 'invalid token');
      if (bearerToken !== adminToken || adminScopes !== null) return err(res, 403, 'full_access_required', 'Listing login requests is for full-access tokens (the console).');
      return send(res, 200, { success: true, requests: [...deviceLogins.values()].filter((d) => d.status === 'pending').map((d) => ({ label: d.label, access: d.access, choices: d.choices })) });
    }
    if (method === 'POST' && path === '/api/device-login/poll') {
      const entry = deviceLogins.get(String((body as { deviceCode?: unknown } | undefined)?.deviceCode ?? ''));
      // Unknown, spent or expired: the same answer.
      if (!entry || entry.status === 'expired') return send(res, 200, { success: true, serverTime: 1, status: 'expired' });
      if (entry.status === 'denied' && options.deniedPoll === 'conflict') return err(res, 409, 'request_denied', 'The request was denied: a code the machine does not show was picked, or it was denied in the console.');
      if (entry.status === 'pending' || entry.status === 'denied') return send(res, 200, { success: true, serverTime: 1, status: entry.status });
      // Approved: delivered once, the next poll says expired.
      entry.status = 'expired';
      const delivered = entry.deliveredLabel ?? entry.label;
      if (entry.access === 'full' && fullLogin !== 'delivers-machine') return send(res, 200, { success: true, serverTime: 1, status: 'approved', token: adminToken, label: delivered, access: 'full', scopes: null });
      if (entry.access === 'machine-admin' && machineAdminLogin === 'delivers-full') return send(res, 200, { success: true, serverTime: 1, status: 'approved', token: adminToken, label: delivered, access: 'full', scopes: null });
      if (entry.access === 'machine-admin' && machineAdminLogin !== 'delivers-machine') {
        // One token per login, with the scope machine-admin only: it works as a machine token AND for the admin calls.
        const issued = `madm_${randomBytes(12).toString('hex')}`;
        machineAdminTokens.push(issued);
        machineTokens.set(issued, delivered);
        return send(res, 200, { success: true, serverTime: 1, status: 'approved', token: issued, label: delivered, access: 'machine-admin', scopes: ['machine-admin'] });
      }
      return send(res, 200, { success: true, serverTime: 1, status: 'approved', token, label: delivered, access: 'machine', scopes: deviceScopes });
    }

    const isAdminToken = authorization === `Bearer ${adminToken}`;
    const presented = (authorization ?? '').replace(/^Bearer /, '');
    if (path.startsWith('/api/machines') || path === '/api/tokens' || path === '/api/whoami') {
      if (!machineTokens.has(presented) && !isAdminToken) return err(res, 401, 'unauthorized', 'invalid token');
    }
    // What the token may do: full (scopes null: everything), machine-admin (the machine calls plus the admin calls of the machine network, nothing on
    // tokens, and never another machine's record or heartbeat) or machine.
    const scopesOf: string[] | null = isAdminToken ? adminScopes : machineAdminTokens.includes(presented) ? ['machine-admin'] : presented === token ? scopes : ['machine'];
    const kind = scopesOf === null ? 'full' : scopesOf.includes('machine-admin') ? 'machine-admin' : 'machine';
    // The admin calls (list and decide candidacies, write an inbox document, delete a machine, read any inbox): full access or machine-admin.
    const admin = kind !== 'machine';
    const fullAdmin = kind === 'full';
    if (path === '/api/whoami' && method === 'GET') return send(res, 200, { success: true, scopes: scopesOf });
    if (path === '/api/tokens') {
      if (!fullAdmin) return err(res, 403, 'full_access_required', 'Token management is for full-access tokens: a machine or machine-admin token cannot list, create or revoke tokens.');
      return send(res, 200, { success: true, tokens: [] });
    }
    if (!path.startsWith('/api/machines')) return err(res, 404, 'not_found', 'no such route');
    // A uuid that was never bound by an approval: a machine token cannot use it at all (`privileged`: the token that may skip the binding).
    const notRegistered = (uuid: string, privileged: boolean = admin): boolean => {
      if (privileged || owners.get(uuid) !== undefined) return false;
      // The relay's own text (relay-api.md, deployed details).
      err(res, 403, 'not_registered', 'This machine is not registered on the relay: approve this machine first (the admin approves its candidacy, `machine admin approve`), then retry.');
      return true;
    };

    if (method === 'POST' && path === '/api/machines/candidacies') {
      const given = (body as { uuid?: unknown } | undefined)?.uuid;
      if (typeof given !== 'string' || given !== given.toLowerCase() || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(given)) {
        return err(res, 400, 'invalid_body', 'uuid is required: a lower-case canonical v4 UUID');
      }
      // The uuid of an identity key never changes: while a candidacy of this key is pending, another uuid is refused.
      const sameKey = [...candidacies.values()].find((c) => c.status === 'pending' && c.identityPublicKey === (body as { identityPublicKey?: unknown }).identityPublicKey && c.uuid !== given);
      if (sameKey !== undefined) return err(res, 409, 'candidacy_uuid_changed', 'this identity key already has a candidacy with another uuid: it must expire or be rejected first');
      const id = randomBytes(16).toString('base64url');
      const createdAt = Math.floor(Date.now() / 1000);
      postedBy.set(id, presented);
      candidacies.set(id, { status: 'pending', ...(body as object), createdAt, expiresAt: createdAt + 900 });
      return send(res, 201, { success: true, id, createdAt: iso(createdAt), expiresAt: iso(createdAt + 900) });
    }
    if (method === 'GET' && path === '/api/machines/candidacies') {
      if (!admin) return err(res, 403, 'full_access_required', ADMIN_ONLY);
      return send(res, 200, {
        success: true,
        candidacies: [...candidacies.entries()]
          .filter(([, c]) => c.status === 'pending')
          .map(([id, c]) => {
            // Everything stored is served as is, so a test can plant extra or tampered fields (a `code`, another key, a `uuid`).
            const { status: _status, approval: _approval, ...fields } = c;
            const createdAt = Math.floor(Date.now() / 1000);
            const bound = typeof fields.uuid === 'string' ? owners.get(fields.uuid) : undefined;
            // A token revoked in the console no longer has a label: the relay says so with a placeholder.
            const binding = { uuidBound: bound !== undefined, ...(bound !== undefined ? { boundTokenLabel: machineTokens.get(bound) ?? '(revoked token)' } : {}), boundToCandidateToken: bound !== undefined && bound === postedBy.get(id) };
            const entry = { id, observedIp: '127.0.0.1', createdAt, expiresAt: createdAt + 900, ...binding, ...fields };
            // The real relay dates a candidacy with ISO 8601 strings (relay-api.md said epoch seconds; the integration tests found the difference). Stored as seconds here.
            return { ...entry, createdAt: iso(entry.createdAt as number), expiresAt: iso(entry.expiresAt as number) };
          }),
      });
    }
    const cand = /^\/api\/machines\/candidacies\/([^/]+)(\/decision)?$/.exec(path);
    if (cand) {
      // The scope gate comes first, as on the real relay (a machine token learns nothing about candidacies that are not its own).
      if (method === 'PUT' && cand[2] && !admin) return err(res, 403, 'full_access_required', ADMIN_ONLY);
      const entry = candidacies.get(decodeURIComponent(cand[1] as string));
      if (!entry) return err(res, 404, 'not_found', 'no such candidacy');
      // A candidacy is read by the token that posted it, or by the admin; anyone else gets the same 404 as for an unknown one.
      const poster = postedBy.get(decodeURIComponent(cand[1] as string));
      if (method === 'GET' && !cand[2] && !admin && poster !== undefined && poster !== presented) return err(res, 404, 'not_found', 'no such candidacy');
      if (method === 'GET' && !cand[2]) return send(res, 200, entry.status === 'approved' ? { status: 'approved', approval: entry.approval } : { status: entry.status });
      if (method === 'PUT' && cand[2]) {
        if (!admin) return err(res, 403, 'full_access_required', ADMIN_ONLY);
        if (entry.status !== 'pending') return err(res, 409, 'not_pending', 'already decided');
        const b = body as { decision?: string; approval?: unknown };
        // The binding is saved in one step with the decision: over the limit, the candidacy stays pending.
        const refusal = b.decision === 'approve' ? overLimit(decodeURIComponent(cand[1] as string)) : undefined;
        if (refusal !== undefined) return err(res, 429, 'too_many_machines', refusal.message, { limit: refusal.limit });
        entry.status = b.decision === 'approve' ? 'approved' : 'rejected';
        if (b.decision === 'approve') {
          entry.approval = b.approval;
          bindAtApproval(decodeURIComponent(cand[1] as string));
        }
        return send(res, 204);
      }
    }
    if (method === 'GET' && path === '/api/machines') {
      return send(res, 200, { success: true, machines: [...records.entries()].map(([uuid, r]) => ({ uuid, record: r.record, ...presence(uuid) })) });
    }
    const bearer = (authorization ?? '').replace(/^Bearer /, '');
    const inboxRoute = /^\/api\/machines\/([^/]+)\/inbox(?:\/([^/]+))?$/.exec(path);
    if (inboxRoute) {
      const uuid = inboxRoute[1] as string;
      const id = inboxRoute[2] === undefined ? undefined : decodeURIComponent(inboxRoute[2]);
      if (uuid !== uuid.toLowerCase()) return send(res, 403, { success: false, error: 'forbidden', serverTime: 1 });
      if (method === 'PUT' && id !== undefined) {
        if (!admin) return err(res, 403, 'full_access_required', ADMIN_ONLY);
        if (!ID_PATTERN.test(id)) return err(res, 400, 'invalid_id', 'id must be 22 characters of base64url');
        const document = body as { body?: { to?: unknown; id?: unknown } } | undefined;
        if (document?.body?.to !== uuid || document?.body?.id !== id) return err(res, 400, 'invalid_body', 'body.to and body.id must equal the path');
        if (Buffer.byteLength(raw) > 32 * 1024) return err(res, 413, 'body_too_large', 'a request is at most 32 KiB');
        if (Buffer.byteLength(raw) > 16 * 1024) return err(res, 400, 'invalid_body', 'a document is at most 16 KiB');
        const box = inboxes.get(uuid) ?? new Map();
        const known = box.get(id);
        if (known !== undefined) return known.text === raw ? send(res, 204) : err(res, 409, 'id_conflict', 'another document is stored under this id');
        if (box.size >= perInbox) return err(res, 429, 'too_many_documents', `the inbox of ${uuid} is full: that machine is not draining it`);
        if (inboxBytes() + raw.length > globalBytes) return err(res, 429, 'relay_inbox_full', 'the relay inboxes are full');
        box.set(id, { id, document: body, storedAt: Math.floor(Date.now() / 1000), text: raw });
        inboxes.set(uuid, box);
        return send(res, 204);
      }
      // Reading and deleting: the token that owns the uuid, or a full-access token. No oracle on unknown uuids: 403 for everyone else.
      if (notRegistered(uuid)) return;
      const mayRead = admin || (owners.get(uuid) !== undefined && owners.get(uuid) === bearer);
      if (!mayRead) return err(res, 403, 'not_owner', 'this token does not own that inbox');
      if (method === 'GET' && id === undefined) {
        const all = [...(inboxes.get(uuid)?.values() ?? [])];
        const after = new URLSearchParams((req.url ?? '').split('?')[1] ?? '').get('after');
        const cursorAt = after === null ? -1 : all.findIndex((d) => d.id === after);
        if (after !== null && cursorAt === -1) return err(res, 400, 'invalid_cursor', 'unknown cursor');
        const start = cursorAt + 1;
        const page = all.slice(start, start + pageSize);
        const more = start + pageSize < all.length;
        return send(res, 200, { success: true, documents: page.map(({ id: docId, document, storedAt }) => ({ id: docId, document, storedAt: iso(storedAt) })), more, next: more ? (page.at(-1) as FakeInboxDocument).id : null });
      }
      if (method === 'DELETE' && id !== undefined) {
        inboxes.get(uuid)?.delete(id);
        return send(res, 204);
      }
    }
    const machine = /^\/api\/machines\/([^/]+)(\/heartbeat)?$/.exec(path);
    if (machine) {
      const uuid = machine[1] as string;
      if (uuid !== uuid.toLowerCase()) return send(res, 403, { success: false, error: 'forbidden', serverTime: 1 });
      if (method === 'DELETE' && !machine[2]) {
        if (!admin) return err(res, 403, 'full_access_required', ADMIN_ONLY);
        records.delete(uuid);
        lastSeen.delete(uuid);
        owners.delete(uuid);
        inboxes.delete(uuid);
        return send(res, 204);
      }
      // The count is that of the inbox the caller owns; a token that does not own the uuid sees 0.
      if (method === 'POST' && machine[2]) {
        if (notRegistered(uuid, fullAdmin)) return;
        // As the real relay: another token's uuid is refused, and a heartbeat before the first address record is a 404 (the record is written first).
        if (!fullAdmin && owners.get(uuid) !== bearer) return err(res, 403, 'not_owner', 'This machine belongs to another token (the one whose candidacy the admin approved). Use that token, or a full-access one; after a token rotation the machine posts a new candidacy and the admin approves it.');
        if (!records.has(uuid)) return err(res, 404, 'not_found', 'No address record for this uuid yet: write it first with PUT /api/machines/<uuid>.');
        lastSeen.set(uuid, clock());
        return send(res, 200, { success: true, serverTime: 1, inbox: { count: inboxes.get(uuid)?.size ?? 0 } });
      }
      if (method === 'GET' && !machine[2]) {
        const r = records.get(uuid);
        return r ? send(res, 200, { success: true, uuid, record: r.record, ...presence(uuid), etag: String(r.etag) }) : err(res, 404, 'not_found', 'no such machine');
      }
      if (method === 'PUT' && !machine[2]) {
        if (notRegistered(uuid, fullAdmin)) return;
        const current = records.get(uuid);
        // Only the token bound at approval writes (a full-access token always may).
        const owner = owners.get(uuid);
        if (owner !== undefined && owner !== bearer && !fullAdmin) return err(res, 403, 'not_owner', 'this token does not own that machine record');
        const shape = body as { body?: { uuid?: unknown } } | undefined;
        if (typeof body !== 'object' || body === null || Array.isArray(body) || Object.keys(body).sort().join() !== 'body,signature' || typeof shape?.body !== 'object' || shape.body === null) {
          return err(res, 400, 'invalid_body', 'a record is { body, signature } and nothing else');
        }
        if (shape.body.uuid !== uuid) return err(res, 400, 'invalid_body', 'body.uuid must equal the uuid of the path');
        if (Buffer.byteLength(raw) > MAX_RECORD_BYTES) return err(res, 400, 'invalid_body', 'a record is at most 2 KiB');
        const ifMatch = req.headers['if-match'];
        if (ifMatch !== undefined && String(current?.etag) !== ifMatch) return err(res, 412, 'precondition_failed', 'etag mismatch', { currentEtag: String(current?.etag ?? '') });
        // The same bytes again only refresh presence.
        const etag = current !== undefined && current.text === raw ? current.etag : (current?.etag ?? 0) + 1;
        records.set(uuid, { record: body, etag, text: raw });
        lastSeen.set(uuid, clock());
        return send(res, 200, { success: true, etag: String(etag) }, { ETag: String(etag) });
      }
    }
    return err(res, 404, 'not_found', 'no such route');
  };

  const server: Server = createServer((req, res) => {
    handle(req, res).catch((e) => err(res, 500, 'store_unavailable', (e as Error).message));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  return {
    url: `http://127.0.0.1:${port}`,
    token,
    adminToken,
    machineAdminTokens,
    get machineAdminToken() {
      const first = machineAdminTokens[0];
      if (first === undefined) throw new Error('fake relay: no machine-admin device login was approved and polled yet');
      return first;
    },
    requests,
    candidacies,
    deviceLogins,
    deviceApprove: (o = {}) => {
      const entry = pendingDevice(o.request);
      entry.status = 'approved';
      entry.deliveredLabel = o.label ?? entry.label;
    },
    deviceDeny: () => void (pendingDevice().status = 'denied'),
    deviceChoices: (userCode) => {
      const entry = [...deviceLogins.values()].find((d) => d.status === 'pending' && (userCode === undefined ? d.choices.length > 0 : d.userCode === userCode));
      if (!entry) throw new Error(`fake relay: no pending device login${userCode !== undefined ? ` showing ${userCode}` : ' with choices'}`);
      return [...entry.choices];
    },
    deviceClick: (code) => {
      const all = [...deviceLogins.values()].filter((d) => d.choices.includes(code));
      const entry = all.find((d) => d.status === 'pending') ?? all[0];
      if (!entry) throw new Error(`fake relay: no device login offers the code ${code}`);
      if (entry.status !== 'pending') return { status: 409, error: 'not_pending' };
      if (code === entry.userCode) {
        entry.status = 'approved';
        entry.deliveredLabel = entry.label;
        return { status: 200 };
      }
      entry.status = 'denied';
      return { status: 409, error: 'request_denied' };
    },
    deviceExpire: () => void (pendingDevice().status = 'expired'),
    force: (prefix, status, body, headers = {}, method) => void forced.push({ prefix, status, body, headers, method }),
    approve: (id, approval, options = {}) => {
      const entry = candidacies.get(id);
      if (!entry || entry.status !== 'pending') throw new Error(`fake relay: no pending candidacy ${id}`);
      const refusal = overLimit(id);
      if (refusal !== undefined) throw new Error(`fake relay: approving ${id} is refused (the real relay answers 429 too_many_machines, limit ${refusal.limit}): ${refusal.message}`);
      entry.status = 'approved';
      // An approval built by buildApproval is sealed now that the random it answers is known.
      completeDraft(approval, typeof (approval as { random?: unknown } | null)?.random === 'string' ? (approval as { random: string }).random : String(entry.random));
      const bindable = options.bind !== false && typeof approval === 'object' && approval !== null && !Array.isArray(approval) && !('random' in approval);
      entry.approval = bindable ? { ...(approval as object), random: entry.random } : approval;
      bindAtApproval(id);
    },
    reject: (id) => {
      const entry = candidacies.get(id);
      if (!entry || entry.status !== 'pending') throw new Error(`fake relay: no pending candidacy ${id}`);
      entry.status = 'rejected';
    },
    addMachineToken: (label) => {
      const added = `tok_${randomBytes(12).toString('hex')}`;
      machineTokens.set(added, label ?? `machine-token-${machineTokens.size + 1}`);
      return added;
    },
    revokeMachineToken: (revoked) => void machineTokens.delete(revoked),
    setClock: (now) => {
      clock = now;
    },
    setOwner: (uuid, owner) => void (owner === undefined ? owners.delete(uuid) : owners.set(uuid, owner)),
    inbox: (uuid) => [...(inboxes.get(uuid)?.values() ?? [])].map(({ id, document, storedAt }) => ({ id, document, storedAt })),
    addCandidacy: (id, fields) => void candidacies.set(id, { status: 'pending', ...fields }),
    expire: (id) => void candidacies.delete(id),
    pendingIds: () => [...candidacies.entries()].filter(([, c]) => c.status === 'pending').map(([id]) => id),
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
