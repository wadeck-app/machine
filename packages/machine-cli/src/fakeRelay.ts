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
  token?: string;
  label?: string;
}

export interface FakeRelay {
  url: string;
  token: string;
  /** Every request received: method, path and the Authorization header. */
  requests: { method: string; path: string; authorization: string | undefined; body: unknown }[];
  candidacies: Map<string, Record<string, unknown> & { status: string }>;
  /** Next answer forced on a path prefix (one shot). */
  force: (pathPrefix: string, status: number, body: unknown, headers?: Record<string, string>) => void;
  close: () => Promise<void>;
}

export async function startFakeRelay(options: FakeRelayOptions = {}): Promise<FakeRelay> {
  const code = options.code ?? '12345678';
  const token = options.token ?? `tok_${randomBytes(12).toString('hex')}`;
  const scopes = options.scopes === undefined ? ['machine'] : options.scopes;
  let codeUsed = false;
  const forced: { prefix: string; status: number; body: unknown; headers: Record<string, string> }[] = [];
  const records = new Map<string, { record: unknown; etag: number }>();
  const candidacies: FakeRelay['candidacies'] = new Map();
  const requests: FakeRelay['requests'] = [];

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

    const forcedAt = forced.findIndex((f) => path.startsWith(f.prefix));
    if (forcedAt !== -1) {
      const [f] = forced.splice(forcedAt, 1) as [(typeof forced)[number]];
      return send(res, f.status, f.body, f.headers);
    }

    if (method === 'POST' && path === '/api/pairings/claim') {
      const given = String((body as { code?: unknown } | undefined)?.code ?? '').replace(/[\s-]/g, '');
      if (codeUsed || given !== code) return send(res, 401, { success: false, error: 'Invalid or expired code.', serverTime: 1 });
      codeUsed = true;
      return send(res, 200, { success: true, serverTime: 1, token, label: options.label ?? 'machine-pairing', scopes });
    }

    if (!path.startsWith('/api/machines')) return err(res, 404, 'not_found', 'no such route');
    if (authorization !== `Bearer ${token}`) return err(res, 401, 'unauthorized', 'invalid token');
    // A machine token reaches only the machine routes, and never the admin ones.
    const admin = scopes === null;

    if (method === 'POST' && path === '/api/machines/candidacies') {
      const id = randomBytes(16).toString('base64url');
      candidacies.set(id, { status: 'pending', ...(body as object) });
      return send(res, 201, { id, createdAt: 1_800_000_000, expiresAt: 1_800_000_900 });
    }
    if (method === 'GET' && path === '/api/machines/candidacies') {
      if (!admin) return err(res, 403, 'full_access_required', 'listing candidacies needs a full-access token');
      return send(res, 200, { candidacies: [...candidacies.entries()].filter(([, c]) => c.status === 'pending').map(([id, c]) => ({ id, ...c, observedIp: '127.0.0.1', createdAt: 1, expiresAt: 2 })) });
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
    requests,
    candidacies,
    force: (prefix, status, body, headers = {}) => void forced.push({ prefix, status, body, headers }),
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
