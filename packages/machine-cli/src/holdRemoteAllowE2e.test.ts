import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startMachineDaemon, type RunningDaemon } from './daemonEntry.js';
import { startFakeRelay, type FakeRelay } from './fakeRelay.js';
import type { InboxTimer } from './inboxLoop.js';
import { cli, fakeTiming, ok } from './testing.js';

// The admin machine allows, from ITS side, a command that a peer HOLDS (`machine run` waits there): the signed policy goes through the relay
// inbox, the daemon of the target installs it, and the held command runs at once (hold-for-approval.md, "Remote view").

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

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'machine-hold-remote-'));
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

/** The admin machine "desktop" and a second machine "laptop", both enrolled through the fake relay (as adminAllow.test.ts). */
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
}

describe('allowing from the admin machine a command that the target holds', () => {
  it('the held `machine run` of the admin machine runs once the target installed the policy that `machine admin allow` signed', async () => {
    await twoMachines();
    daemon = await startMachineDaemon(b, { port: 0, version: 'e2e', peerPort: 0, peerHost: '127.0.0.1', advertise: [], inbox: { timer: idleTimer }, log: () => undefined });
    const address = `127.0.0.1:${daemon.peerPort}`;
    const pending = cli(a, ['run', 'laptop', '--address', address, '--shell', SHELL, '--wait', '30s', '--json', '--', 'echo', 'allowed-from-admin'], undefined, { allowLoopbackPeers: true, waitProgressMs: 100 });

    // The admin machine sees what its own run waits for, on the target.
    let listed = await cli(a, ['requests', 'laptop', '--address', address], async () => passphrase);
    for (let i = 0; i < 100 && !/WAITING NOW/.test(listed.out); i++) {
      await new Promise((resolve) => setTimeout(resolve, 30));
      listed = await cli(a, ['requests', 'laptop', '--address', address], async () => passphrase);
    }
    expect(listed.out).toContain(`  allow: machine admin allow laptop --shell ${SHELL} -- "echo allowed-from-admin"`);

    // The command printed above, as typed: it signs and puts the policy in the relay inbox of the target.
    const allowed = await cli(a, ['admin', 'allow', 'laptop', '--shell', SHELL, '--', 'echo allowed-from-admin'], async () => passphrase, { ask: yes });
    expect(allowed.code, allowed.err).toBe(0);
    expect(allowed.out).toMatch(/inbox/i);

    // The daemon of the target reads its inbox (one round, instead of waiting for the 60 s timer), installs the policy; the hold polls every second.
    await daemon.inbox?.runOnce();
    const started = Date.now();
    const r = await pending;
    expect(r.code, r.err).toBe(0);
    expect((JSON.parse(r.out) as { stdout: string }).stdout).toContain('allowed-from-admin');
    // Within the poll interval of the hold (1 s) plus the scheduling of the test machine, far below the 30 s wait.
    expect(Date.now() - started).toBeLessThan(10_000);
  });
});
