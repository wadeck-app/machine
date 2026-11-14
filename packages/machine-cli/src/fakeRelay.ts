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
  /** Inbox limits of distribution.md (defaults: 256 documents per inbox, 64 MiB for all inboxes). */
  inboxLimits?: { perInbox?: number; globalBytes?: number };
  /** Documents per page of the inbox listing (default 32, as the contract says). */
  inboxPageSize?: number;
  /** More pairing codes, each claimed once and giving its OWN machine token, labelled "<label>-2", "<label>-3", ... (two machines on one relay). */
  moreCodes?: string[];
  /** Machines one token may hold (approved uuids bound to it); the 51st approval is `429 too_many_machines`. Default 50, as the deployed relay. */
  maxMachinesPerToken?: number;
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
  /** Label delivered on approval (the relay may add a suffix). */
  deliveredLabel?: string;
}

export interface FakeRelay {
  url: string;
  token: string;
  /** Token given by the second pairing code (full access unless `adminScopes` says otherwise). */
  adminToken: string;
  /** Every request received: method, path and the Authorization header. */
  requests: { method: string; path: string; authorization: string | undefined; body: unknown }[];
  candidacies: Map<string, Record<string, unknown> & { status: string }>;
  /** Device logins by deviceCode (a secret in real life: tests read it here to check that it is never printed). */
  deviceLogins: Map<string, FakeDeviceLogin>;
  /** The console approves the oldest pending device login; `label` is what the relay delivers (it may carry a "-2" suffix). */
  deviceApprove: (options?: { label?: string }) => void;
  deviceDeny: () => void;
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
  const maxMachinesPerToken = options.maxMachinesPerToken ?? 50;
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
  const pendingDevice = (): FakeDeviceLogin => {
    const entry = [...deviceLogins.values()].find((d) => d.status === 'pending');
    if (!entry) throw new Error('fake relay: no pending device login');
    return entry;
  };

  // The limit applies at approval: a token already holding the maximum of OTHER uuids cannot get one more (the candidacy stays pending).
  const overLimit = (id: string): boolean => {
    const entry = candidacies.get(id);
    const poster = postedBy.get(id);
    if (entry === undefined || typeof entry.uuid !== 'string' || poster === undefined) return false;
    return [...owners.entries()].filter(([uuid, owner]) => owner === poster && uuid !== entry.uuid).length >= maxMachinesPerToken;
  };
  // The approval binds the uuid of the candidacy to the token that posted it, replacing any earlier binding.
  const bindAtApproval = (id: string) => {
    const entry = candidacies.get(id);
    const poster = postedBy.get(id);
    if (entry !== undefined && typeof entry.uuid === 'string' && poster !== undefined) owners.set(entry.uuid, poster);
  };
  const presence = (uuid: string) => {
    const seen = lastSeen.get(uuid);
    return { lastSeen: seen ?? null, online: seen !== undefined && clock() - seen < ONLINE_SECONDS };
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
      if (typeof label !== 'string' || !/^[A-Za-z0-9 _.-]{1,64}$/.test(label)) return err(res, 400, 'invalid_body', 'label: 1-64 characters, letters, digits, space, _ . -');
      const deviceCode = randomBytes(32).toString('base64url');
      const userCode = options.deviceUserCode ?? 'BCDF-GH23';
      deviceLogins.set(deviceCode, { userCode, label, status: 'pending' });
      return send(res, 201, { success: true, serverTime: 1, deviceCode, userCode, expiresIn: options.deviceExpiresIn ?? 300, pollIntervalSeconds: 3, verificationUrl: `https://relay.example/device?code=${userCode}` });
    }
    if (method === 'POST' && path === '/api/device-login/poll') {
      const entry = deviceLogins.get(String((body as { deviceCode?: unknown } | undefined)?.deviceCode ?? ''));
      // Unknown, spent or expired: the same answer.
      if (!entry || entry.status === 'expired') return send(res, 200, { success: true, serverTime: 1, status: 'expired' });
      if (entry.status === 'pending' || entry.status === 'denied') return send(res, 200, { success: true, serverTime: 1, status: entry.status });
      // Approved: delivered once, the next poll says expired.
      entry.status = 'expired';
      return send(res, 200, { success: true, serverTime: 1, status: 'approved', token, label: entry.deliveredLabel ?? entry.label, scopes: deviceScopes });
    }

    if (!path.startsWith('/api/machines')) return err(res, 404, 'not_found', 'no such route');
    const isAdminToken = authorization === `Bearer ${adminToken}`;
    const presented = (authorization ?? '').replace(/^Bearer /, '');
    if (!machineTokens.has(presented) && !isAdminToken) return err(res, 401, 'unauthorized', 'invalid token');
    // A machine token reaches only the machine routes, and never the admin ones.
    const admin = isAdminToken ? adminScopes === null : presented === token && scopes === null;
    // A uuid that was never bound by an approval: a machine token cannot use it at all.
    const notRegistered = (uuid: string): boolean => {
      if (admin || owners.get(uuid) !== undefined) return false;
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
      return send(res, 201, { id, createdAt, expiresAt: createdAt + 900 });
    }
    if (method === 'GET' && path === '/api/machines/candidacies') {
      if (!admin) return err(res, 403, 'full_access_required', 'listing candidacies needs a full-access token');
      return send(res, 200, {
        candidacies: [...candidacies.entries()]
          .filter(([, c]) => c.status === 'pending')
          .map(([id, c]) => {
            // Everything stored is served as is, so a test can plant extra or tampered fields (a `code`, another key, a `uuid`).
            const { status: _status, approval: _approval, ...fields } = c;
            const createdAt = Math.floor(Date.now() / 1000);
            const bound = typeof fields.uuid === 'string' ? owners.get(fields.uuid) : undefined;
            // A token revoked in the console no longer has a label: the relay says so with a placeholder.
            const binding = { uuidBound: bound !== undefined, ...(bound !== undefined ? { boundTokenLabel: machineTokens.get(bound) ?? '(revoked token)' } : {}), boundToCandidateToken: bound !== undefined && bound === postedBy.get(id) };
            return { id, observedIp: '127.0.0.1', createdAt, expiresAt: createdAt + 900, ...binding, ...fields };
          }),
      });
    }
    const cand = /^\/api\/machines\/candidacies\/([^/]+)(\/decision)?$/.exec(path);
    if (cand) {
      const entry = candidacies.get(decodeURIComponent(cand[1] as string));
      if (!entry) return err(res, 404, 'not_found', 'no such candidacy');
      if (method === 'GET' && !cand[2]) return send(res, 200, entry.status === 'approved' ? { status: 'approved', approval: entry.approval } : { status: entry.status });
      if (method === 'PUT' && cand[2]) {
        if (!admin) return err(res, 403, 'full_access_required', 'deciding needs a full-access token');
        if (entry.status !== 'pending') return err(res, 409, 'not_pending', 'already decided');
        const b = body as { decision?: string; approval?: unknown };
        // The binding is saved in one step with the decision: over the limit, the candidacy stays pending.
        if (b.decision === 'approve' && overLimit(decodeURIComponent(cand[1] as string))) {
          return err(res, 429, 'too_many_machines', 'This token already holds the maximum number of machines (50). Remove the machines that are gone with DELETE /api/machines/<uuid>, then approve again.');
        }
        entry.status = b.decision === 'approve' ? 'approved' : 'rejected';
        if (b.decision === 'approve') {
          entry.approval = b.approval;
          bindAtApproval(decodeURIComponent(cand[1] as string));
        }
        return send(res, 204);
      }
    }
    if (method === 'GET' && path === '/api/machines') {
      return send(res, 200, { machines: [...records.entries()].map(([uuid, r]) => ({ uuid, record: r.record, ...presence(uuid) })) });
    }
    const bearer = (authorization ?? '').replace(/^Bearer /, '');
    const inboxRoute = /^\/api\/machines\/([^/]+)\/inbox(?:\/([^/]+))?$/.exec(path);
    if (inboxRoute) {
      const uuid = inboxRoute[1] as string;
      const id = inboxRoute[2] === undefined ? undefined : decodeURIComponent(inboxRoute[2]);
      if (uuid !== uuid.toLowerCase()) return send(res, 403, { success: false, error: 'forbidden', serverTime: 1 });
      if (method === 'PUT' && id !== undefined) {
        if (!admin) return err(res, 403, 'scope_denied', 'writing to an inbox needs a full-access token');
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
        return send(res, 200, { documents: page.map(({ id: docId, document, storedAt }) => ({ id: docId, document, storedAt })), more, ...(more ? { next: (page.at(-1) as FakeInboxDocument).id } : {}) });
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
        if (!admin) return err(res, 403, 'scope_denied', 'deleting a machine needs a full-access token');
        records.delete(uuid);
        lastSeen.delete(uuid);
        owners.delete(uuid);
        inboxes.delete(uuid);
        return send(res, 204);
      }
      // The count is that of the inbox the caller owns; a token that does not own the uuid sees 0.
      if (method === 'POST' && machine[2]) {
        if (notRegistered(uuid)) return;
        if (owners.get(uuid) === bearer) lastSeen.set(uuid, clock());
        return send(res, 200, { success: true, serverTime: 1, inbox: { count: owners.get(uuid) === bearer ? (inboxes.get(uuid)?.size ?? 0) : 0 } });
      }
      if (method === 'GET' && !machine[2]) {
        const r = records.get(uuid);
        return r ? send(res, 200, { uuid, record: r.record, ...presence(uuid), etag: String(r.etag) }) : err(res, 404, 'not_found', 'no such machine');
      }
      if (method === 'PUT' && !machine[2]) {
        if (notRegistered(uuid)) return;
        const current = records.get(uuid);
        // Only the token bound at approval writes (a full-access token always may).
        const owner = owners.get(uuid);
        if (owner !== undefined && owner !== bearer && !admin) return err(res, 403, 'not_owner', 'this token does not own that machine record');
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
    requests,
    candidacies,
    deviceLogins,
    deviceApprove: (o = {}) => {
      const entry = pendingDevice();
      entry.status = 'approved';
      entry.deliveredLabel = o.label ?? entry.label;
    },
    deviceDeny: () => void (pendingDevice().status = 'denied'),
    deviceExpire: () => void (pendingDevice().status = 'expired'),
    force: (prefix, status, body, headers = {}, method) => void forced.push({ prefix, status, body, headers, method }),
    approve: (id, approval, options = {}) => {
      const entry = candidacies.get(id);
      if (!entry || entry.status !== 'pending') throw new Error(`fake relay: no pending candidacy ${id}`);
      if (overLimit(id)) throw new Error(`fake relay: approving ${id} is over the limit of ${maxMachinesPerToken} machines per token (the real relay answers 429 too_many_machines)`);
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
