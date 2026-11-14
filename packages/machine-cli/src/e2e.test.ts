import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runCli } from './cli.js';
import { startMachineDaemon } from './daemonEntry.js';
import { readMachine } from './identity.js';

// Two machines, driven only through the command line, as the user will do it before the relay exists:
// A is the admin machine ("desktop"), B receives commands ("laptop"). Everything runs on loopback.

const SHELL = process.platform === 'win32' ? 'cmd' : 'sh';

let root: string;
let a: string;
let b: string;
const stoppers: Array<() => Promise<void>> = [];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'machine-e2e-'));
  a = join(root, 'a');
  b = join(root, 'b');
});
afterEach(async () => {
  while (stoppers.length > 0) await stoppers.pop()?.();
  rmSync(root, { recursive: true, force: true });
});

async function cli(configDir: string, args: string[], prompt?: () => Promise<string>) {
  let out = '';
  let err = '';
  // Everything after "--" is the remote command: options must come before it.
  const split = args.indexOf('--');
  const argv = split === -1 ? [...args, '--config-dir', configDir] : [...args.slice(0, split), '--config-dir', configDir, ...args.slice(split)];
  const code = await runCli(argv, { stdout: (t) => (out += t), stderr: (t) => (err += t), ...(prompt ? { prompt } : {}) }, {});
  return { code, out, err };
}

async function ok(configDir: string, args: string[], prompt?: () => Promise<string>) {
  const r = await cli(configDir, args, prompt);
  if (r.code !== 0) throw new Error(`machine ${args.join(' ')} failed (${r.code}): ${r.err}`);
  return r;
}

/** Everything the admin does and the two machines do, up to "B is ready to receive commands from A". */
async function setUp(policyCommands: Array<{ shell: string; command: string; limits?: { maxCalls: number } }>) {
  await ok(a, ['init', '--name', 'desktop']);
  await ok(b, ['init', '--name', 'laptop']);
  const init = await ok(a, ['admin', 'init']);
  const passphrase = /passphrase[^\n]*\n\s*([A-Z0-9 -]{20,})/i.exec(init.err)?.[1]?.trim() ?? '';
  const prompt = async () => passphrase;

  await ok(a, ['peer', 'info', '--out', join(root, 'a-info.json')]);
  await ok(b, ['peer', 'info', '--out', join(root, 'b-info.json')]);
  // One pair secret for the pair: the second registration reuses the first bundle's secret.
  await ok(a, ['admin', 'register', join(root, 'b-info.json'), '--out', join(root, 'for-a.json')], prompt);
  await ok(a, ['admin', 'register', join(root, 'a-info.json'), '--secret-from', join(root, 'for-a.json'), '--out', join(root, 'for-b.json')], prompt);
  await ok(a, ['peer', 'import', join(root, 'for-a.json')]);
  await ok(b, ['admin', 'pin', join(a, 'admin.json')]);
  await ok(b, ['peer', 'import', join(root, 'for-b.json')]);

  const target = readMachine(b).uuid;
  writeFileSync(join(root, 'draft.json'), JSON.stringify({ v: 1, target, version: 1, baseVersion: 0, defaults: policyCommands, peers: {} }));
  await ok(a, ['admin', 'sign-policy', join(root, 'draft.json'), '--out', join(root, 'policy-b.json')], prompt);
  await ok(b, ['policy', 'install', join(root, 'policy-b.json')]);

  const daemon = await startMachineDaemon(b, { port: 0, version: 'e2e', peerPort: 0, peerHost: '127.0.0.1' });
  stoppers.push(daemon.stop);
  return { address: `127.0.0.1:${daemon.peerPort}` };
}

describe('two machines through the command line', () => {
  it('runs an allowed command on the peer and returns its output', async () => {
    const { address } = await setUp([{ shell: SHELL, command: 'echo hello from laptop' }]);
    const r = await cli(a, ['run', 'laptop', '--address', address, '--shell', SHELL, '--', 'echo', 'hello', 'from', 'laptop']);
    expect(r.err).toBe('');
    expect(r.code).toBe(0);
    expect(r.out.trim()).toBe('hello from laptop');
  });

  it('refuses a command the policy does not list, exits 255 and says why', async () => {
    const { address } = await setUp([{ shell: SHELL, command: 'echo allowed' }]);
    const r = await cli(a, ['run', 'laptop', '--address', address, '--shell', SHELL, '--', 'echo', 'something', 'else']);
    expect(r.code).toBe(255);
    expect(r.err).toMatch(/refused.*not-listed|not-listed.*refused/s);
    expect(r.out).toBe('');
  });

  it('propagates the exit code of the remote command', async () => {
    const command = 'exit 7';
    const { address } = await setUp([{ shell: SHELL, command }]);
    const r = await cli(a, ['run', 'laptop', '--address', address, '--shell', SHELL, '--', 'exit', '7']);
    expect(r.code).toBe(7);
  });

  it('stops at the call limit of an entry', async () => {
    const { address } = await setUp([{ shell: SHELL, command: 'echo once', limits: { maxCalls: 1 } }]);
    const first = await cli(a, ['run', 'laptop', '--address', address, '--shell', SHELL, '--', 'echo', 'once']);
    expect(first.code).toBe(0);
    const second = await cli(a, ['run', 'laptop', '--address', address, '--shell', SHELL, '--', 'echo', 'once']);
    expect(second.code).toBe(255);
    expect(second.err).toMatch(/exhausted/);
  });

  it('writes an audit log on the target that verifies and shows who ran what', async () => {
    const { address } = await setUp([{ shell: SHELL, command: 'echo audited' }]);
    await ok(a, ['run', 'laptop', '--address', address, '--shell', SHELL, '--', 'echo', 'audited']);
    const lines = readFileSync(join(b, 'audit.log'), 'utf8').trim().split('\n');
    expect(lines.map((l) => (JSON.parse(l) as { entry: { event: string } }).entry.event)).toEqual(['accepted', 'completed']);
    expect(lines[0]).toContain(readMachine(a).uuid);
  });

  it('cannot run on a machine it has no address for, and says how to give one', async () => {
    await setUp([{ shell: SHELL, command: 'echo hello' }]);
    const r = await cli(a, ['run', 'laptop', '--shell', SHELL, '--', 'echo', 'hello']);
    expect(r.code).toBe(255);
    expect(r.err).toMatch(/--address/);
  });

  it('cannot run on an unknown machine (exit 255)', async () => {
    await setUp([{ shell: SHELL, command: 'echo hello' }]);
    const r = await cli(a, ['run', 'nas', '--address', '127.0.0.1:1', '--shell', SHELL, '--', 'echo', 'hello']);
    expect(r.code).toBe(255);
    expect(r.err).toMatch(/unknown machine "nas"/);
  });

  it('status shows the peers, the policy and what was left out', async () => {
    await setUp([{ shell: SHELL, command: 'echo hello' }]);
    const status = await ok(a, ['status', '--json']);
    const parsed = JSON.parse(status.out) as { enrolled: boolean; peers: number; problems: string[] };
    expect(parsed).toMatchObject({ enrolled: true, peers: 1 });
    expect(parsed.problems).toEqual([]);
    const list = await ok(a, ['list']);
    expect(list.out).toContain('laptop');
  });
});
