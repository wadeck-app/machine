import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { errorBody } from './errorBody.js';
import register from './index.js';
import { makeTempDir, removeTempDir } from './tempDir.testUtil.js';

// The shell fetcher and the PIN dialog of the page display the top-level `message` of an error answer: every error answer of every route family carries
// it, equal to `error` (which stays). The routes run against an EMPTY config dir (no daemon, no relay): nothing is contacted.

type Handler = (req: unknown, reply: Reply) => unknown;
interface Reply { code(status: number): Reply; send(body: unknown): unknown }

let configDir: string;
let previous: string | undefined;

beforeEach(() => {
  configDir = makeTempDir('app-module-machine-errmsg-');
  previous = process.env['MACHINE_CONFIG_DIR'];
  process.env['MACHINE_CONFIG_DIR'] = configDir;
});
afterEach(() => {
  if (previous === undefined) delete process.env['MACHINE_CONFIG_DIR'];
  else process.env['MACHINE_CONFIG_DIR'] = previous;
  removeTempDir(configDir);
});

function routes(): Map<string, Handler> {
  const map = new Map<string, Handler>();
  register({ registerRoute: (method: string, path: string, handler: Handler) => { map.set(`${method} ${path}`, handler); } } as never);
  return map;
}

async function call(handler: Handler, req: Record<string, unknown>): Promise<{ status: number; body: any }> {
  let status = 200;
  let sent: unknown;
  const reply: Reply = { code(s) { status = s; return reply; }, send(b) { sent = b; return b; } };
  await handler({ headers: {}, params: {}, query: {}, body: undefined, ...req }, reply);
  return { status, body: sent };
}

describe('errorBody', () => {
  it('keeps status, kind and error and adds a message equal to error', () => {
    expect(errorBody(409, 'not_initialized', 'run `machine setup <relay>`')).toEqual({
      status: 409,
      kind: 'not_initialized',
      error: 'run `machine setup <relay>`',
      message: 'run `machine setup <relay>`',
    });
  });
});

describe('error answers of the module routes', () => {
  // [route, request]: each one ends in an error answer without any daemon or relay.
  const CASES: Array<[string, Record<string, unknown>]> = [
    ['GET /status', {}],
    ['GET /machines', {}],
    ['GET /requests', {}],
    ['GET /candidacies', {}],
    ['GET /activity', {}],
    ['GET /allowed', {}],
    ['GET /hold-progress/:machine/:id', { params: { machine: 'self', id: 'not an id' } }],
    ['GET /hold-progress/:machine/:id', { params: { machine: 'self', id: '3f1c2d3e-4a5b-4c6d-8e7f-000000000001' } }],
    ['POST /requests/remote', {}],
    ['GET /admin-key', {}],
    ['GET /allow/:machine', { params: { machine: '' } }],
    ['POST /allow', {}],
    ['POST /deny', {}],
    ['POST /dismiss-notice', {}],
  ];

  it.each(CASES)('%s: every error answer has message equal to error, error unchanged', async (key, req) => {
    const handler = routes().get(key);
    if (handler === undefined) throw new Error(`route not registered: ${key}; registered: ${[...routes().keys()].join(', ')}`);
    const { status, body } = await call(handler, req);
    expect(status, `${key} answered ${status}, the case must end in an error: ${JSON.stringify(body)}`).toBeGreaterThanOrEqual(400);
    expect(typeof body.error).toBe('string');
    expect(body.error).not.toBe('');
    expect(body.message).toBe(body.error);
    expect(body.status).toBe(status);
    expect(typeof body.kind).toBe('string');
  });
});
