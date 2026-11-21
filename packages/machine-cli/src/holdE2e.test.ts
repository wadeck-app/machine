import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startMachineDaemon } from './daemonEntry.js';
import { readMachine } from './identity.js';
import type { InboxTimer } from './inboxLoop.js';
import { cli, ok, provision } from './testing.js';

// `machine run --wait` through real daemons on loopback (hold-for-approval.md): the caller waits on A, the owner of B allows or denies.

const SHELL = process.platform === 'win32' ? 'cmd' : 'sh';
const idleTimer: InboxTimer = { set: () => 0, clear: () => undefined };

let root: string;
let a: string;
let b: string;
let passphrase: string;
let address: string;
const stoppers: Array<() => Promise<void>> = [];

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'machine-hold-e2e-'));
  a = join(root, 'a');
  b = join(root, 'b');
  passphrase = await provision(root, a, b, [{ shell: SHELL, command: 'echo listed' }]);
  const daemon = await startMachineDaemon(b, { port: 0, version: 'e2e', peerPort: 0, peerHost: '127.0.0.1', advertise: [], inbox: { timer: idleTimer }, log: () => undefined });
  stoppers.push(daemon.stop);
  address = `127.0.0.1:${daemon.peerPort}`;
});
afterEach(async () => {
  while (stoppers.length > 0) await stoppers.pop()?.();
  rmSync(root, { recursive: true, force: true });
});

const runWaiting = (wait: string, command: string[], extra: string[] = []) =>
  cli(a, ['run', 'laptop', '--address', address, '--shell', SHELL, '--wait', wait, ...extra, '--', ...command], undefined, { allowLoopbackPeers: true, waitProgressMs: 100 });

/** The id (full) of the request B lists as waiting. */
async function waitingId(): Promise<string> {
  for (let i = 0; i < 200; i++) {
    const r = await cli(b, ['requests', '--json']);
    const waiting = (JSON.parse(r.out) as { summary: { waiting: Array<{ id: string }> } }).summary.waiting;
    if (waiting.length > 0) {
      return waiting[0]!.id;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('the request was never held');
}

async function allow(command: string): Promise<void> {
  const target = readMachine(b).uuid;
  writeFileSync(join(root, 'draft2.json'), JSON.stringify({ v: 1, target, version: 2, baseVersion: 1, defaults: [{ shell: SHELL, command: 'echo listed' }, { shell: SHELL, command }], peers: {} }));
  await ok(a, ['admin', 'sign-policy', join(root, 'draft2.json'), '--out', join(root, 'policy-b2.json')], async () => passphrase);
  await ok(b, ['policy', 'install', join(root, 'policy-b2.json')]);
}

describe('machine run --wait', () => {
  it('runs the command at once when the owner allows it during the wait, and the progress goes to stderr only', async () => {
    const pending = runWaiting('10s', ['echo', 'hello-held'], ['--json']);
    await waitingId();
    // The listing the owner sees: waiting, not refused.
    const listing = await cli(b, ['requests']);
    expect(listing.out).toMatch(/waiting for your answer on laptop/);
    await allow('echo hello-held');
    const r = await pending;
    expect(r.code, r.err).toBe(0);
    // One document on stdout, whatever was printed while waiting.
    expect((JSON.parse(r.out) as { stdout: string }).stdout).toContain('hello-held');
    expect(r.err).toMatch(/waiting for laptop to allow it \(\d+ s left\)/);
    expect(r.err).not.toMatch(/\[fail\]/);
  });

  it('answers refused: denied, with the reason of the owner, when the owner denies it; Deny needs no passphrase', async () => {
    const pending = runWaiting('10s', ['echo', 'nope']);
    const id = await waitingId();
    const denied = await cli(b, ['requests', '--deny', id.slice(0, 8), '--reason', 'not today']);
    expect(denied.code, denied.err).toBe(0);
    expect(denied.out).toMatch(/denied/);
    const r = await pending;
    expect(r.code).toBe(255);
    expect(r.err).toContain('refused by laptop: denied');
    expect(r.err).toContain('not today');
    // The owner already answered: there is nothing to allow in this message.
    expect(r.err).not.toContain('To allow it');
    // The request is no longer waiting.
    const after = await cli(b, ['requests', '--json']);
    expect((JSON.parse(after.out) as { summary: { waiting: unknown[] } }).summary.waiting).toEqual([]);
  });

  it('refuses a wait outside 10 s to 60 min before any connection, naming the limits', async () => {
    const r = await runWaiting('5s', ['echo', 'x']);
    expect(r.code).toBe(255);
    expect(r.err).toMatch(/10 s to 60 min/);
    const none = await cli(b, ['requests', '--json']);
    expect((JSON.parse(none.out) as { summary: { waiting: unknown[] } }).summary.waiting).toEqual([]);
  });

  it('without --wait the refusal is immediate, as before', async () => {
    const r = await cli(a, ['run', 'laptop', '--address', address, '--shell', SHELL, '--', 'echo', 'later'], undefined, { allowLoopbackPeers: true });
    expect(r.code).toBe(255);
    expect(r.err).toContain('refused by laptop: not-listed');
  });
});
