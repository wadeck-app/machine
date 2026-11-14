import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startMachineDaemon } from './daemonEntry.js';
import { readMachine } from './identity.js';
import { cli, ok, provision, type PolicyDraftEntry } from './testing.js';

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

/** Provision both machines, then start B's daemon on loopback. */
async function setUp(policyCommands: PolicyDraftEntry[]) {
  await provision(root, a, b, policyCommands);
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
