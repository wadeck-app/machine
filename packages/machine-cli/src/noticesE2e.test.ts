import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { StoredNotice } from '@wadeck-app/machine-core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readAdminPin, unlockAdminKey } from './admin.js';
import { updateConnection } from './connectionsStore.js';
import { startMachineDaemon } from './daemonEntry.js';
import { readMachine } from './identity.js';
import type { InboxTimer } from './inboxLoop.js';
import { signNoticeRecipientsFor } from './noticeRecipientsStore.js';
import { cli, ok, provision } from './testing.js';

// Request notices through two real daemons on loopback (request-notices.md): the target B holds a request of a caller, tells the recipient A
// (the admin machine) over the direct channel, A stores it and `machine requests` shows it; the end of the hold drops it.

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
  root = mkdtempSync(join(tmpdir(), 'machine-notices-e2e-'));
  a = join(root, 'a');
  b = join(root, 'b');
  passphrase = await provision(root, a, b, [{ shell: SHELL, command: 'echo listed' }]);
});
afterEach(async () => {
  while (stoppers.length > 0) await stoppers.pop()?.();
  rmSync(root, { recursive: true, force: true });
});

/** Both daemons up, B knows where A listens and A is its notice recipient. */
async function withRecipient(): Promise<void> {
  const daemonA = await startDaemon(a);
  const daemonB = await startDaemon(b);
  addressB = `127.0.0.1:${daemonB.peerPort}`;
  updateConnection(b, readMachine(a).uuid, () => ({ type: 'direct', addresses: [{ host: '127.0.0.1', port: daemonA.peerPort }] }));
  const key = await unlockAdminKey(a, async () => passphrase);
  signNoticeRecipientsFor(b, { adminPrivateKeyPkcs8: key.privateKeyPkcs8, adminPublicKey: readAdminPin(a).adminPublicKey, selfUuid: readMachine(a).uuid, now: Math.floor(Date.now() / 1000), recipients: [readMachine(a).uuid] });
}

const runWaiting = (command: string[]) => cli(a, ['run', 'laptop', '--address', addressB, '--shell', SHELL, '--wait', '30s', '--', ...command], undefined, { allowLoopbackPeers: true, waitProgressMs: 100 });

async function noticesAt(dir: string): Promise<StoredNotice[]> {
  const r = await cli(dir, ['requests', '--json']);
  return (JSON.parse(r.out) as { notices: StoredNotice[] }).notices;
}

async function until<T>(what: string, read: () => Promise<T>, done: (v: T) => boolean): Promise<T> {
  for (let i = 0; i < 300; i++) {
    const v = await read();
    if (done(v)) {
      return v;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`timed out waiting for ${what}`);
}

async function waitingIdAtB(): Promise<string> {
  const r = await until('the hold on laptop', () => cli(b, ['requests', '--json']), (x) => (JSON.parse(x.out) as { summary: { waiting: unknown[] } }).summary.waiting.length > 0);
  return (JSON.parse(r.out) as { summary: { waiting: Array<{ id: string }> } }).summary.waiting[0]!.id;
}

describe('request notices between two daemons', () => {
  it('a held request shows on the recipient with its machine, and Deny on the target drops the notice', async () => {
    await withRecipient();
    const pending = runWaiting(['echo', 'hello-notice']);
    const id = await waitingIdAtB();
    const notices = await until('the notice at the recipient', () => noticesAt(a), (n) => n.length === 1);
    expect(notices[0]).toMatchObject({ id, machineName: 'laptop', machine: readMachine(b).uuid, peerName: 'desktop', shell: SHELL, command: 'echo hello-notice', state: 'held' });
    const text = await cli(a, ['requests']);
    expect(text.out).toMatch(/WAITING NOW/);
    expect(text.out).toMatch(/laptop +[0-9a-f]{8} +desktop/);
    expect(text.out).toContain('allow: machine admin allow laptop');
    expect(text.out).toContain('not verified live');
    // The recipient never ran or allowed anything: its own audit log has no run.
    expect(readFileSync(join(a, 'audit.log'), 'utf8')).not.toContain('"event":"accepted"');

    await cli(b, ['requests', '--deny', id.slice(0, 8), '--reason', 'not today']);
    expect((await pending).err).toContain('denied');
    await until('the notice to disappear', () => noticesAt(a), (n) => n.length === 0);
  });

  it('an Allow on the target runs the request and drops the notice', async () => {
    await withRecipient();
    const pending = runWaiting(['echo', 'hello-allowed']);
    await waitingIdAtB();
    await until('the notice', () => noticesAt(a), (n) => n.length === 1);
    const target = readMachine(b).uuid;
    writeFileSync(join(root, 'draft2.json'), JSON.stringify({ v: 1, target, version: 2, baseVersion: 1, defaults: [{ shell: SHELL, command: 'echo listed' }, { shell: SHELL, command: 'echo hello-allowed' }], peers: {} }));
    await ok(a, ['admin', 'sign-policy', join(root, 'draft2.json'), '--out', join(root, 'policy-b2.json')], async () => passphrase);
    await ok(b, ['policy', 'install', join(root, 'policy-b2.json')]);
    const r = await pending;
    expect(r.code, r.err).toBe(0);
    await until('the notice to disappear', () => noticesAt(a), (n) => n.length === 0);
  });

  it('a request refused without a wait is reported as refused and stays listed', async () => {
    await withRecipient();
    const r = await cli(a, ['run', 'laptop', '--address', addressB, '--shell', SHELL, '--no-wait', '--', 'echo', 'later'], undefined, { allowLoopbackPeers: true });
    expect(r.err).toContain('not-listed');
    const notices = await until('the refused notice', () => noticesAt(a), (n) => n.length === 1);
    expect(notices[0]).toMatchObject({ state: 'refused', deadline: null, machineName: 'laptop', command: 'echo later' });
    expect((await cli(a, ['requests'])).out).toMatch(/REFUSED/);
  });

  it('without a recipients list the target audits notice-no-recipient ONCE and the request is unaffected', async () => {
    const daemonB = await startDaemon(b);
    const address = `127.0.0.1:${daemonB.peerPort}`;
    for (const command of ['echo one', 'echo two']) {
      const r = await cli(a, ['run', 'laptop', '--address', address, '--shell', SHELL, '--no-wait', '--', ...command.split(' ')], undefined, { allowLoopbackPeers: true });
      expect(r.err).toContain('not-listed');
    }
    const lines = await until('the audit line', async () => readFileSync(join(b, 'audit.log'), 'utf8').split('\n').filter((l) => l.includes('notice-no-recipient')), (l) => l.length > 0);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('machine admin distribute laptop');
  });
});
