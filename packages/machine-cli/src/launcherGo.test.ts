import { execFile, spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// The Go launcher of machine (ci/): the template logic is tested with `go test` on the rendered template, the real exe is
// built ONCE (host platform only) and run against the real bundle and against a stub bundle that echoes its argv.
// Offline by design: GOPROXY=off makes a missing Go module an error instead of a download. The Linux and macOS binaries are
// not built here (the build script does it in CI) and never executed.

const run = promisify(execFile);
const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ciDir = join(packageDir, 'ci');
const bundleScript = join(packageDir, 'scripts', 'bundle.mjs');
const buildScript = join(ciDir, 'scripts', 'build-launcher.sh');

const HOST_PLATFORMS: Record<string, string> = { 'win32-x64': 'machine.exe', 'darwin-arm64': 'machine', 'linux-x64': 'machine' };
const hostPlatform = `${process.platform}-${process.arch}`;
const goEnv = { ...process.env, GOPROXY: 'off', GOWORK: 'off', GOFLAGS: '' };

let root: string;
let bundle: string;
let stub: string;
let exe: string;

function kitGoLauncherDir(): string {
  let dir = packageDir;
  for (;;) {
    const candidate = join(dir, 'node_modules', '@wadeck-app', 'singleton-daemon-kit', 'go-launcher');
    if (existsSync(join(candidate, 'build.sh'))) return candidate;
    const parent = dirname(dir);
    if (parent === dir) throw new Error(`@wadeck-app/singleton-daemon-kit/go-launcher not found above ${packageDir}: run npm ci`);
    dir = parent;
  }
}

/** The same substitutions as the SDK's build.sh does on the template (AppName, DefaultConfigDir, NodeScript and the three range blocks). */
function renderTemplate(): string {
  const config = JSON.parse(readFileSync(join(ciDir, 'launcher.config.json'), 'utf8')) as { appName: string; nodeScript: string; defaultConfigDir: string; cliFlags: string[]; silentFlags?: string[]; updateCmd?: string[] };
  const lines = (items: string[]): string => items.map(f => `\t\t\t"${f}",`).join('\n');
  let tmpl = readFileSync(join(ciDir, 'launcher-main.go.tmpl'), 'utf8');
  tmpl = tmpl.replace(/\{\{\.AppName\}\}/g, config.appName).replace(/\{\{\.DefaultConfigDir\}\}/g, config.defaultConfigDir).replace(/\{\{\.NodeScript\}\}/g, config.nodeScript);
  tmpl = tmpl.replace(/\{\{range \.CLIFlags\}\}.*?\{\{end\}\}/s, lines(config.cliFlags) + '\n');
  tmpl = tmpl.replace(/\{\{range \.SilentFlags\}\}.*?\{\{end\}\}/s, lines(config.silentFlags ?? []) + '\n');
  tmpl = tmpl.replace(/\{\{range \.UpdateCmd\}\}.*?\{\{end\}\}/s, lines(config.updateCmd ?? []) + '\n');
  return tmpl;
}

interface Result {
  code: number | null;
  stdout: string;
  stderr: string;
}

function launch(file: string, args: string[], options: { env?: NodeJS.ProcessEnv; input?: string } = {}): Promise<Result> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(file, args, { env: options.env ?? process.env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', d => (stdout += d));
    child.stderr.on('data', d => (stderr += d));
    child.on('error', reject);
    child.on('close', code => resolvePromise({ code, stdout, stderr }));
    child.stdin.end(options.input ?? '');
  });
}

/** The environment without any node on the PATH (case-insensitive key on Windows). */
function envWithoutNode(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(env)) if (key.toLowerCase() === 'path') delete env[key];
  env.PATH = join(root, 'empty-path');
  return env;
}

beforeAll(async () => {
  if (HOST_PLATFORMS[hostPlatform] === undefined) throw new Error(`no launcher exists for the host ${hostPlatform}: supported are ${Object.keys(HOST_PLATFORMS).join(', ')}`);
  root = mkdtempSync(join(tmpdir(), 'machine-launcher-'));
  mkdirSync(join(root, 'empty-path'));

  // The real bundle, built from the sources into the temp folder (never over dist/machine.cjs the user installed from).
  bundle = join(root, 'bundle', 'machine.cjs');
  const bundleEnv = { ...process.env };
  delete bundleEnv.BUNDLE_VERSION;
  await run(process.execPath, [bundleScript, '--out', bundle], { windowsHide: true, timeout: 90_000, env: bundleEnv });

  // The stub bundle: argv as JSON, optional exit code and stdin echo through the environment (so that argv stays exactly what the test sends).
  stub = join(root, 'stub', 'stub.cjs');
  mkdirSync(dirname(stub));
  writeFileSync(
    stub,
    [
      "const out = { argv: process.argv.slice(2), configDirEnv: process.env.MACHINE_CONFIG_DIR ?? null };",
      "const finish = () => { process.stdout.write(JSON.stringify(out)); process.exit(Number(process.env.STUB_EXIT ?? 0)); };",
      "if (process.env.STUB_ECHO_STDIN === '1') { let s = ''; process.stdin.setEncoding('utf8'); process.stdin.on('data', d => (s += d)); process.stdin.on('end', () => { out.stdin = s; finish(); }); } else finish();",
      '',
    ].join('\n'),
  );

  // The launcher, once, for the host platform.
  const out = join(root, 'launcher');
  await run('bash', [buildScript.replace(/\\/g, '/'), '--platforms', hostPlatform, '--out', out.replace(/\\/g, '/')], { windowsHide: true, timeout: 280_000, env: goEnv });
  exe = join(out, hostPlatform, HOST_PLATFORMS[hostPlatform] as string);
  if (!existsSync(exe)) throw new Error(`the build script did not produce ${exe}`);
}, 300_000);

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('the template logic (go test on the rendered template)', () => {
  it('passes: config dir resolution, node missing message, arguments untouched', async () => {
    const goDir = join(root, 'gotest');
    mkdirSync(goDir);
    const kit = kitGoLauncherDir();
    writeFileSync(join(goDir, 'main.go'), renderTemplate());
    copyFileSync(join(ciDir, 'launcher-main_test.go'), join(goDir, 'launcher-main_test.go'));
    copyFileSync(join(kit, 'go.sum'), join(goDir, 'go.sum'));
    writeFileSync(
      join(goDir, 'go.mod'),
      ['module consumer', '', 'go 1.25.0', '', 'require wadeck.ch/singleton-daemon-kit/go-launcher v0.0.0', '', 'require golang.org/x/sys v0.47.0 // indirect', '', `replace wadeck.ch/singleton-daemon-kit/go-launcher => ${kit.replace(/\\/g, '/')}`, ''].join('\n'),
    );
    try {
      await run('go', ['test', '-C', goDir, './...'], { windowsHide: true, timeout: 200_000, env: goEnv });
    } catch (e) {
      const err = e as { stdout?: string; stderr?: string; message: string };
      throw new Error(`go test failed:\n${err.stdout ?? ''}\n${err.stderr ?? ''}\n${err.message}`);
    }
  }, 220_000);
});

describe('the built launcher against the real bundle', () => {
  const env = (): NodeJS.ProcessEnv => ({ ...process.env, LAUNCHER_BUNDLE_OVERRIDE: bundle });

  it('--help: same stdout and exit code as node, no launcher noise on stderr', async () => {
    const direct = await launch(process.execPath, [bundle, '--help']);
    const viaLauncher = await launch(exe, ['--help'], { env: env() });
    expect(viaLauncher.code).toBe(0);
    expect(viaLauncher.stdout).toBe(direct.stdout);
    expect(viaLauncher.stdout).toContain('Usage: machine <command> [options]');
    expect(viaLauncher.stderr).toBe('');
  });

  it('status --config-dir <tmp>: same stdout and exit code as node (1, no identity), the CLI message reaches stderr, the launcher logs under the given dir', async () => {
    const dir = join(root, 'cfg-flag');
    const direct = await launch(process.execPath, [bundle, 'status', '--config-dir', dir]);
    const viaLauncher = await launch(exe, ['status', '--config-dir', dir], { env: env() });
    expect(direct.code).toBe(1);
    expect(viaLauncher.code).toBe(1);
    expect(viaLauncher.stdout).toBe(direct.stdout);
    expect(viaLauncher.stderr).toContain('[fail] this machine has no identity yet: run `machine setup <relay>`');
    expect(readdirSync(join(dir, 'logs')).some(f => f.endsWith('-launcher.log'))).toBe(true);
  });

  it('run x -- a: the exit code of the command (255 here) goes through', async () => {
    const dir = join(root, 'cfg-run');
    const viaLauncher = await launch(exe, ['run', 'x', '--config-dir', dir, '--', 'a'], { env: env() });
    expect(viaLauncher.code).toBe(255);
  });

  it('MACHINE_CONFIG_DIR is the folder of the launcher logs when no flag is given', async () => {
    const dir = join(root, 'cfg-env');
    const viaLauncher = await launch(exe, ['status'], { env: { ...env(), MACHINE_CONFIG_DIR: dir } });
    expect(viaLauncher.code).toBe(1);
    expect(readdirSync(join(dir, 'logs')).some(f => f.endsWith('-launcher.log'))).toBe(true);
  });

  it('the flag wins over MACHINE_CONFIG_DIR', async () => {
    const flagDir = join(root, 'cfg-flag-wins');
    const envDir = join(root, 'cfg-env-loses');
    await launch(exe, ['status', '--config-dir', flagDir], { env: { ...env(), MACHINE_CONFIG_DIR: envDir } });
    expect(existsSync(join(flagDir, 'logs'))).toBe(true);
    expect(existsSync(envDir)).toBe(false);
  });

  it('without flag nor env the default is $XDG_CONFIG_HOME/machine', async () => {
    const xdg = join(root, 'xdg');
    const home = join(root, 'home');
    mkdirSync(home);
    const clean = env();
    delete clean.MACHINE_CONFIG_DIR;
    await launch(exe, ['status'], { env: { ...clean, XDG_CONFIG_HOME: xdg, HOME: home, USERPROFILE: home } });
    expect(existsSync(join(xdg, 'machine', 'logs'))).toBe(true);
  });
});

describe('the built launcher against a stub bundle (argument fidelity, stdio, exit code)', () => {
  const env = (extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({ ...process.env, LAUNCHER_BUNDLE_OVERRIDE: stub, MACHINE_CONFIG_DIR: join(root, 'cfg-stub'), ...extra });
  const parse = (r: Result): { argv: string[]; configDirEnv: string | null; stdin?: string } => JSON.parse(r.stdout);

  it('machine run x -- a "b c": every argument arrives as typed, in order', async () => {
    const args = ['run', 'x', '--', 'a', 'b c'];
    const r = await launch(exe, args, { env: env() });
    expect(r.code).toBe(0);
    expect(parse(r).argv).toEqual(args);
  });

  it('awkward arguments survive: quotes, spaces, empty, trailing backslash, shell characters, --config-dir after --, a leading absolute path', async () => {
    const args = [
      '/abs/path-first',
      '--config-dir',
      join(root, 'cfg with space'),
      'run',
      'peer',
      '--',
      'say "hi"',
      '',
      'back\\slash',
      'trailing\\',
      'C:\\Program Files\\x y\\',
      'a&b|c>d',
      '%PATH%',
      "it's",
      '--config-dir',
      '/remote',
      '-h',
      '--',
    ];
    const r = await launch(exe, args, { env: env() });
    expect(r.code).toBe(0);
    expect(parse(r).argv).toEqual(args);
  });

  it('stdin reaches the bundle (prompts and pipes) and stdout comes back', async () => {
    const r = await launch(exe, ['x'], { env: env({ STUB_ECHO_STDIN: '1' }), input: 'secret-line\n' });
    expect(r.code).toBe(0);
    expect(parse(r).stdin).toBe('secret-line\n');
  });

  it('the exit code of the bundle is the exit code of the launcher', async () => {
    expect((await launch(exe, ['x'], { env: env({ STUB_EXIT: '7' }) })).code).toBe(7);
    expect((await launch(exe, ['x'], { env: env({ STUB_EXIT: '255' }) })).code).toBe(255);
  });

  it('the launcher does not rewrite the environment of the bundle', async () => {
    const r = await launch(exe, ['x'], { env: env() });
    expect(parse(r).configDirEnv).toBe(join(root, 'cfg-stub'));
  });
});

describe('node missing from PATH', () => {
  it('exits 1 with the cause, the Node >= 22 requirement and the fix, on stderr and in the launcher log', async () => {
    const dir = join(root, 'cfg-no-node');
    const r = await launch(exe, ['daemon', '--config-dir', dir], { env: { ...envWithoutNode(), LAUNCHER_BUNDLE_OVERRIDE: stub } });
    expect(r.code).toBe(1);
    for (const text of ['machine: cannot start', '`node` was not found in PATH', 'Node.js 22 or newer', 'https://nodejs.org', 'PATH of the process that starts machine']) {
      expect(r.stderr).toContain(text);
    }
    const logFile = readdirSync(join(dir, 'logs')).find(f => f.endsWith('-launcher.log'));
    expect(logFile).toBeDefined();
    expect(readFileSync(join(dir, 'logs', logFile as string), 'utf8')).toContain('Node.js 22 or newer');
  });
});
