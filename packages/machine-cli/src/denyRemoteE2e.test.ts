import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readAdminPin, unlockAdminKey } from './admin.js';
import { updateConnection } from './connectionsStore.js';
import { startMachineDaemon } from './daemonEntry.js';
import { readMachine } from './identity.js';
import type { InboxTimer } from './inboxLoop.js';
import { signNoticeRecipientsFor } from './noticeRecipientsStore.js';
import { cli, provision } from './testing.js';

// `machine requests <machine> --deny <id>` through two real daemons on loopback (decision 85): the admin machine A, a notice recipient of B,
// refuses a request that B holds, with no passphrase; B audits who denied; without the list B refuses with the fix.

const SHELL = process.platform === 'win32' ? 'cmd' : 'sh';
const idleTimer: InboxTimer = { set: () => 0, clear: () => undefined };

let root: string;
let a: string;
let b: string;
let passphrase: string;
let addressB: string;
const stoppers: Array<() => Promise<void>> = [];

async function startDaemon(dir: string) {
  const daemon = await startMachineDaemon(dir, { port: 0, version: 'e2e', peerPort: 0, peerHost: '127.0.0.1', advertise: [], inbox: { timer: idleTimer }, notices: { allowLocal: true }, log: () => undefined });
  stoppers.push(daemon.stop);
  return daemon;
}

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'machine-deny-e2e-'));
  a = join(root, 'a');
  b = join(root, 'b');
  passphrase = await provision(root, a, b, [{ shell: SHELL, command: 'echo listed' }]);
});
afterEach(async () => {
  while (stoppers.length > 0) await stoppers.pop()?.();
  rmSync(root, { recursive: true, force: true });
});

async function bothUp(withList: boolean): Promise<void> {
  const daemonA = await startDaemon(a);
  const daemonB = await startDaemon(b);
  addressB = `127.0.0.1:${daemonB.peerPort}`;
  updateConnection(b, readMachine(a).uuid, () => ({ type: 'direct', addresses: [{ host: '127.0.0.1', port: daemonA.peerPort }] }));
  if (withList) {
    const key = await unlockAdminKey(a, async () => passphrase);
    signNoticeRecipientsFor(b, { adminPrivateKeyPkcs8: key.privateKeyPkcs8, adminPublicKey: readAdminPin(a).adminPublicKey, selfUuid: readMachine(a).uuid, now: Math.floor(Date.now() / 1000), recipients: [readMachine(a).uuid] });
  }
}

const runWaiting = (command: string[]) => cli(a, ['run', 'laptop', '--address', addressB, '--shell', SHELL, '--wait', '30s', '--', ...command], undefined, { allowLoopbackPeers: true, waitProgressMs: 100 });

async function waitingIdAtB(): Promise<string> {
  for (let i = 0; i < 300; i++) {
    const r = await cli(b, ['requests', '--json']);
    const waiting = (JSON.parse(r.out) as { summary: { waiting: Array<{ id: string }> } }).summary.waiting;
    if (waiting.length > 0) {
      return waiting[0]!.id;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('timed out waiting for the hold on laptop');
}

describe('machine requests <machine> --deny (decision 85)', () => {
  it('a notice recipient denies a request held on another machine, without a passphrase; the caller gets denied with the reason and the target audits who denied', async () => {
    await bothUp(true);
    const pending = runWaiting(['echo', 'hello-remote-deny']);
    const id = await waitingIdAtB();
    const r = await cli(a, ['requests', 'laptop', '--address', addressB, '--deny', id.slice(0, 8), '--reason', 'not today'], undefined, { allowLoopbackPeers: true });
    expect(r.code, r.err).toBe(0);
    expect(r.out).toMatch(/denied/);
    expect(r.out).toContain('laptop');
    const caller = await pending;
    expect(caller.err).toContain('denied');
    expect(caller.err).toContain('not today');
    const audit = readFileSync(join(b, 'audit.log'), 'utf8');
    expect(audit).toContain('"event":"request-denied-remotely"');
    expect(audit).toContain('"byName":"desktop"');
  });

  it('without a notice-recipients list the target refuses and the message says how to fix it', async () => {
    await bothUp(false);
    const pending = runWaiting(['echo', 'hello-no-list']);
    const id = await waitingIdAtB();
    const r = await cli(a, ['requests', 'laptop', '--address', addressB, '--deny', id.slice(0, 8)], undefined, { allowLoopbackPeers: true });
    expect(r.code).not.toBe(0);
    expect(r.err).toMatch(/machine admin distribute laptop/);
    expect(r.err).toMatch(/machine requests --deny <id>\W+ON laptop/);
    // The request is still held: it is answered locally, then the caller returns.
    await cli(b, ['requests', '--deny', id.slice(0, 8)]);
    expect((await pending).err).toContain('denied');
  });

  it('an unreachable target is named, and the hint says the request stays held', async () => {
    await bothUp(true);
    const r = await cli(a, ['requests', 'laptop', '--address', '127.0.0.1:9', '--deny', 'abcdef12'], undefined, { allowLoopbackPeers: true });
    expect(r.code).not.toBe(0);
    expect(r.err).toMatch(/cannot reach laptop/);
    expect(r.err).toMatch(/stays held/);
  });

  it('--deny with --all or two machines is refused with the usage', async () => {
    await bothUp(true);
    expect((await cli(a, ['requests', '--all', '--deny', 'abcdef12'])).err).toMatch(/--all/);
    expect((await cli(a, ['requests', 'laptop', 'other', '--deny', 'abcdef12'])).err).toMatch(/unexpected argument "other"/);
  });
});
