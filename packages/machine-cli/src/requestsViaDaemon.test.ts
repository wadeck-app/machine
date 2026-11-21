import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { newRequestsList, signRequestsList } from '@wadeck-app/machine-core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeCommands } from './commands.js';
import { startMachineDaemon } from './daemonEntry.js';
import { readMachine } from './identity.js';
import { unlockAdminKey } from './admin.js';
import { cli, provision } from './testing.js';

// The module backend asks ITS daemon to forward a request that the browser signed with the admin key (decision 74). Here the "browser" is
// the admin code of the CLI: it unlocks the same key file and signs the same document.

const SHELL = process.platform === 'win32' ? 'cmd' : 'sh';

let root: string;
let a: string;
let b: string;
let passphrase: string;
let address: string;
const stoppers: Array<() => Promise<void>> = [];

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'machine-reqvia-'));
  a = join(root, 'a');
  b = join(root, 'b');
  passphrase = await provision(root, a, b, [{ shell: SHELL, command: 'echo allowed' }]);
  const daemon = await startMachineDaemon(b, { port: 0, version: 'e2e', peerPort: 0, peerHost: '127.0.0.1' });
  stoppers.push(daemon.stop);
  address = `127.0.0.1:${daemon.peerPort}`;
  await cli(a, ['peer', 'connect', 'laptop', '--address', address]);
  await cli(a, ['run', 'laptop', '--no-wait', '--address', address, '--shell', SHELL, '--', 'echo', 'something']);
});
afterEach(async () => {
  while (stoppers.length > 0) await stoppers.pop()?.();
  rmSync(root, { recursive: true, force: true });
});

async function signed(over: { target?: string; source?: string } = {}) {
  const self = readMachine(a);
  const target = readMachine(b);
  const pair = await unlockAdminKey(a, async () => passphrase);
  return signRequestsList(newRequestsList({ source: over.source ?? self.uuid, target: over.target ?? target.uuid, limit: 100, now: Math.floor(Date.now() / 1000) }), pair.privateKeyPkcs8);
}

describe('remoteRequests (daemon command for the module backend)', () => {
  it('forwards a browser-signed request to the peer and returns its answer', async () => {
    const r = await makeCommands(a, 'e2e').remoteRequests({ peer: 'laptop', request: await signed() });
    expect(r).toMatchObject({ ok: true, answer: { machine: { name: 'laptop' } } });
    if (r.ok) expect(r.answer.pending.map((g) => g.command)).toEqual(['echo something']);
  });

  it('refuses a request that is not addressed to that peer, before any connection', async () => {
    const r = await makeCommands(a, 'e2e').remoteRequests({ peer: 'laptop', request: await signed({ target: readMachine(a).uuid }) });
    expect(r).toMatchObject({ ok: false, reason: 'wrong-target' });
  });

  it('refuses a request that names another source than this machine', async () => {
    const r = await makeCommands(a, 'e2e').remoteRequests({ peer: 'laptop', request: await signed({ source: readMachine(b).uuid }) });
    expect(r).toMatchObject({ ok: false, reason: 'source-mismatch' });
  });

  it('refuses an unknown peer and a payload of the wrong shape, with the cause', async () => {
    const commands = makeCommands(a, 'e2e');
    expect(await commands.remoteRequests({ peer: 'nas', request: await signed() })).toMatchObject({ ok: false, reason: 'unknown-peer' });
    expect(await commands.remoteRequests({ peer: 'laptop' })).toMatchObject({ ok: false, reason: 'bad-payload' });
    expect(await commands.remoteRequests(undefined)).toMatchObject({ ok: false, reason: 'bad-payload' });
  });

  it('relays the refusal of a peer that does not trust the signature', async () => {
    const tampered = await signed();
    tampered.body = { ...tampered.body, limit: 7 };
    const r = await makeCommands(a, 'e2e').remoteRequests({ peer: 'laptop', request: tampered });
    expect(r).toMatchObject({ ok: false, reason: 'bad-signature' });
  });

  it('reports a peer that cannot be reached with the cause', async () => {
    await cli(a, ['peer', 'connect', 'laptop', '--address', '127.0.0.1:1']);
    const r = await makeCommands(a, 'e2e').remoteRequests({ peer: 'laptop', request: await signed() });
    expect(r).toMatchObject({ ok: false, reason: 'unreachable' });
  });
});

describe('requests (daemon command for the module backend)', () => {
  it('returns the local view: pending and the last history entries', async () => {
    const answer = makeCommands(b, 'e2e').requests();
    expect(answer).toMatchObject({ initialized: true, ok: true, self: { name: 'laptop' } });
    if (answer.initialized && answer.ok) {
      expect(answer.summary.pending.map((g) => g.command)).toEqual(['echo something']);
      expect(answer.summary.history.length).toBeGreaterThan(0);
    }
  });

  it('carries the notices of other machines (visible, newest first) and, for a damaged file, an empty list plus noticesError', async () => {
    const stored = (n: number) => ({ machine: '0a1b2c3d-4e5f-4a6b-9c7d-8e9f0a1b2c3d', machineName: 'desktop', receivedAt: 1_800_000_000 - n, id: `3f1c2d3e-4a5b-4c6d-8e7f-${String(n).padStart(12, '0')}`, peer: '6f1c2d3e-4a5b-4c6d-8e7f-0a1b2c3d4e5f', peerName: 'agent-box', shell: 'sh', command: `echo ${n}`, commandTruncated: false, state: 'refused', deadline: null, ts: 1_800_000_000 - n });
    writeFileSync(join(b, 'notices.json'), JSON.stringify({ v: 1, notices: [stored(2), stored(1)] }));
    const answer = makeCommands(b, 'e2e').requests();
    if (!answer.initialized || !answer.ok) {
      throw new Error('unexpected answer');
    }
    expect(answer.notices.map((n) => n.command)).toEqual(['echo 1', 'echo 2']);
    writeFileSync(join(b, 'notices.json'), 'garbage');
    const damaged = makeCommands(b, 'e2e').requests();
    if (!damaged.initialized || !damaged.ok) {
      throw new Error('unexpected answer');
    }
    expect(damaged.notices).toEqual([]);
    expect(damaged.noticesError).toContain('notices.json');
  });
});
