import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { insecureTlsProblem } from './candidacies.js';
import { SECRETS_DIRNAME } from './configDir.js';
import { callDaemon } from './daemonClient.js';

// Update test of app-core-cli: GET /api/modules/machine/health (module-authoring.md, "Update test of app-core-cli").
// READ ONLY: this file never writes, creates or deletes anything, and never puts a token or a key in an answer.
//
// What fails the update (ok:false) is only what the new module version could cause or what makes it unusable: the config folder or
// the identity missing or unreadable, a corrupt JSON file of the config folder. Everything the update cannot fix (a relay that is
// down, a refused token, a daemon that is stopped) is ok:true with the cause in `detail`.

export interface HealthCheck {
  name: string;
  ok: boolean;
  detail?: string;
}

export interface HealthAnswer {
  ok: boolean;
  checks: HealthCheck[];
}

/** The staged server has 60 s for all modules and this route should take under 3 s: relay and daemon are asked in parallel. */
const NETWORK_TIMEOUT_MS = 2000;
const MAX_BYTES = 64 * 1024;

const printable = (text: string): string => text.replace(/[^\x20-\x7e]/g, '?');
const errnoCode = (e: unknown): string | undefined => (e as NodeJS.ErrnoException).code;

const pass = (name: string, detail: string): HealthCheck => ({ name, ok: true, detail });
const fail = (name: string, detail: string): HealthCheck => ({ name, ok: false, detail });

// JSON files of the config folder that must parse when present. Absent is fine (not every machine has them).
const SECRET_JSON_FILES = ['peers.json', 'address-state.json'];
const CONFIG_JSON_FILES = ['policy.json', 'connections.json', 'peer-records.json'];

type FileRead = { state: 'absent' } | { state: 'bad'; why: string } | { state: 'ok'; value: unknown };

/** Reads and parses a JSON file. The content is never part of the result when it is bad (it may hold a secret). */
function readJson(file: string): FileRead {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (e) {
    if (errnoCode(e) === 'ENOENT') return { state: 'absent' };
    return { state: 'bad', why: `cannot read it (${printable((e as Error).message)})` };
  }
  try {
    return { state: 'ok', value: JSON.parse(text) };
  } catch {
    return { state: 'bad', why: 'not valid JSON' };
  }
}

const asObject = (value: unknown): Record<string, unknown> | undefined => (typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined);

function checkConfigDir(configDir: string): HealthCheck {
  const name = 'config-dir';
  const advice = 'run `machine setup`';
  try {
    if (!statSync(configDir).isDirectory()) return fail(name, `${configDir} is not a directory: move it away and ${advice}`);
    readdirSync(configDir);
    return pass(name, `${configDir} is readable`);
  } catch (e) {
    if (errnoCode(e) === 'ENOENT') return fail(name, `the machine config folder ${configDir} does not exist: ${advice} (the module itself loaded)`);
    return fail(name, `cannot read ${configDir} (${printable((e as Error).message)}): fix its permissions or run \`machine setup\``);
  }
}

function checkIdentity(configDir: string): HealthCheck {
  const name = 'identity';
  const file = join(configDir, SECRETS_DIRNAME, 'identity.json');
  const read = readJson(file);
  if (read.state === 'absent') return fail(name, `no machine identity (no ${file}): run \`machine setup\``);
  if (read.state === 'bad') return fail(name, `${file} is unusable (${read.why}): restore it from a backup; do not delete it, the identity is signed at enrollment`);
  const machineName = asObject(read.value)?.['name'];
  if (typeof machineName !== 'string' || machineName.length === 0) return fail(name, `${file} is unusable (no machine name): restore it from a backup; do not delete it, the identity is signed at enrollment`);
  // Only the name: the file also holds the keys.
  return pass(name, `machine "${printable(machineName)}"`);
}

function checkConfigFiles(configDir: string): HealthCheck {
  const name = 'config-files';
  const problems: string[] = [];
  const files = [...SECRET_JSON_FILES.map((f) => join(configDir, SECRETS_DIRNAME, f)), ...CONFIG_JSON_FILES.map((f) => join(configDir, f))];
  for (const file of files) {
    const read = readJson(file);
    if (read.state === 'bad') problems.push(`${file} (${read.why})`);
  }
  if (problems.length > 0) return fail(name, `${problems.join('; ')}: fix the JSON, or move the file away and run \`machine status\` to see what is missing`);
  return pass(name, 'the network files that exist are valid JSON');
}

interface TokenFile {
  state: 'absent' | 'bad' | 'ok';
  detail?: string;
  relayUrl?: string;
  token?: string;
}

/** relay.json and relay-admin.json: `{ relayUrl, token, ... }`. The token stays in this object, never in a detail. */
function readTokenFile(file: string, fix: string): TokenFile {
  const read = readJson(file);
  if (read.state === 'absent') return { state: 'absent' };
  const bad = (why: string): TokenFile => ({ state: 'bad', detail: `${file} is corrupt or invalid (${why}): delete it and ${fix}` });
  if (read.state === 'bad') return bad(read.why);
  const o = asObject(read.value);
  if (o === undefined) return bad('not a JSON object');
  const relayUrl = o['relayUrl'];
  const token = o['token'];
  if (typeof relayUrl !== 'string' || relayUrl.length === 0) return bad('relayUrl is missing');
  if (typeof token !== 'string' || token.length === 0) return bad('token is missing');
  let url: URL;
  try {
    url = new URL(relayUrl);
  } catch {
    return bad('relayUrl is not a URL');
  }
  // Only the IP literals: the resolver decides where a name (even "localhost") points.
  const loopback = url.hostname === '127.0.0.1' || url.hostname === '[::1]';
  if (url.protocol === 'http:' && /^(.+\.)?localhost$/i.test(url.hostname)) {
    return bad(`relayUrl uses the name ${url.hostname} over plain http, which is not accepted as loopback: use http://127.0.0.1:<port> (or http://[::1]:<port>), or an https URL`);
  }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    return bad('relayUrl must use https (http is only accepted for the literals 127.0.0.1 and [::1])');
  }
  return { state: 'ok', relayUrl: url.toString().replace(/\/+$/, ''), token };
}

type Whoami =
  | { kind: 'ok'; scopes: string[] | null }
  | { kind: 'no-whoami' }
  | { kind: 'refused' }
  | { kind: 'status'; status: number }
  | { kind: 'unreachable'; cause: string };

function causeText(e: unknown): string {
  const err = e as Error & { cause?: { code?: string; message?: string } };
  if (err.name === 'TimeoutError' || err.name === 'AbortError') return `no answer within ${NETWORK_TIMEOUT_MS / 1000} s`;
  const inner = err.cause?.code ?? err.cause?.message;
  return printable(inner !== undefined ? `${err.message}: ${inner}` : err.message);
}

/** GET /api/whoami with the token: authenticated, cheap, no side effect. The token only goes in the Authorization header. */
async function whoami(relayUrl: string, token: string): Promise<Whoami> {
  let res: Response;
  try {
    res = await fetch(`${relayUrl}/api/whoami`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      // A redirect would carry the token to another host.
      redirect: 'error',
      signal: AbortSignal.timeout(NETWORK_TIMEOUT_MS),
    });
    const text = await res.text();
    if (res.status === 401) return { kind: 'refused' };
    if (res.status === 404) return { kind: 'no-whoami' };
    if (res.status !== 200) return { kind: 'status', status: res.status };
    if (text.length > MAX_BYTES) return { kind: 'status', status: res.status };
    const scopes = asObject(JSON.parse(text))?.['scopes'];
    if (scopes === null) return { kind: 'ok', scopes: null };
    if (Array.isArray(scopes) && scopes.every((s) => typeof s === 'string')) return { kind: 'ok', scopes: scopes.map((s) => printable(s as string)) };
    return { kind: 'status', status: res.status };
  } catch (e) {
    return { kind: 'unreachable', cause: causeText(e) };
  }
}

/** One call per relay and token, even when relay.json and relay-admin.json hold the same token (after `machine setup`). */
function memoWhoami(): (relayUrl: string, token: string) => Promise<Whoami> {
  const cache = new Map<string, Promise<Whoami>>();
  return (relayUrl, token) => {
    const key = `${relayUrl}\n${token}`;
    let hit = cache.get(key);
    if (hit === undefined) {
      hit = whoami(relayUrl, token);
      cache.set(key, hit);
    }
    return hit;
  };
}

const originOf = (relayUrl: string): string => new URL(relayUrl).origin;

async function checkRelay(configDir: string, ask: (u: string, t: string) => Promise<Whoami>, env: NodeJS.ProcessEnv): Promise<HealthCheck> {
  const name = 'relay';
  const file = join(configDir, SECRETS_DIRNAME, 'relay.json');
  const cfg = readTokenFile(file, 'run `machine join <code>` again with a new code from the admin');
  if (cfg.state === 'absent') return pass(name, 'not joined to a relay (no relay.json): informational, run `machine join <code>` to join');
  if (cfg.state === 'bad') return fail(name, cfg.detail as string);
  const insecure = insecureTlsProblem(env);
  if (insecure !== undefined) {
    return fail(name, `no request sent to the relay: ${insecure}`);
  }
  const origin = originOf(cfg.relayUrl as string);
  const w = await ask(cfg.relayUrl as string, cfg.token as string);
  switch (w.kind) {
    case 'unreachable': return pass(name, `relay unreachable: ${w.cause} (${origin}); an update of the module cannot fix the relay`);
    case 'refused': return pass(name, `relay reachable at ${origin} but it refused the machine token (invalid or revoked): run \`machine join <code>\` again with a new code; an update cannot fix it`);
    case 'status': return pass(name, `relay reachable at ${origin} but it answered ${w.status} to /api/whoami (unexpected)`);
    default: return pass(name, `relay reachable at ${origin}`);
  }
}

async function checkAdminToken(configDir: string, ask: (u: string, t: string) => Promise<Whoami>, env: NodeJS.ProcessEnv): Promise<HealthCheck> {
  const name = 'admin-token';
  const file = join(configDir, SECRETS_DIRNAME, 'relay-admin.json');
  const cfg = readTokenFile(file, 'run `machine admin login` again (confirm the request in the relay console)');
  if (cfg.state === 'absent') return pass(name, 'no admin token (no relay-admin.json): informational, `machine admin login` is needed to approve machines');
  if (cfg.state === 'bad') return fail(name, cfg.detail as string);
  const insecure = insecureTlsProblem(env);
  if (insecure !== undefined) {
    return fail(name, `no request sent to the relay: ${insecure}`);
  }
  const w = await ask(cfg.relayUrl as string, cfg.token as string);
  switch (w.kind) {
    case 'ok': return pass(name, w.scopes === null ? 'admin token present, scopes: full access' : `admin token present, scopes: ${w.scopes.join(', ') || '(none)'}`);
    case 'no-whoami': return pass(name, 'admin token present, scopes unknown (the relay has no /api/whoami)');
    case 'refused': return pass(name, 'admin token present but the relay refused it (invalid or revoked): run `machine admin login --force`; an update cannot fix it');
    case 'status': return pass(name, `admin token present, scopes unknown (the relay answered ${w.status} to /api/whoami)`);
    default: return pass(name, `admin token present, scopes not verified: relay unreachable: ${w.cause}`);
  }
}

async function checkDaemon(configDir: string): Promise<HealthCheck> {
  const name = 'daemon';
  try {
    const answer = callDaemon(configDir, 'status', NETWORK_TIMEOUT_MS);
    const status = asObject(await answer);
    const machineName = typeof status?.['name'] === 'string' ? ` as "${printable(status['name'])}"` : '';
    return pass(name, `the local daemon answers${machineName}`);
  } catch (e) {
    // Information only: the daemon is a separate process that an update of the module neither starts nor stops.
    return pass(name, printable((e as Error).message));
  }
}

async function guarded(name: string, run: () => HealthCheck | Promise<HealthCheck>): Promise<HealthCheck> {
  try {
    return await run();
  } catch (e) {
    return fail(name, `the check itself failed unexpectedly (${printable((e as Error).message)}): this is a bug of the machine module`);
  }
}

export async function runHealth(configDir: string, env: NodeJS.ProcessEnv = process.env): Promise<HealthAnswer> {
  const ask = memoWhoami();
  const checks = await Promise.all([
    guarded('config-dir', () => checkConfigDir(configDir)),
    guarded('identity', () => checkIdentity(configDir)),
    guarded('config-files', () => checkConfigFiles(configDir)),
    guarded('relay', () => checkRelay(configDir, ask, env)),
    guarded('admin-token', () => checkAdminToken(configDir, ask, env)),
    guarded('daemon', () => checkDaemon(configDir)),
  ]);
  return { ok: checks.every((c) => c.ok), checks };
}
