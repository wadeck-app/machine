import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startMachineDaemon } from './daemonEntry.js';
import { cli, provision } from './testing.js';

// The admin machine ("desktop", A) lists the requests refused by a peer ("laptop", B) over the real peer channel, on loopback.

const SHELL = process.platform === 'win32' ? 'cmd' : 'sh';

let root: string;
let a: string;
let b: string;
let passphrase: string;
let address: string;
const stoppers: Array<() => Promise<void>> = [];

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'machine-requests-e2e-'));
  a = join(root, 'a');
  b = join(root, 'b');
  passphrase = await provision(root, a, b, [{ shell: SHELL, command: 'echo allowed' }]);
  const daemon = await startMachineDaemon(b, { port: 0, version: 'e2e', peerPort: 0, peerHost: '127.0.0.1' });
  stoppers.push(daemon.stop);
  address = `127.0.0.1:${daemon.peerPort}`;
});
afterEach(async () => {
  while (stoppers.length > 0) await stoppers.pop()?.();
  rmSync(root, { recursive: true, force: true });
});

const refuseOnce = (command: string[]) => cli(a, ['run', 'laptop', '--no-wait', '--address', address, '--shell', SHELL, '--', ...command]);
const prompt = async () => passphrase;

describe('machine requests <machine> (the admin machine asks a peer)', () => {
  it('shows the pending requests of the peer with the exact command to allow them', async () => {
    await refuseOnce(['echo', 'something']);
    await refuseOnce(['echo', 'something']);
    const r = await cli(a, ['requests', 'laptop', '--address', address], prompt);
    // stderr holds only what is signed, said before the passphrase: no warning, no failure.
    expect(r.err).toMatch(/^Signing a read-only request to list the pending requests of laptop/);
    expect(r.err).not.toMatch(/\[(warn|fail)\]/);
    expect(r.code).toBe(0);
    expect(r.out).toContain(`desktop -> ${SHELL} "echo something"  2 times`);
    expect(r.out).toContain(`machine admin allow laptop --shell ${SHELL} -- "echo something"`);
    expect(r.out).toMatch(/pending requests of laptop|waiting for approval on laptop/);
  });

  it('is audited on the target as one event, without the commands', async () => {
    await refuseOnce(['echo', 'something']);
    await cli(a, ['requests', 'laptop', '--address', address], prompt);
    const events = readFileSync(join(b, 'audit.log'), 'utf8').trim().split('\n').map((l) => (JSON.parse(l) as { entry: Record<string, unknown> }).entry);
    const listed = events.filter((e) => e['event'] === 'requests-list');
    expect(listed).toHaveLength(1);
    expect(JSON.stringify(listed[0])).not.toContain('something');
  });

  it('asks the admin passphrase and refuses a wrong one before any connection', async () => {
    const r = await cli(a, ['requests', 'laptop', '--address', address], async () => 'wrong passphrase');
    expect(r.code).not.toBe(0);
    expect(r.err).toMatch(/passphrase/i);
    const log = (() => {
      try {
        return readFileSync(join(b, 'audit.log'), 'utf8');
      } catch {
        return '';
      }
    })();
    expect(log).not.toContain('requests-list');
  });

  it('fails with the fix on a machine that does not hold the admin key', async () => {
    const r = await cli(b, ['requests', 'desktop', '--address', '127.0.0.1:1'], prompt);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/admin key/);
    expect(r.err).toMatch(/admin machine/);
  });

  it('says what is not supported remotely instead of ignoring it', async () => {
    const r = await cli(a, ['requests', 'laptop', '--history'], prompt);
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/--history/);
    expect(r.err).toMatch(/on that machine/);
  });

  it('--json gives one document per machine', async () => {
    await refuseOnce(['echo', 'something']);
    const r = await cli(a, ['requests', 'laptop', '--address', address, '--json'], prompt);
    const doc = JSON.parse(r.out) as { machines: Array<{ name: string; ok: boolean; answer: { pending: Array<{ command: string }> } }> };
    expect(doc.machines[0]).toMatchObject({ name: 'laptop', ok: true });
    expect(doc.machines[0]?.answer.pending[0]?.command).toBe('echo something');
  });

  it('--all asks every peer and reports the one that cannot be reached, without stopping', async () => {
    await refuseOnce(['echo', 'something']);
    // The only peer has no known address without --address; --all uses the relay record or pinned addresses: none here, so it is reported.
    const r = await cli(a, ['requests', '--all'], prompt);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/laptop/);
    expect(r.err).toMatch(/--address|address/);
  });

  it('a peer without any pending request says so', async () => {
    const r = await cli(a, ['requests', 'laptop', '--address', address], prompt);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/no request waiting for approval on laptop/);
  });
});
