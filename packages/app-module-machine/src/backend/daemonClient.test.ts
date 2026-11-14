import { createServer, type IncomingMessage, type Server } from 'node:http';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DaemonAuthError, DaemonCommandError, DaemonUnreachableError, callDaemon } from './daemonClient.js';
import { makeTempDir, removeTempDir } from './tempDir.testUtil.js';

const TOKEN = 'health-token-secret-value';

interface Seen { method?: string; url?: string; authorization?: string; body: string }

let configDir: string;
let servers: Server[];

beforeEach(() => {
  configDir = makeTempDir('app-module-machine-daemon-');
  servers = [];
});

afterEach(async () => {
  await closeAll();
  removeTempDir(configDir);
});

async function closeAll(): Promise<void> {
  await Promise.all(servers.map((s) => new Promise<void>((resolve) => s.close(() => resolve()))));
  servers = [];
}

async function fakeDaemon(answer: (seen: Seen) => { status: number; body: unknown }): Promise<{ port: number; seen: Seen[] }> {
  const seen: Seen[] = [];
  const server = createServer((req: IncomingMessage, res) => {
    let body = '';
    req.on('data', (c: Buffer) => { body += c.toString(); });
    req.on('end', () => {
      const entry: Seen = { method: req.method, url: req.url, authorization: req.headers.authorization, body };
      seen.push(entry);
      const out = answer(entry);
      res.writeHead(out.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(out.body));
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no port');
  return { port: address.port, seen };
}

function writePortFile(port: number): void {
  writeFileSync(join(configDir, 'daemon.port.json'), JSON.stringify({ pid: process.pid, port, peerPort: 1 }));
}

function writeToken(): void {
  writeFileSync(join(configDir, 'health_token'), `${TOKEN}\n`);
}

describe('callDaemon', () => {
  it('posts the command to 127.0.0.1 on the port of daemon.port.json with the health token, and returns the result', async () => {
    const { port, seen } = await fakeDaemon(() => ({ status: 200, body: { result: { initialized: true, name: 'alpha' } } }));
    writePortFile(port);
    writeToken();
    const result = await callDaemon(configDir, 'status');
    expect(result).toEqual({ initialized: true, name: 'alpha' });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.method).toBe('POST');
    expect(seen[0]?.url).toBe('/status');
    expect(seen[0]?.authorization).toBe(`Bearer ${TOKEN}`);
  });

  it('reads the port file at EACH call (a restarted daemon on another port is followed)', async () => {
    const first = await fakeDaemon(() => ({ status: 200, body: { result: 'first' } }));
    const second = await fakeDaemon(() => ({ status: 200, body: { result: 'second' } }));
    writeToken();
    writePortFile(first.port);
    expect(await callDaemon(configDir, 'list')).toBe('first');
    writePortFile(second.port);
    expect(await callDaemon(configDir, 'list')).toBe('second');
  });

  it('says the daemon is not running and how to start it when daemon.port.json is missing', async () => {
    writeToken();
    const error = await callDaemon(configDir, 'list').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DaemonUnreachableError);
    const message = (error as Error).message;
    expect(message).toContain(join(configDir, 'daemon.port.json'));
    expect(message).toContain('machine daemon');
  });

  it('names the file when daemon.port.json is corrupt', async () => {
    writeFileSync(join(configDir, 'daemon.port.json'), '{not json');
    writeToken();
    const error = await callDaemon(configDir, 'list').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DaemonUnreachableError);
    expect((error as Error).message).toContain('daemon.port.json');
    expect((error as Error).message).toContain('corrupt');
  });

  it('names the file when the port is not a valid port number', async () => {
    writeFileSync(join(configDir, 'daemon.port.json'), JSON.stringify({ pid: 1, port: 'abc', peerPort: 2 }));
    writeToken();
    const error = await callDaemon(configDir, 'list').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DaemonUnreachableError);
    expect((error as Error).message).toContain('port');
  });

  it('says the daemon is unreachable when nothing listens on the recorded port (stale file)', async () => {
    const { port } = await fakeDaemon(() => ({ status: 200, body: {} }));
    // The server is closed first: the port is now free.
    await closeAll();
    writePortFile(port);
    writeToken();
    const error = await callDaemon(configDir, 'list').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DaemonUnreachableError);
    expect((error as Error).message).toContain(String(port));
  });

  it('says the health token is missing (daemon crashed between its two writes) without inventing a cause', async () => {
    const { port } = await fakeDaemon(() => ({ status: 200, body: { result: 1 } }));
    writePortFile(port);
    const error = await callDaemon(configDir, 'list').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DaemonUnreachableError);
    expect((error as Error).message).toContain('health_token');
  });

  it('answers a distinct DaemonAuthError on 401, with no token in the message', async () => {
    const { port } = await fakeDaemon(() => ({ status: 401, body: { error: 'Unauthorized' } }));
    writePortFile(port);
    writeToken();
    const error = await callDaemon(configDir, 'list').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DaemonAuthError);
    expect((error as Error).message).not.toContain(TOKEN);
    expect((error as Error).message).toContain('health_token');
  });

  it('carries the error text of a failed command (500)', async () => {
    const { port } = await fakeDaemon(() => ({ status: 500, body: { error: 'disk exploded' } }));
    writePortFile(port);
    writeToken();
    const error = await callDaemon(configDir, 'list').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DaemonCommandError);
    expect((error as Error).message).toContain('disk exploded');
  });

  it('refuses an answer without a result instead of returning an empty value', async () => {
    const { port } = await fakeDaemon(() => ({ status: 200, body: { nothing: true } }));
    writePortFile(port);
    writeToken();
    const error = await callDaemon(configDir, 'list').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DaemonCommandError);
    expect((error as Error).message).toContain('result');
  });

  it('refuses a command name that is not a plain word (no path injection to the daemon)', async () => {
    writeToken();
    await expect(callDaemon(configDir, '../quit')).rejects.toThrow(/command/);
  });
});
