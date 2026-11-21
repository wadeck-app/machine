import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { newRequestsList, signNoticeRecipients, signRequestsList } from '@wadeck-app/machine-core';
import { readAdminPin, unlockAdminKey } from './admin.js';
import { startMachineDaemon } from './daemonEntry.js';
import { readMachine } from './identity.js';
import { readNoticeSent } from './noticeRecipientsSent.js';
import { installNoticeRecipients } from './noticeRecipientsStore.js';
import { remoteRequestsCommand } from './requestsViaDaemon.js';
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

describe('the answer tells which notice-recipients list the peer holds, and the admin machine records it', () => {
  const laptopUuid = () => readMachine(b).uuid;

  it('machine requests <machine>: no list on the peer is recorded as confirmed "none", then the serial once it holds one', async () => {
    const first = await cli(a, ['requests', 'laptop', '--address', address], prompt);
    expect(first.code, first.err).toBe(0);
    expect(readNoticeSent(a)[laptopUuid()]?.confirmed).toMatchObject({ serial: null });
    const key = await unlockAdminKey(a, prompt);
    const pin = readAdminPin(b);
    installNoticeRecipients(b, signNoticeRecipients({ v: 1, adminKeyId: pin.adminKeyId, serial: 777, issuedAt: 777, recipients: [readMachine(a).uuid] }, key.privateKeyPkcs8), pin.adminPublicKey);
    const second = await cli(a, ['requests', 'laptop', '--address', address], prompt);
    expect(second.code, second.err).toBe(0);
    expect(readNoticeSent(a)[laptopUuid()]?.confirmed).toMatchObject({ serial: 777 });
  });

  it('the Requests page path (the daemon forwards a request signed in the browser) records it the same way', async () => {
    const key = await unlockAdminKey(a, prompt);
    const pin = readAdminPin(b);
    installNoticeRecipients(b, signNoticeRecipients({ v: 1, adminKeyId: pin.adminKeyId, serial: 888, issuedAt: 888, recipients: [readMachine(a).uuid] }, key.privateKeyPkcs8), pin.adminPublicKey);
    await cli(a, ['peer', 'connect', 'laptop', '--address', address]);
    const now = Math.floor(Date.now() / 1000);
    const request = signRequestsList(newRequestsList({ source: readMachine(a).uuid, target: laptopUuid(), limit: 10, now }), key.privateKeyPkcs8);
    const answer = await remoteRequestsCommand(a, { peer: 'laptop', request }, now);
    expect(answer.ok, JSON.stringify(answer)).toBe(true);
    expect(readNoticeSent(a)[laptopUuid()]?.confirmed).toMatchObject({ serial: 888 });
  });
});

describe('machine requests <machine> (the admin machine asks a peer)', () => {
  it('shows the pending requests of the peer with the exact command to allow them', async () => {
    await refuseOnce(['echo', 'something']);
    await refuseOnce(['echo', 'something']);
    const r = await cli(a, ['requests', 'laptop', '--address', address], prompt);
    // stderr holds only what is signed, said before the passphrase: no warning, no failure.
    expect(r.err).toMatch(/^Signing a read-only request to list the pending requests of laptop/);
    expect(r.err).not.toMatch(/\[(warn|fail)\]/);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(new RegExp(`desktop +${SHELL} +2 +now +echo something$`, 'm'));
    expect(r.out).toContain(`  allow: machine admin allow laptop --shell ${SHELL} -- "echo something"`);
    expect(r.out.split('\n')[0]).toBe('laptop (admin mode): nothing waiting, 1 refused (not allowed)');
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

  it('shows the requests the peer HOLDS (run waits for its owner), with the time left and the commands to allow or deny, and keeps the answer read-only', async () => {
    const waiting = cli(a, ['run', 'laptop', '--address', address, '--shell', SHELL, '--wait', '10s', '--', 'echo', 'held-here'], undefined, { allowLoopbackPeers: true, waitProgressMs: 100 });
    let r = await cli(a, ['requests', 'laptop', '--address', address], prompt);
    for (let i = 0; i < 100 && !/WAITING NOW/.test(r.out); i++) {
      await new Promise((resolve) => setTimeout(resolve, 30));
      r = await cli(a, ['requests', 'laptop', '--address', address], prompt);
    }
    expect(r.code, r.err).toBe(0);
    expect(r.out.split('\n')[0]).toBe('laptop (admin mode): 1 waiting now, no refused request');
    expect(r.out).toMatch(new RegExp(`[0-9a-f]{8} +desktop +\\w+ +\\d+ s +\(now|\d+ s ago) +echo held-here$`, 'm'));
    // Allow is the admin command of THIS machine; the Deny is run on the target (or `machine requests laptop --deny <id>` from here).
    expect(r.out).toContain(`  allow: machine admin allow laptop --shell ${SHELL} -- "echo held-here"`);
    expect(r.out).toMatch(/deny: machine requests laptop --deny <id> /);
    expect(r.out).toMatch(/installs it within about a minute/);
    expect(Math.max(...r.out.split('\n').map((l) => l.length))).toBeLessThanOrEqual(100);
    // The held request is listed once: it is not a refused group yet.
    expect(r.out).not.toContain('REFUSED');
    expect(r.err).not.toMatch(/\[(warn|fail)\]/);
    const json = JSON.parse((await cli(a, ['requests', 'laptop', '--address', address, '--json'], prompt)).out) as { machines: Array<{ answer: { waiting: Array<{ id: string; command: string; shell: string; deadline: number }> } }> };
    const held = json.machines[0]?.answer.waiting ?? [];
    expect(held).toHaveLength(1);
    expect(held[0]).toMatchObject({ command: 'echo held-here', shell: SHELL });
    // Free the caller on the target side (what its owner would do), then the caller ends.
    const denied = await cli(b, ['requests', '--deny', (held[0] as { id: string }).id.slice(0, 8)]);
    expect(denied.code, denied.err).toBe(0);
    expect((await waiting).err).toContain('denied');
  });

  it('a peer without any pending request says so', async () => {
    const r = await cli(a, ['requests', 'laptop', '--address', address], prompt);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/^laptop \(admin mode\): nothing waiting, no refused request/);
  });
});
