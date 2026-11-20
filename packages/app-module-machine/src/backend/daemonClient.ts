import { readFileSync } from 'node:fs';
import { request } from 'node:http';
import { join } from 'node:path';

// Calls the local machine daemon the way the kit client of machine-cli does (POST /<command> on 127.0.0.1, Bearer token of
// <configDir>/health_token, answer `{ result }`). The port file is read at EVERY call: a restarted daemon changes its port.
// The token is read per call, kept in a local variable and never part of an error.

const TIMEOUT_MS = 5000;
const COMMAND = /^[a-z][a-z0-9-]*$/;

/** The daemon cannot be reached: not running, stale or corrupt port file, missing token file. Status 503 for the page. */
export class DaemonUnreachableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DaemonUnreachableError';
  }
}

/** The daemon answered 401: the health_token read here is not the one of the running daemon. */
export class DaemonAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DaemonAuthError';
  }
}

/** The daemon answered, and the command failed or the answer is not what a command returns. */
export class DaemonCommandError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DaemonCommandError';
  }
}

const START_ADVICE = 'start it with `machine daemon` (or its orch job) and reload the page';

function readPort(configDir: string): number {
  const file = join(configDir, 'daemon.port.json');
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new DaemonUnreachableError(`the machine daemon is not running (no ${file}): ${START_ADVICE}`);
    }
    throw new DaemonUnreachableError(`cannot read ${file}: ${(e as Error).message}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new DaemonUnreachableError(`${file} is corrupt (not valid JSON): stop the daemon, delete the file and ${START_ADVICE}`);
  }
  const port = typeof parsed === 'object' && parsed !== null ? (parsed as { port?: unknown }).port : undefined;
  if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new DaemonUnreachableError(`${file} is corrupt (its port is not a valid port number): stop the daemon, delete the file and ${START_ADVICE}`);
  }
  return port;
}

function readToken(configDir: string): string {
  const file = join(configDir, 'health_token');
  try {
    return readFileSync(file, 'utf8').trim();
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new DaemonUnreachableError(`${file} is missing: the daemon wrote its port file but not its token (it may have stopped in between); restart it with \`machine daemon\``);
    }
    throw new DaemonUnreachableError(`cannot read ${file}: ${(e as Error).message}`);
  }
}

function post(port: number, command: string, token: string, timeoutMs: number): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const req = request({
      hostname: '127.0.0.1',
      port,
      method: 'POST',
      path: `/${command}`,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'Content-Length': 0 },
    }, (res) => {
      let text = '';
      res.on('data', (chunk: Buffer) => { text += chunk.toString(); });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, text }));
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`no answer within ${timeoutMs} ms`)));
    req.on('error', reject);
    req.end();
  });
}

export async function callDaemon(configDir: string, command: string, timeoutMs: number = TIMEOUT_MS): Promise<unknown> {
  if (!COMMAND.test(command)) throw new Error(`invalid daemon command "${command}": expected a lower-case word`);
  const port = readPort(configDir);
  const token = readToken(configDir);
  let answer: { status: number; text: string };
  try {
    answer = await post(port, command, token, timeoutMs);
  } catch (e) {
    throw new DaemonUnreachableError(`the machine daemon does not answer on 127.0.0.1:${port} (${(e as Error).message}): the port file may be stale; ${START_ADVICE}`);
  }
  if (answer.status === 401) {
    throw new DaemonAuthError(`the daemon refused the token read from ${join(configDir, 'health_token')}: it belongs to another daemon run; restart the daemon (\`machine stop\` then \`machine daemon\`)`);
  }
  let body: { result?: unknown; error?: unknown };
  try {
    body = JSON.parse(answer.text) as { result?: unknown; error?: unknown };
  } catch {
    throw new DaemonCommandError(`the daemon answered ${answer.status} with something that is not JSON`);
  }
  if (answer.status !== 200) {
    const why = typeof body.error === 'string' ? body.error : `status ${answer.status}`;
    throw new DaemonCommandError(`the daemon failed the command "${command}": ${why}`);
  }
  if (!('result' in body)) throw new DaemonCommandError(`the daemon answered "${command}" without a result: it may be an incompatible version`);
  return body.result;
}
