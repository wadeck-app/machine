import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDaemonClient } from '@wadeck-app/singleton-daemon-kit';
import { makeCommands } from './commands.js';
import { startMachineDaemon, type RunningDaemon } from './daemonEntry.js';
import { startFakeRelay, type FakeRelay } from './fakeRelay.js';
import type { InboxTimer } from './inboxLoop.js';
import { cli, fakeTiming, ok } from './testing.js';

// The `reachability` answer of the daemon and what `machine list` and `machine status` say about it (decision 86): real daemon on the target,
// the pinned address of the peer decides whether it is reachable directly.

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
let target: RunningDaemon | undefined;
let admin: RunningDaemon | undefined;

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'machine-reach-'));
  a = join(root, 'a');
  b = join(root, 'b');
  mkdirSync(a);
  mkdirSync(b);
  relay = await startFakeRelay({ code: MACHINE_CODE, moreCodes: [SECOND_CODE], adminCode: ADMIN_CODE });
});
afterEach(async () => {
  await target?.stop();
  await admin?.stop();
  target = undefined;
  admin = undefined;
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
}

const daemonOf = (dir: string) => startMachineDaemon(dir, { port: 0, version: 'e2e', peerPort: 0, peerHost: '127.0.0.1', advertise: [], inbox: { timer: idleTimer }, log: () => undefined });

describe('reachability of the trusted machines', () => {
  it('in-process (no daemon): `machine list --json` probes once and says direct for a machine that answers, with the words of the pages', async () => {
    await twoMachines();
    target = await daemonOf(b);
    await ok(a, ['peer', 'connect', 'laptop', '--address', `127.0.0.1:${target.peerPort}`]);
    const r = await cli(a, ['list'], undefined, { allowLoopbackPeers: true });
    expect(r.code, r.err).toBe(0);
    expect(r.out).toMatch(/laptop \([0-9a-f-]+\)[\s\S]*reachable: direct now \(\d+ ms, checked 0 s ago\)/);
    const json = JSON.parse((await ok(a, ['list', '--json'])).out) as { peers: Array<{ name: string; reachable?: { state: string; text: string } }> };
    expect(json.peers.find((p) => p.name === 'laptop')?.reachable).toMatchObject({ state: 'direct', text: expect.stringMatching(/^direct now \(/) });
  });

  it('a machine that does not answer is not reachable directly, with the relay inbox as the only way, and the cause is in the JSON', async () => {
    await twoMachines();
    await ok(a, ['peer', 'connect', 'laptop', '--address', '127.0.0.1:1']);
    const r = await cli(a, ['list']);
    expect(r.out).toMatch(/reachable: not reachable directly \((never seen directly|last seen [^;]+); relay inbox only\)/);
    const json = JSON.parse((await ok(a, ['list', '--json'])).out) as { peers: Array<{ name: string; reachable?: { state: string; cause?: string } }> };
    const laptop = json.peers.find((p) => p.name === 'laptop')?.reachable;
    expect(laptop?.state).toBe('not-direct');
    expect(laptop?.cause).toBeTruthy();
  });

  it('the daemon command answers from memory at once (unknown first), then with the probe result', async () => {
    await twoMachines();
    target = await daemonOf(b);
    await ok(a, ['peer', 'connect', 'laptop', '--address', `127.0.0.1:${target.peerPort}`]);
    admin = await daemonOf(a);
    const client = createDaemonClient({ configDir: a, commands: makeCommands(a, 'e2e') });
    const callDaemonForTest = async (_dir: string, command: string) => (await (client as unknown as { send(c: string): Promise<unknown> }).send(command)) as { machines: Array<{ name: string; state: string; text?: string }> };
    const first = await callDaemonForTest(a, 'reachability');
    expect(first.machines[0]).toMatchObject({ name: 'laptop', state: 'unknown' });
    let later = first;
    for (let i = 0; i < 100 && later.machines[0]?.state === 'unknown'; i++) {
      await new Promise((resolve) => setTimeout(resolve, 30));
      later = await callDaemonForTest(a, 'reachability');
    }
    expect(later.machines[0]).toMatchObject({ name: 'laptop', state: 'direct', text: expect.stringMatching(/^direct now \(/) });
    // `machine status` says the same thing, from the memory of the daemon (it asks no network itself).
    const status = await cli(a, ['status']);
    expect(status.out).toMatch(/^reachable: laptop: direct now \(\d+ ms, checked \d+ s ago\)$/m);
  });
});
