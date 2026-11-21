import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SignedDocument } from '@wadeck-app/machine-core';
import { startMachineDaemon, type RunningDaemon } from './daemonEntry.js';
import { startFakeRelay, type FakeRelay } from './fakeRelay.js';
import type { InboxTimer } from './inboxLoop.js';
import { cli, fakeTiming, ok } from './testing.js';

// Direct delivery first (decision 86), end to end: the admin machine runs `machine admin allow`, the daemon of the target takes the signed document over
// the mutual-TLS channel, installs it and releases the request it holds, all without the relay inbox. When the target is not reachable, the same command
// stores the document in the inbox and says why.

const SHELL = process.platform === 'win32' ? 'cmd' : 'sh';
const MACHINE_CODE = '12345678';
const SECOND_CODE = '22223333';
const ADMIN_CODE = '87654321';
const yes = async () => 'y';
const idleTimer: InboxTimer = { set: () => 0, clear: () => undefined };

let root: string;
let a: string;
let b: string;
let relay: FakeRelay;
let passphrase: string;
let daemon: RunningDaemon | undefined;

let uuidOf: (dir: string) => string;
const inboxPolicies = (dir: string) => relay.inbox(uuidOf(dir)).filter((d) => (d.document as unknown as SignedDocument).body.kind === 'policy');

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'machine-direct-e2e-'));
  a = join(root, 'a');
  b = join(root, 'b');
  mkdirSync(a);
  mkdirSync(b);
  relay = await startFakeRelay({ code: MACHINE_CODE, moreCodes: [SECOND_CODE], adminCode: ADMIN_CODE });
});
afterEach(async () => {
  await daemon?.stop();
  daemon = undefined;
  await relay.close();
  rmSync(root, { recursive: true, force: true });
});

async function twoMachines(): Promise<void> {
  await ok(a, ['init', '--name', 'desktop']);
  const init = await ok(a, ['admin', 'init', '--generate']);
  passphrase = /passphrase[^\n]*\n\s*([A-Z0-9 -]{20,})/i.exec(init.err)?.[1]?.trim() ?? '';
  await ok(a, ['admin', 'login', ADMIN_CODE, '--full-access', '--relay', relay.url]);
  const first = await cli(a, ['join', MACHINE_CODE, '--relay', relay.url], async () => passphrase, { timing: fakeTiming(), ask: async () => 'n' });
  expect(first.code, first.err).toBe(0);
  await ok(b, ['init', '--name', 'laptop']);
  await ok(b, ['join', SECOND_CODE, '--relay', relay.url, '--no-wait']);
  const approved = await cli(a, ['admin', 'approve', '--relay', relay.url], async () => passphrase, { ask: yes });
  expect(approved.code, approved.err).toBe(0);
  const joined = await cli(b, ['join', '--resume'], undefined, { timing: fakeTiming(), ask: yes });
  expect(joined.code, joined.err).toBe(0);
  const { readMachine } = await import('./identity.js');
  uuidOf = (dir) => readMachine(dir).uuid;
}

describe('direct delivery first, end to end', () => {
  it('the target takes the signed policy over the peer channel, releases the held run at once, and the relay inbox never holds the policy', async () => {
    await twoMachines();
    daemon = await startMachineDaemon(b, { port: 0, version: 'e2e', peerPort: 0, peerHost: '127.0.0.1', advertise: [], inbox: { timer: idleTimer }, log: () => undefined });
    const address = `127.0.0.1:${daemon.peerPort}`;
    await ok(a, ['peer', 'connect', 'laptop', '--address', address]);
    const pending = cli(a, ['run', 'laptop', '--address', address, '--shell', SHELL, '--wait', '30s', '--json', '--', 'echo', 'direct-ok'], undefined, { allowLoopbackPeers: true, waitProgressMs: 100 });
    let listed = await cli(a, ['requests', 'laptop', '--address', address], async () => passphrase);
    for (let i = 0; i < 100 && !/WAITING NOW/.test(listed.out); i++) {
      await new Promise((resolve) => setTimeout(resolve, 30));
      listed = await cli(a, ['requests', 'laptop', '--address', address], async () => passphrase);
    }
    expect(listed.out).toMatch(/WAITING NOW/);

    const allowed = await cli(a, ['admin', 'allow', 'laptop', '--shell', SHELL, '--', 'echo direct-ok'], async () => passphrase, { ask: yes });
    expect(allowed.code, allowed.err).toBe(0);
    expect(allowed.out).toMatch(/Delivered directly to laptop \(installed, \d+\.\d s\)/);
    expect(allowed.out).toMatch(/is in force on "laptop" now/);
    expect(allowed.out).not.toMatch(/not reachable directly|within about a minute/);
    expect(inboxPolicies(b)).toHaveLength(0);

    // No inbox round was run: the held request was released by the direct delivery alone (the hold is woken at once).
    const r = await pending;
    expect(r.code, r.err).toBe(0);
    expect((JSON.parse(r.out) as { stdout: string }).stdout).toContain('direct-ok');
  });

  it('a target that is not reachable: the same command stores the policy in the inbox, says why, and the inbox path still installs it', async () => {
    await twoMachines();
    daemon = await startMachineDaemon(b, { port: 0, version: 'e2e', peerPort: 0, peerHost: '127.0.0.1', advertise: [], inbox: { timer: idleTimer }, log: () => undefined });
    // A pinned address where nothing listens: the connection is refused at once.
    await ok(a, ['peer', 'connect', 'laptop', '--address', '127.0.0.1:1']);
    const allowed = await cli(a, ['admin', 'allow', 'laptop', '--shell', SHELL, '--', 'echo via-inbox'], async () => passphrase, { ask: yes });
    expect(allowed.code, allowed.err).toBe(0);
    expect(allowed.out).toMatch(/laptop is not reachable directly: stored in the relay inbox, it installs it when it comes back \(next poll within 60 s, or 5 s while it holds a request\)\. Cause: /);
    expect(allowed.out).toMatch(/is in the relay inbox of "laptop"/);
    expect(inboxPolicies(b)).toHaveLength(1);

    // What the daemon of the target does at its next round: the very same code installs it.
    await daemon.inbox?.runOnce();
    expect(inboxPolicies(b)).toHaveLength(0);
    const status = JSON.parse((await ok(b, ['status', '--json'])).out) as { policyVersion?: number };
    expect(status.policyVersion).toBe(1);
  });
});
