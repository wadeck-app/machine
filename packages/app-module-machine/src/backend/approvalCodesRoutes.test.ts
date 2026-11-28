import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import register from './index.js';
import { makeTempDir, removeTempDir } from './tempDir.testUtil.js';

// POST /approval-codes: the page hands over the security code of the approval it just made, so that it can be read again after the dialog is closed. Public value,
// no signature, no passphrase; a plain write route (the app-core PIN was already asked for the approval).

const HEADER = { 'x-machine-module': '1' };
const UUID = '0b8a7a52-7f0d-4f0e-8a56-2f0d3a1c9e11';
const CODE = '12345 67890 12345 67890 12345';
const ROUTE = 'POST /approval-codes';

type Handler = (req: unknown, reply: Reply) => unknown;
interface Reply { code(status: number): Reply; send(body: unknown): unknown }

let configDir: string;
let previous: string | undefined;

beforeEach(() => {
  configDir = makeTempDir('app-module-machine-codes-routes-');
  previous = process.env['MACHINE_CONFIG_DIR'];
  process.env['MACHINE_CONFIG_DIR'] = configDir;
});
afterEach(() => {
  if (previous === undefined) delete process.env['MACHINE_CONFIG_DIR'];
  else process.env['MACHINE_CONFIG_DIR'] = previous;
  removeTempDir(configDir);
});

function route(): { handler: Handler; options: unknown } {
  const map = new Map<string, { handler: Handler; options: unknown }>();
  register({ registerRoute: (method: string, path: string, handler: Handler, options?: unknown) => { map.set(`${method} ${path}`, { handler, options }); } } as never);
  const found = map.get(ROUTE);
  if (found === undefined) throw new Error(`route not registered: ${ROUTE}`);
  return found;
}

async function call(req: { headers?: Record<string, string>; body?: unknown }): Promise<{ status: number; body: any }> {
  let status = 200;
  let sent: unknown;
  const reply: Reply = { code(s) { status = s; return reply; }, send(b) { sent = b; return b; } };
  await route().handler({ headers: req.headers ?? {}, params: {}, query: {}, body: req.body }, reply);
  return { status, body: sent };
}

describe('POST /approval-codes', () => {
  it('is a write route (not sensitive: it records a public reminder, it widens no right)', () => {
    expect(route().options).toEqual({ effect: 'write' });
  });

  it('without the module header: 403 and nothing is kept', async () => {
    const out = await call({ body: { uuid: UUID, name: 'laptop', code: CODE } });
    expect(out.status).toBe(403);
  });

  it('keeps the code with the name, the uuid and the time, and answers ok', async () => {
    const out = await call({ headers: HEADER, body: { uuid: UUID, name: 'laptop', code: CODE } });
    expect(out.status).toBe(200);
    expect(out.body).toEqual({ ok: true });
    const stored = JSON.parse(readFileSync(join(configDir, 'approval-codes.json'), 'utf8')) as { approvals: Array<{ uuid: string; name: string; code: string; at: number }> };
    expect(stored.approvals).toHaveLength(1);
    expect(stored.approvals[0]).toMatchObject({ uuid: UUID, name: 'laptop', code: CODE });
    expect(Math.abs((stored.approvals[0]?.at ?? 0) - Math.floor(Date.now() / 1000))).toBeLessThan(5);
  });

  it('another shape: 400 naming the rule, nothing is kept', async () => {
    const out = await call({ headers: HEADER, body: { uuid: UUID, name: 'laptop', code: 'nope' } });
    expect(out.status).toBe(400);
    expect(out.body.error).toMatch(/five groups of five digits/);
    expect(() => readFileSync(join(configDir, 'approval-codes.json'), 'utf8')).toThrow();
  });
});
