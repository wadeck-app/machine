import { createServer, type Server } from 'node:http';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import register from './index.js';
import { makeTempDir, removeTempDir } from './tempDir.testUtil.js';

// A harness for the tests of the routes that carry what the page signed (rename, network aliases): the real module routes, a fake daemon that records what it is given.

export const DAEMON_TOKEN = 'daemon-health-token-value';
export const HEADER = { 'x-machine-module': '1' };
export const PEER_UUID = '0b8a7a52-7f0d-4f0e-8a56-2f0d3a1c9e11';
export const OTHER_UUID = '11111111-1111-4111-8111-111111111111';

export type Handler = (req: unknown, reply: Reply) => unknown;
export interface Reply { code(status: number): Reply; send(body: unknown): unknown }
export interface Registered { handler: Handler; options: unknown }

export interface Harness {
  events: string[];
  routes(): Map<string, Registered>;
  call(key: string, req: { headers?: Record<string, string>; params?: Record<string, string>; body?: unknown }): Promise<{ status: number; body: any }>;
  startDaemon(answers: Record<string, unknown>): Promise<Array<{ command: string; body: unknown }>>;
  close(): Promise<void>;
}

export function harness(prefix: string): Harness {
  const configDir = makeTempDir(prefix);
  const servers: Server[] = [];
  const events: string[] = [];
  const previous = process.env['MACHINE_CONFIG_DIR'];
  process.env['MACHINE_CONFIG_DIR'] = configDir;

  const routes = (): Map<string, Registered> => {
    const map = new Map<string, Registered>();
    register({ registerRoute: (method: string, path: string, handler: Handler, options?: unknown) => { map.set(`${method} ${path}`, { handler, options }); } } as never);
    return map;
  };
  return {
    events,
    routes,
    async call(key, req) {
      const route = routes().get(key);
      if (route === undefined) throw new Error(`route not registered: ${key}`);
      let status = 200;
      let sent: unknown;
      const reply: Reply = { code(s) { status = s; return reply; }, send(b) { sent = b; return b; } };
      await route.handler({ headers: req.headers ?? {}, params: req.params ?? {}, query: {}, body: req.body }, reply);
      return { status, body: sent };
    },
    async startDaemon(answers) {
      const bodies: Array<{ command: string; body: unknown }> = [];
      const daemon = createServer((req, res) => {
        let text = '';
        req.on('data', (c: Buffer) => { text += c.toString(); });
        req.on('end', () => {
          const command = (req.url ?? '').slice(1);
          events.push(`daemon-${command}`);
          bodies.push({ command, body: text === '' ? undefined : JSON.parse(text) });
          const known = req.headers.authorization === `Bearer ${DAEMON_TOKEN}` && command in answers;
          res.writeHead(known ? 200 : 404, { 'content-type': 'application/json' });
          res.end(JSON.stringify(known ? { result: answers[command] } : { error: `Unknown command: ${command}` }));
        });
      });
      servers.push(daemon);
      await new Promise<void>((resolve) => daemon.listen(0, '127.0.0.1', resolve));
      mkdirSync(configDir, { recursive: true });
      writeFileSync(join(configDir, 'daemon.port.json'), JSON.stringify({ pid: process.pid, port: (daemon.address() as { port: number }).port, peerPort: 1 }));
      writeFileSync(join(configDir, 'health_token'), DAEMON_TOKEN);
      return bodies;
    },
    async close() {
      if (previous === undefined) delete process.env['MACHINE_CONFIG_DIR'];
      else process.env['MACHINE_CONFIG_DIR'] = previous;
      await Promise.all(servers.map((s) => new Promise<void>((resolve) => s.close(() => resolve()))));
      removeTempDir(configDir);
    },
  };
}
