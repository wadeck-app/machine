import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  APP_CORE_MODULE_ID,
  findAppModuleManifest,
  getAppCoreConfigDir,
  pruneStagedModules,
  registerOnStart,
  stageAppModule,
} from './appCoreRegistration.js';

// Temp dirs only: nothing here touches the real app-core config dir.

let root: string;
let servers: http.Server[];

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'machine-appcore-'));
  servers = [];
});

afterEach(async () => {
  for (const server of servers) {
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
  fs.rmSync(root, { recursive: true, force: true });
});

function writeModule(dir: string, content = '{"id":"machine"}'): string {
  fs.mkdirSync(path.join(dir, 'views'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'manifest.json'), content);
  fs.writeFileSync(path.join(dir, 'views', 'a.json'), '{}');
  return dir;
}

/** A package root holding an installed app-module/. */
function installedPackage(): string {
  const packageRoot = path.join(root, 'node_modules', 'machine');
  writeModule(path.join(packageRoot, 'app-module'));
  return packageRoot;
}

async function freePort(): Promise<number> {
  const server = http.createServer();
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>(resolve => server.close(() => resolve()));
  return port;
}

/** A fake app-core answering every POST with `status` and `body`. */
async function fakeAppCore(status: number, body: unknown): Promise<{ port: number; requests: string[] }> {
  const requests: string[] = [];
  const server = http.createServer((req, res) => {
    requests.push(`${req.method} ${req.url}`);
    res.statusCode = status;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(body));
  });
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return { port: (server.address() as AddressInfo).port, requests };
}

interface Setup {
  packageRoot: string;
  machineConfigDir: string;
  appCoreConfigDir: string;
  logs: string[];
  options: Parameters<typeof registerOnStart>[0];
}

async function setup(port?: number): Promise<Setup> {
  const packageRoot = installedPackage();
  const machineConfigDir = path.join(root, 'machine-config');
  const appCoreConfigDir = path.join(root, 'app-core-config');
  fs.mkdirSync(appCoreConfigDir, { recursive: true });
  const logs: string[] = [];
  return {
    packageRoot,
    machineConfigDir,
    appCoreConfigDir,
    logs,
    options: {
      packageRoot,
      machineConfigDir,
      moduleStamp: '2026.11.14-001',
      appCoreConfigDir,
      env: { APP_CORE_PORT: String(port ?? (await freePort())) },
      log: (message: string) => logs.push(message),
    },
  };
}

describe('getAppCoreConfigDir', () => {
  it('honours APP_CORE_CONFIG_DIR', () => {
    expect(getAppCoreConfigDir({ APP_CORE_CONFIG_DIR: '/x/y' })).toBe('/x/y');
  });

  it('defaults to ~/.config/app-core', () => {
    expect(getAppCoreConfigDir({})).toBe(path.join(os.homedir(), '.config', 'app-core'));
  });
});

describe('findAppModuleManifest', () => {
  it('prefers the installed app-module over the sibling checkout', () => {
    const packageRoot = path.join(root, 'pkg', 'machine-cli');
    writeModule(path.join(packageRoot, 'app-module'));
    writeModule(path.join(packageRoot, '..', 'app-module-machine', 'dist-module'));
    expect(findAppModuleManifest(packageRoot)).toBe(path.join(packageRoot, 'app-module', 'manifest.json'));
  });

  it('falls back to the dist-module of the sibling package', () => {
    const packageRoot = path.join(root, 'pkg', 'machine-cli');
    fs.mkdirSync(packageRoot, { recursive: true });
    writeModule(path.join(packageRoot, '..', 'app-module-machine', 'dist-module'));
    expect(findAppModuleManifest(packageRoot)).toBe(path.join(packageRoot, '..', 'app-module-machine', 'dist-module', 'manifest.json'));
  });

  it('never takes the sibling source manifest', () => {
    const packageRoot = path.join(root, 'pkg', 'machine-cli');
    fs.mkdirSync(packageRoot, { recursive: true });
    writeModule(path.join(packageRoot, '..', 'app-module-machine'));
    expect(findAppModuleManifest(packageRoot)).toBeUndefined();
  });
});

describe('stageAppModule', () => {
  it('copies the module to <machineConfigDir>/app-module/<stamp>/ and returns its manifest', () => {
    const source = writeModule(path.join(root, 'src-module'));
    const manifest = stageAppModule(source, path.join(root, 'cfg'), '1.0.0');
    expect(manifest).toBe(path.join(root, 'cfg', 'app-module', '1.0.0', 'manifest.json'));
    expect(fs.existsSync(path.join(root, 'cfg', 'app-module', '1.0.0', 'views', 'a.json'))).toBe(true);
    expect(fs.existsSync(path.join(root, 'cfg', 'app-module', '1.0.0.partial'))).toBe(false);
  });

  it('stages once per stamp: a complete copy is kept as is', () => {
    const source = writeModule(path.join(root, 'src-module'), '{"v":1}');
    stageAppModule(source, path.join(root, 'cfg'), '1.0.0');
    fs.writeFileSync(path.join(source, 'manifest.json'), '{"v":2}');
    const manifest = stageAppModule(source, path.join(root, 'cfg'), '1.0.0');
    expect(fs.readFileSync(manifest, 'utf8')).toBe('{"v":1}');
  });

  it('replaces a target without manifest (crash residue) and leaves no partial copy of its own behind', () => {
    const source = writeModule(path.join(root, 'src-module'));
    const target = path.join(root, 'cfg', 'app-module', '1.0.0');
    fs.mkdirSync(target, { recursive: true });
    fs.writeFileSync(path.join(target, 'half.txt'), 'x');
    const manifest = stageAppModule(source, path.join(root, 'cfg'), '1.0.0');
    expect(fs.existsSync(manifest)).toBe(true);
    expect(fs.existsSync(path.join(target, 'half.txt'))).toBe(false);
    expect(fs.readdirSync(path.join(root, 'cfg', 'app-module'))).toEqual(['1.0.0']);
  });

  it('does not touch the partial copy of a concurrent staging (each one writes its own)', () => {
    const source = writeModule(path.join(root, 'src-module'));
    const stagedRoot = path.join(root, 'cfg', 'app-module');
    const foreignPartial = path.join(stagedRoot, '1.0.0.4242-aaaa.partial');
    fs.mkdirSync(foreignPartial, { recursive: true });
    fs.writeFileSync(path.join(foreignPartial, 'manifest.json'), 'theirs');
    stageAppModule(source, path.join(root, 'cfg'), '1.0.0');
    expect(fs.readFileSync(path.join(foreignPartial, 'manifest.json'), 'utf8')).toBe('theirs');
  });

  it('refuses a module that holds a symbolic link (a copy would keep it and point out of the module), naming it', () => {
    const source = writeModule(path.join(root, 'src-module'));
    const outside = path.join(root, 'outside');
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, 'secret.txt'), 's');
    // A junction needs no privilege on Windows; it is a symbolic link for lstat.
    fs.symlinkSync(outside, path.join(source, 'views', 'link'), 'junction');
    expect(() => stageAppModule(source, path.join(root, 'cfg'), '1.0.0')).toThrow(/link is a symbolic link/);
    expect(fs.existsSync(path.join(root, 'cfg', 'app-module', '1.0.0'))).toBe(false);
  });

  it.each(['', '..', '../x', 'a/b', 'a\\b', '.hidden', 'a b'])('refuses the stamp %j, naming it', stamp => {
    const source = writeModule(path.join(root, 'src-module'));
    expect(() => stageAppModule(source, path.join(root, 'cfg'), stamp)).toThrow(/not a usable version stamp/);
    expect(fs.existsSync(path.join(root, 'cfg'))).toBe(false);
  });

  it('refuses a source without manifest.json, naming the folder', () => {
    const source = path.join(root, 'empty');
    fs.mkdirSync(source);
    expect(() => stageAppModule(source, path.join(root, 'cfg'), '1.0.0')).toThrow(/no manifest\.json in .*empty/);
  });
});

describe('pruneStagedModules', () => {
  it('removes every staged version but the kept one and counts them', () => {
    const source = writeModule(path.join(root, 'src-module'));
    for (const stamp of ['1.0.0', '1.1.0', '1.2.0']) stageAppModule(source, path.join(root, 'cfg'), stamp);
    expect(pruneStagedModules(path.join(root, 'cfg'), '1.2.0')).toBe(2);
    expect(fs.readdirSync(path.join(root, 'cfg', 'app-module'))).toEqual(['1.2.0']);
  });

  it('removes only the folders named like a stamp: a foreign file or a folder of another kind stays', () => {
    const source = writeModule(path.join(root, 'src-module'));
    stageAppModule(source, path.join(root, 'cfg'), '1.0.0');
    const stagedRoot = path.join(root, 'cfg', 'app-module');
    fs.writeFileSync(path.join(stagedRoot, 'notes.txt'), 'x');
    fs.writeFileSync(path.join(stagedRoot, '0.9.0'), 'a file named like a stamp');
    fs.mkdirSync(path.join(stagedRoot, 'my folder'));
    expect(pruneStagedModules(path.join(root, 'cfg'), '2.0.0')).toBe(1);
    expect(fs.readdirSync(stagedRoot).sort()).toEqual(['0.9.0', 'my folder', 'notes.txt']);
  });

  it('keeps a recent partial copy (a concurrent staging) and removes an old one (crash residue)', () => {
    const stagedRoot = path.join(root, 'cfg', 'app-module');
    const recent = path.join(stagedRoot, '1.0.0.1-aaaa.partial');
    const old = path.join(stagedRoot, '0.9.0.2-bbbb.partial');
    fs.mkdirSync(recent, { recursive: true });
    fs.mkdirSync(old, { recursive: true });
    const longAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
    fs.utimesSync(old, longAgo, longAgo);
    expect(pruneStagedModules(path.join(root, 'cfg'), '2.0.0')).toBe(1);
    expect(fs.readdirSync(stagedRoot)).toEqual(['1.0.0.1-aaaa.partial']);
  });

  it('returns 0 when nothing was ever staged', () => {
    expect(pruneStagedModules(path.join(root, 'cfg'), '1.0.0')).toBe(0);
  });
});

describe('registerOnStart', () => {
  it('uses the module id "machine"', () => {
    expect(APP_CORE_MODULE_ID).toBe('machine');
  });

  it('does nothing, and says so, when the app-core config dir does not exist (no copy, no network)', async () => {
    const s = await setup();
    fs.rmSync(s.appCoreConfigDir, { recursive: true });
    await registerOnStart(s.options);
    expect(s.logs).toHaveLength(1);
    expect(s.logs[0]).toContain('app-core is not installed');
    expect(fs.existsSync(s.machineConfigDir)).toBe(false);
  });

  it('logs where it looked, and how to fix, when no app-module is found', async () => {
    const s = await setup();
    fs.rmSync(path.join(s.packageRoot, 'app-module'), { recursive: true });
    await registerOnStart(s.options);
    expect(s.logs).toHaveLength(1);
    expect(s.logs[0]).toContain('no app-module found');
    expect(s.logs[0]).toContain(path.join('app-module', 'manifest.json'));
    expect(s.logs[0]).toContain('app-module-machine');
  });

  it('stages the installed module, defers when app-core is not running, and the pickup file points at the copy', async () => {
    const s = await setup();
    await registerOnStart(s.options);
    const staged = path.join(s.machineConfigDir, 'app-module', '2026.11.14-001', 'manifest.json');
    expect(fs.existsSync(staged)).toBe(true);
    const pickup = JSON.parse(fs.readFileSync(path.join(s.appCoreConfigDir, 'modules', 'machine.json'), 'utf8')) as { id: string; source: { path: string } };
    expect(pickup.id).toBe('machine');
    expect(pickup.source.path).toBe(staged);
    expect(s.logs).toHaveLength(1);
  });

  it('registers on a running app-core and prunes the older copies', async () => {
    const appCore = await fakeAppCore(200, { ok: true });
    const s = await setup(appCore.port);
    const source = writeModule(path.join(root, 'old'));
    stageAppModule(source, s.machineConfigDir, '2026.11.01-001');
    await registerOnStart(s.options);
    expect(appCore.requests).toHaveLength(1);
    expect(appCore.requests[0]).toMatch(/^POST .*register/);
    expect(fs.readdirSync(path.join(s.machineConfigDir, 'app-module'))).toEqual(['2026.11.14-001']);
  });

  it('prunes after a deferred registration too', async () => {
    const s = await setup();
    const source = writeModule(path.join(root, 'old'));
    stageAppModule(source, s.machineConfigDir, '2026.11.01-001');
    await registerOnStart(s.options);
    expect(fs.readdirSync(path.join(s.machineConfigDir, 'app-module'))).toEqual(['2026.11.14-001']);
  });

  it('keeps the old copy when app-core refuses, and logs the refusal', async () => {
    const appCore = await fakeAppCore(400, { error: 'manifest has no version', retained: true });
    const s = await setup(appCore.port);
    const source = writeModule(path.join(root, 'old'));
    stageAppModule(source, s.machineConfigDir, '2026.11.01-001');
    await registerOnStart(s.options);
    expect(fs.readdirSync(path.join(s.machineConfigDir, 'app-module')).sort()).toEqual(['2026.11.01-001', '2026.11.14-001']);
    expect(s.logs).toHaveLength(1);
    expect(s.logs[0]).toContain('refused');
    expect(s.logs[0]).toContain('manifest has no version');
  });

  it('never rejects: a bad stamp is a log line naming the cause', async () => {
    const s = await setup();
    await expect(registerOnStart({ ...s.options, moduleStamp: '../evil' })).resolves.toBeUndefined();
    expect(s.logs).toHaveLength(1);
    expect(s.logs[0]).toContain('not a usable version stamp');
    expect(fs.existsSync(path.join(root, 'evil'))).toBe(false);
  });

  it('never rejects: an installed module without machineConfigDir or moduleStamp is a log line', async () => {
    const s = await setup();
    const { machineConfigDir: _a, moduleStamp: _b, ...rest } = s.options;
    await expect(registerOnStart(rest)).resolves.toBeUndefined();
    expect(s.logs).toHaveLength(1);
    expect(s.logs[0]).toContain('machineConfigDir or moduleStamp');
  });

  it('never rejects: a malformed APP_CORE_PORT is a log line', async () => {
    const s = await setup();
    await expect(registerOnStart({ ...s.options, env: { APP_CORE_PORT: 'abc' } })).resolves.toBeUndefined();
    expect(s.logs).toHaveLength(1);
  });

  it('registers a sibling dist-module in place, without copying it', async () => {
    const s = await setup();
    fs.rmSync(path.join(s.packageRoot, 'app-module'), { recursive: true });
    const sibling = path.join(s.packageRoot, '..', 'app-module-machine', 'dist-module');
    writeModule(sibling);
    await registerOnStart({ ...s.options, machineConfigDir: undefined, moduleStamp: undefined });
    expect(fs.existsSync(s.machineConfigDir)).toBe(false);
    const pickup = JSON.parse(fs.readFileSync(path.join(s.appCoreConfigDir, 'modules', 'machine.json'), 'utf8')) as { source: { path: string } };
    expect(pickup.source.path).toBe(path.resolve(sibling, 'manifest.json'));
  });
});
