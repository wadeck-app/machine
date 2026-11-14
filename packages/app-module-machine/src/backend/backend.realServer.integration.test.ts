import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { candidacyCode, generateSigningKeyPair, newCandidacyRandom } from '@wadeck-app/machine-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeTempDir, removeTempDir } from './tempDir.testUtil.js';

/**
 * Packages the module with `app-core-cli package` and serves the result through a REAL app-core server (`app-core-cli dev`
 * boots app-core's own server), then calls the routes over HTTP. backend.test.ts calls the handlers directly, so it cannot see
 * whether the packaged bundle loads and runs, nor how the router passes the request. The daemon and the relay are small fake
 * HTTP servers of this test; nothing real is contacted and the real ~/.config is never read (MACHINE_CONFIG_DIR, XDG_CONFIG_HOME).
 *
 * The app-core-cli used: MACHINE_TEST_APP_CORE_CLI_ENTRY (path of a dist/cli.bundle.js, e.g. the global install), else the
 * `@wadeck-app/app-core-cli` devDependency of this package. Neither found: the test FAILS and says so (no silent skip).
 */

const packageDir = join(dirname(fileURLToPath(import.meta.url)), '../..');
// Guards against a child that HANGS, never performance limits.
const SERVER_START_TIMEOUT_MS = 300_000;
const PACKAGE_TIMEOUT_MS = 300_000;
const DAEMON_TOKEN = 'integration-daemon-token';
const ADMIN_TOKEN = 'integration-admin-token';
const UUID = '0b8a7a52-7f0d-4f0e-8a56-2f0d3a1c9e11';

function findCliEntry(): string {
  const fromEnv = process.env['MACHINE_TEST_APP_CORE_CLI_ENTRY'];
  if (fromEnv !== undefined && fromEnv.length > 0) {
    if (!existsSync(fromEnv)) throw new Error(`MACHINE_TEST_APP_CORE_CLI_ENTRY points to ${fromEnv}, which does not exist: give the path of a dist/cli.bundle.js`);
    return fromEnv;
  }
  try {
    const manifest = createRequire(import.meta.url).resolve('@wadeck-app/app-core-cli/package.json');
    return join(dirname(manifest), 'dist/cli.bundle.js');
  } catch {
    throw new Error(
      'No app-core-cli for the real-server test: the @wadeck-app/app-core-cli devDependency of packages/app-module-machine is not installed. ' +
      'Install it (npm install, from the repository root) or set MACHINE_TEST_APP_CORE_CLI_ENTRY to the dist/cli.bundle.js of a global app-core-cli (npm root -g, then @wadeck-app/app-core-cli/dist/cli.bundle.js).',
    );
  }
}

let cliEntry: string;
let child: ChildProcess | undefined;
let workDir: string;
let configDir: string;
let baseUrl: string;
let fakes: Server[] = [];
let candidate: { identityPublicKey: string; random: string };
let builtModuleDir: string;

/** Every app-core-cli run schedules a DETACHED background updater next to its bundle: a folder without an updater next to it means none is started. */
function noUpdaterEnv(): NodeJS.ProcessEnv {
  return { LAUNCHER_BUNDLE_OVERRIDE: join(workDir, 'no-updater', 'cli.bundle.js') };
}

async function listen(handler: (url: string, auth: string | undefined) => { status: number; body: unknown }): Promise<number> {
  const server = createServer((req, res) => {
    const out = handler(req.url ?? '', req.headers.authorization);
    res.writeHead(out.status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(out.body));
  });
  fakes.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no port');
  return address.port;
}

function packageModule(out: string): void {
  try {
    execFileSync(process.execPath, [cliEntry, 'package', packageDir, '--out', out, '--version', '0.0.0-test-real-server'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: PACKAGE_TIMEOUT_MS, windowsHide: true,
      env: { ...process.env, XDG_CONFIG_HOME: join(workDir, 'xdg'), ...noUpdaterEnv() },
    });
  } catch (err) {
    const failure = err as { stdout?: string; stderr?: string };
    throw new Error(`app-core-cli package failed:\n${failure.stdout ?? ''}${failure.stderr ?? ''}`);
  }
}

function startServer(builtModule: string): Promise<string> {
  return new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(
      () => reject(new Error(`app-core-cli dev did not print its URL within ${SERVER_START_TIMEOUT_MS} ms (hung?). Output so far:\n${output}`)),
      SERVER_START_TIMEOUT_MS,
    );
    // node + the CLI file, no shell: child.kill() reaches the real server process
    child = spawn(process.execPath, [cliEntry, 'dev', builtModule], {
      windowsHide: true,
      // Port 0: a free port, never the developer's real app-core. MACHINE_CONFIG_DIR: the fixture config of this test.
      env: { ...process.env, APP_CORE_PORT: '0', MACHINE_CONFIG_DIR: configDir, XDG_CONFIG_HOME: join(workDir, 'xdg'), ...noUpdaterEnv() },
    });
    const onData = (chunk: Buffer): void => {
      output += chunk.toString();
      const match = /app-core-cli dev: (http:\/\/127\.0\.0\.1:\d+)/.exec(output);
      if (match) {
        clearTimeout(timer);
        resolve(match[1] as string);
      }
    };
    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`app-core-cli dev exited early (code ${code}). Output:\n${output}`));
    });
  });
}

async function call(path: string): Promise<{ status: number; body: any }> {
  const response = await fetch(`${baseUrl}/api/modules/machine${path}`);
  return { status: response.status, body: await response.json() };
}

describe('the packaged module through a real app-core server', () => {
  beforeAll(async () => {
    cliEntry = findCliEntry();
    workDir = makeTempDir('app-module-machine-real-server-');
    configDir = join(workDir, 'machine-config');
    mkdirSync(join(configDir, '_secrets_'), { recursive: true });
    const keys = generateSigningKeyPair();
    candidate = { identityPublicKey: keys.publicKey, random: newCandidacyRandom() };

    const daemonPort = await listen((url, auth) => {
      if (auth !== `Bearer ${DAEMON_TOKEN}`) return { status: 401, body: { error: 'Unauthorized' } };
      if (url === '/status') return { status: 200, body: { result: { initialized: true, uuid: UUID, name: 'alpha', version: '1', enrolled: true, peers: 1, problems: [], configDir } } };
      if (url === '/list') return { status: 200, body: { result: { initialized: true, enrolled: true, self: { uuid: UUID, name: 'alpha' }, peers: [{ uuid: '11111111-1111-4111-8111-111111111111', name: 'beta', aliases: ['b'] }] } } };
      return { status: 404, body: { error: 'Unknown command' } };
    });
    writeFileSync(join(configDir, 'daemon.port.json'), JSON.stringify({ pid: process.pid, port: daemonPort, peerPort: 1 }));
    writeFileSync(join(configDir, 'health_token'), DAEMON_TOKEN);

    const nowSeconds = Math.floor(Date.now() / 1000);
    const relayPort = await listen((url, auth) => {
      if (url !== '/api/machines/candidacies') return { status: 404, body: { error: 'not_found' } };
      if (auth !== `Bearer ${ADMIN_TOKEN}`) return { status: 401, body: { error: 'invalid_token' } };
      // The relay also sends a code of its own, wrong on purpose: the module must show the recomputed one.
      return { status: 200, body: { candidacies: [{ id: 'cand-1', name: 'laptop', hostname: 'LAPTOP-01', ...candidate, code: 'AAAA-BBBB-CCCC-DDDD', uuid: UUID, observedIp: '203.0.113.7', createdAt: nowSeconds - 10, expiresAt: nowSeconds + 800, uuidBound: true, boundToCandidateToken: false, boundTokenLabel: 'old laptop' }] } };
    });
    writeFileSync(join(configDir, '_secrets_', 'relay-admin.json'), JSON.stringify({ relayUrl: `http://127.0.0.1:${relayPort}`, token: ADMIN_TOKEN, label: 'console', claimedAt: '2026-11-14T00:00:00.000Z' }));

    const builtModule = join(workDir, 'module');
    builtModuleDir = builtModule;
    packageModule(builtModule);
    baseUrl = await startServer(builtModule);
  });

  afterAll(async () => {
    // Wait for the server to be gone: on Windows it still holds its files for a moment after kill(), and the removal below then fails with EPERM
    if (child && child.exitCode === null) {
      const exited = new Promise<void>((resolve) => child?.once('exit', () => resolve()));
      child.kill();
      await exited;
    }
    await Promise.all(fakes.map((s) => new Promise<void>((resolve) => s.close(() => resolve()))));
    fakes = [];
    if (workDir !== undefined) removeTempDir(workDir);
  });

  it('the package carries the dsl-lib with the machine components and the Candidacies page uses the timeline', () => {
    const entries = join(builtModuleDir, 'dsl-lib', 'entries.mjs');
    expect(existsSync(entries), `${entries} is missing: the module was packaged without its dsl-lib (check src/dsl-components/index.ts)`).toBe(true);
    const lib = readFileSync(entries, 'utf8');
    for (const name of ['VerticalTimeline', 'PassphraseSigner', 'FinalCodeDisplay']) expect(lib).toContain(name);
    expect(existsSync(join(builtModuleDir, 'dsl-lib', 'style.css'))).toBe(true);
    expect(readFileSync(join(builtModuleDir, 'dsl-frontend', 'candidacies.json'), 'utf8')).toContain('machine:VerticalTimeline');
  });

  it('GET /status answers the status of the (fake) daemon through the packaged bundle', async () => {
    const { status, body } = await call('/status');
    expect(status).toBe(200);
    expect(body).toMatchObject({ initialized: true, name: 'alpha', peers: 1 });
  });

  it('GET /machines answers the rows of the page', async () => {
    const { status, body } = await call('/machines');
    expect(status).toBe(200);
    expect(body.machines.map((m: { name: string }) => m.name)).toEqual(['alpha', 'beta']);
    expect(body.count).toBe(2);
  });

  it('GET /candidacies answers the recomputed code, the binding warning, the count, and never the token or the relay code', async () => {
    const { status, body } = await call('/candidacies');
    expect(status).toBe(200);
    expect(body.count).toBe(1);
    const row = body.candidacies[0];
    expect(row.code).toBe(candidacyCode(candidate.identityPublicKey, candidate.random));
    expect(row.uuidBound).toBe(true);
    expect(row.bindingText).toContain('old laptop');
    const text = JSON.stringify(body);
    expect(text).not.toContain(ADMIN_TOKEN);
    expect(text).not.toContain('AAAA-BBBB-CCCC-DDDD');
  });

  it('GET /status answers 503 with an actionable error when the daemon port file disappears (read at each request)', async () => {
    rmSync(join(configDir, 'daemon.port.json'));
    const { status, body } = await call('/status');
    expect(status).toBe(503);
    expect(body.kind).toBe('daemon_unreachable');
    expect(body.error).toContain('machine daemon');
  });
});
