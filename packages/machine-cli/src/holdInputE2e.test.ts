import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RunOptions, RunResult } from '@wadeck-app/machine-exec';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startMachineDaemon } from './daemonEntry.js';
import { readMachine } from './identity.js';
import type { InboxTimer } from './inboxLoop.js';
import { cli, ok, provision } from './testing.js';

// A held request that carries a payload (stdin-input.md, "Held requests", D1), through real daemons on loopback: the owner of the target sees the payload
// ESCAPED in `machine requests`, with its size and hash and the smallest declaration that covers it; the audit log has the size and the hash only.

const SHELL = process.platform === 'win32' ? 'cmd' : 'sh';
const idleTimer: InboxTimer = { set: () => 0, clear: () => undefined };
const okResult: RunResult = { exitCode: 0, stdout: 'done', stderr: '', timedOut: false, truncated: false, outputNotUtf8: false, durationMs: 4 };

let root: string;
let a: string;
let b: string;
let passphrase: string;
let address: string;
let runs: RunOptions[];
const stoppers: Array<() => Promise<void>> = [];

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'machine-hold-input-'));
  a = join(root, 'a');
  b = join(root, 'b');
  runs = [];
  passphrase = await provision(root, a, b, [{ shell: SHELL, command: 'echo listed' }]);
  const daemon = await startMachineDaemon(b, { port: 0, version: 'e2e', peerPort: 0, peerHost: '127.0.0.1', advertise: [], inbox: { timer: idleTimer }, exec: { run: async (o) => (runs.push(o), okResult) }, log: () => undefined });
  stoppers.push(daemon.stop);
  address = `127.0.0.1:${daemon.peerPort}`;
});
afterEach(async () => {
  while (stoppers.length > 0) await stoppers.pop()?.();
  rmSync(root, { recursive: true, force: true });
});

const PAYLOAD = '{"op": "get", "note": "caf\u00e9"}\n';

async function waitingId(): Promise<string> {
  for (let i = 0; i < 200; i++) {
    const r = await cli(b, ['requests', '--json']);
    const waiting = (JSON.parse(r.out) as { summary: { waiting: Array<{ id: string }> } }).summary.waiting;
    if (waiting.length > 0) return waiting[0]?.id as string;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('the request was never held');
}

describe('machine requests shows the payload of a held request', () => {
  it('escaped, with size, hash and the smallest declaration; the run goes on once an Allow declares the input', async () => {
    const pending = cli(a, ['run', 'laptop', '--address', address, '--shell', SHELL, '--wait', '10s', '--stdin', '-', '--json', '--', 'task remote-call'], undefined, { allowLoopbackPeers: true, readStdin: async () => Buffer.from(PAYLOAD) });
    const id = await waitingId();
    const listing = await cli(b, ['requests']);
    expect(listing.out).toMatch(/WAITING NOW/);
    expect(listing.out).toMatch(/stdin of [0-9a-f]{8}: \d+ bytes, sha256 [0-9a-f]{16}/);
    // the line feed is shown as an escape (the escaping of bidi and control characters is tested in machine-core)
    expect(listing.out).toContain('\\n');
    expect(listing.out).toContain('"op": "get"');
    // the smallest families that cover it: a JSON document of words
    expect(listing.out).toMatch(/--stdin [a-z]+ --stdin-chars/);
    // the JSON of the listing carries the preview too
    const json = JSON.parse((await cli(b, ['requests', '--json'])).out) as { summary: { waiting: Array<{ input?: { bytes: number }; inputPreview?: { text: string } }> } };
    expect(json.summary.waiting[0]?.input?.bytes).toBe(Buffer.byteLength(PAYLOAD));
    expect(json.summary.waiting[0]?.inputPreview?.text).toContain('\\n');

    // The Allow: the entry declares the input (version 3), signed on the admin machine, installed on the target.
    const target = readMachine(b).uuid;
    writeFileSync(
      join(root, 'draft2.json'),
      JSON.stringify({ v: 3, target, version: 2, baseVersion: 1, defaults: [{ shell: SHELL, command: 'echo listed' }, { shell: SHELL, command: 'task remote-call', input: { format: 'json', maxBytes: 4096, chars: ['json', 'utf8-text'] } }], peers: {} }),
    );
    await ok(a, ['admin', 'sign-policy', join(root, 'draft2.json'), '--out', join(root, 'policy-b2.json')], async () => passphrase);
    await ok(b, ['policy', 'install', join(root, 'policy-b2.json')]);
    const r = await pending;
    expect(r.code, r.err).toBe(0);
    expect(JSON.parse(r.out)).toMatchObject({ type: 'result', code: 'ok' });
    expect(Buffer.from(runs[0]?.stdin as Uint8Array).toString('utf8')).toBe(PAYLOAD);
    expect(runs[0]?.command).toBe('task remote-call');
    // R4: the audit log of the target never holds the payload
    const log = await cli(b, ['requests', '--history', '--json', '--limit', '1000']);
    expect(log.out).not.toContain('\\"op\\"');
    expect(log.out).not.toContain('"op"');
    expect(log.out).not.toContain('café');
    void id;
  });

  it('a Deny ends the hold: the payload is gone from the listing', async () => {
    const pending = cli(a, ['run', 'laptop', '--address', address, '--shell', SHELL, '--wait', '10s', '--stdin', '-', '--', 'task remote-call'], undefined, { allowLoopbackPeers: true, readStdin: async () => Buffer.from('{}') });
    const id = await waitingId();
    expect((await cli(b, ['requests', '--deny', id.slice(0, 8)])).code).toBe(0);
    expect((await pending).code).toBe(255);
    expect((await cli(b, ['requests'])).out).not.toMatch(/stdin of/);
  });
});
