import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startMachineDaemon } from './daemonEntry.js';
import type { InboxTimer } from './inboxLoop.js';
import { cli, provision } from './testing.js';

// Decision 70, both sides of a `no-policy` refusal, through real daemons: B has no policy installed although A signed one a moment ago
// (what the user saw: `machine admin allow` succeeded, `machine run` right after was refused).

const SHELL = process.platform === 'win32' ? 'cmd' : 'sh';
const idleTimer: InboxTimer = { set: () => 0, clear: () => undefined };
let root: string;
let a: string;
let b: string;
const stoppers: Array<() => Promise<void>> = [];

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'machine-nopolicy-'));
  a = join(root, 'a');
  b = join(root, 'b');
  await provision(root, a, b, []);
  // The policy signed on A is "in transit": B never installed it.
  rmSync(join(b, 'policy.json'));
  rmSync(join(b, 'policy-state.json'), { force: true });
});
afterEach(async () => {
  while (stoppers.length > 0) await stoppers.pop()?.();
  rmSync(root, { recursive: true, force: true });
});

describe('machine run refused with no-policy', () => {
  it('the target says what happened and what to do; the caller adds the policy signed here', async () => {
    const daemon = await startMachineDaemon(b, { port: 0, version: 'e2e', peerPort: 0, peerHost: '127.0.0.1', advertise: [], inbox: { timer: idleTimer }, log: () => undefined });
    stoppers.push(daemon.stop);
    const run = await cli(a, ['run', 'laptop', '--address', `127.0.0.1:${daemon.peerPort}`, '--shell', SHELL, '--', 'echo', 'hi'], undefined, { allowLoopbackPeers: true });
    expect(run.code).toBe(255);
    expect(run.err).toContain('refused by laptop: no-policy: no policy is installed on this machine yet. If the admin just ran `machine admin allow laptop`');
    expect(run.err).toContain('retry shortly');
    expect(run.err).toContain('`machine admin allow laptop -- <command>` on the admin machine');
    expect(run.err).not.toContain('sign-policy');
    expect(run.err).toMatch(/a policy \(version 1\) for laptop was signed here (just now|\d+ s ago) and sent through the relay: it is not installed yet; retry in about \d+ s/);
  });
});
