import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomBytes } from 'node:crypto';

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
  const records = new Map<string, { record: unknown; etag: number }>();
  const candidacies: FakeRelay['candidacies'] = new Map();
  const requests: FakeRelay['requests'] = [];
  const deviceLogins: FakeRelay['deviceLogins'] = new Map();
  const deviceScopes = options.deviceScopes === undefined ? ['machine'] : options.deviceScopes;
  const pendingDevice = (): FakeDeviceLogin => {
    const entry = [...deviceLogins.values()].find((d) => d.status === 'pending');
    if (!entry) throw new Error('fake relay: no pending device login');
    return entry;
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
    if (authorization !== `Bearer ${token}` && !isAdminToken) return err(res, 401, 'unauthorized', 'invalid token');
    // A machine token reaches only the machine routes, and never the admin ones.
    const admin = isAdminToken ? adminScopes === null : scopes === null;

    if (method === 'POST' && path === '/api/machines/candidacies') {
      const id = randomBytes(16).toString('base64url');
      const createdAt = Math.floor(Date.now() / 1000);
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
            return { id, observedIp: '127.0.0.1', createdAt, expiresAt: createdAt + 900, ...fields };
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
        entry.status = b.decision === 'approve' ? 'approved' : 'rejected';
        if (b.decision === 'approve') entry.approval = b.approval;
        return send(res, 204);
      }
    }
    if (method === 'GET' && path === '/api/machines') {
      return send(res, 200, { machines: [...records.entries()].map(([uuid, r]) => ({ uuid, record: r.record, lastSeen: 1, online: true })) });
    }
    const machine = /^\/api\/machines\/([^/]+)(\/heartbeat)?$/.exec(path);
    if (machine) {
      const uuid = machine[1] as string;
      if (uuid !== uuid.toLowerCase()) return send(res, 403, { success: false, error: 'forbidden', serverTime: 1 });
      if (method === 'POST' && machine[2]) return send(res, 204);
      if (method === 'GET' && !machine[2]) {
        const r = records.get(uuid);
        return r ? send(res, 200, { uuid, record: r.record, lastSeen: 1, online: true, etag: String(r.etag) }) : err(res, 404, 'not_found', 'no such machine');
      }
      if (method === 'PUT' && !machine[2]) {
        const current = records.get(uuid);
        const ifMatch = req.headers['if-match'];
        if (ifMatch !== undefined && String(current?.etag) !== ifMatch) return err(res, 412, 'precondition_failed', 'etag mismatch', { currentEtag: String(current?.etag ?? '') });
        const etag = (current?.etag ?? 0) + 1;
        records.set(uuid, { record: body, etag });
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
      entry.status = 'approved';
      const bindable = options.bind !== false && typeof approval === 'object' && approval !== null && !Array.isArray(approval) && !('random' in approval);
      entry.approval = bindable ? { ...(approval as object), random: entry.random } : approval;
    },
    reject: (id) => {
      const entry = candidacies.get(id);
      if (!entry || entry.status !== 'pending') throw new Error(`fake relay: no pending candidacy ${id}`);
      entry.status = 'rejected';
    },
    addCandidacy: (id, fields) => void candidacies.set(id, { status: 'pending', ...fields }),
    expire: (id) => void candidacies.delete(id),
    pendingIds: () => [...candidacies.entries()].filter(([, c]) => c.status === 'pending').map(([id]) => id),
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
