import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RunOptions, RunResult } from '@wadeck-app/machine-exec';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startMachineDaemon } from './daemonEntry.js';
import type { InboxTimer } from './inboxLoop.js';
import { cli, provision } from './testing.js';

// `machine run <machine> --stdin <file|-> ... --json` end to end (stdin-input.md, decisions 114 and D5): a real daemon on loopback, a stand-in for the executor
// that records what reached the command, and the documents `--json` prints for EVERY outcome.

const SHELL = process.platform === 'win32' ? 'cmd' : 'sh';
const idleTimer: InboxTimer = { set: () => 0, clear: () => undefined };
const JSON_INPUT = { format: 'json', maxBytes: 4096, chars: ['letters', 'digits', 'space', 'punct', 'json'] };
const okResult: RunResult = { exitCode: 0, stdout: 'done', stderr: '', timedOut: false, truncated: false, outputNotUtf8: false, durationMs: 4 };

let root: string;
let a: string;
let b: string;
let address: string;
let runs: RunOptions[];
const stoppers: Array<() => Promise<void>> = [];

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'machine-stdin-cli-'));
  a = join(root, 'a');
  b = join(root, 'b');
  runs = [];
  await provision(root, a, b, [{ shell: SHELL, command: 'task remote-call', input: JSON_INPUT }, { shell: SHELL, command: 'plain command' }]);
  const daemon = await startMachineDaemon(b, {
    port: 0,
    version: 'e2e',
    peerPort: 0,
    peerHost: '127.0.0.1',
    advertise: [],
    inbox: { timer: idleTimer },
    exec: { run: async (o) => (runs.push(o), okResult) },
    log: () => undefined,
  });
  stoppers.push(daemon.stop);
  address = `127.0.0.1:${daemon.peerPort}`;
});
afterEach(async () => {
  while (stoppers.length > 0) await stoppers.pop()?.();
  rmSync(root, { recursive: true, force: true });
});

const run = async (extra: string[], command: string[], io: Parameters<typeof cli>[3] = {}) =>
  cli(a, ['run', 'laptop', '--address', address, '--shell', SHELL, '--no-wait', '--no-wake', '--json', ...extra, '--', ...command], undefined, { allowLoopbackPeers: true, ...io });
const doc = (out: string): Record<string, unknown> => {
  // exactly ONE document on stdout
  expect(out.trim().length, 'stdout is empty').toBeGreaterThan(0);
  return JSON.parse(out) as Record<string, unknown>;
};
const shapeOf = (value: object): Record<string, string> => Object.fromEntries(Object.entries(value).sort(([x], [y]) => x.localeCompare(y)).map(([k, v]) => [k, v === null ? 'null' : typeof v]));

describe('machine run --stdin', () => {
  it('`--stdin -` with --json --no-wait --no-wake --shell sends the local stdin to the command, byte for byte', async () => {
    const payload = Buffer.from('{"op": "get", "id": 12}\n');
    const r = await run(['--stdin', '-'], ['task', 'remote-call'], { readStdin: async () => payload });
    expect(r.code, r.err).toBe(0);
    expect(doc(r.out)).toMatchObject({ type: 'result', code: 'ok', exitCode: 0, stdout: 'done' });
    expect(runs).toHaveLength(1);
    expect(Buffer.from(runs[0]?.stdin as Uint8Array).equals(payload)).toBe(true);
    // the command line is the typed command, nothing else
    expect(runs[0]?.command).toBe('task remote-call');
  });

  it('`--stdin <file>` reads the file', async () => {
    const file = join(root, 'request.json');
    writeFileSync(file, '{"op":"add"}');
    const r = await run(['--stdin', file], ['task', 'remote-call']);
    expect(r.code, r.err).toBe(0);
    expect(Buffer.from(runs[0]?.stdin as Uint8Array).toString('utf8')).toBe('{"op":"add"}');
  });

  it('without --stdin the local stdin is never read and the command gets none', async () => {
    let read = false;
    const r = await run([], ['plain', 'command'], { readStdin: async () => ((read = true), Buffer.alloc(0)) });
    expect(r.code, r.err).toBe(0);
    expect(read).toBe(false);
    expect(runs[0]?.stdin).toBeUndefined();
  });

  it('a file that does not exist is a usage error naming it, and nothing is sent', async () => {
    const r = await run(['--stdin', join(root, 'missing.json')], ['task', 'remote-call']);
    expect(r.code).toBe(255);
    expect(doc(r.out)).toMatchObject({ type: 'error', code: 'usage' });
    expect(String(doc(r.out).message)).toContain('missing.json');
    expect(runs).toHaveLength(0);
  });

  it('`--stdin -` on a terminal is a usage error that says to pipe the payload', async () => {
    const r = await run(['--stdin', '-'], ['task', 'remote-call'], { stdinIsTty: true });
    expect(r.code).toBe(255);
    expect(doc(r.out)).toMatchObject({ code: 'usage' });
    expect(String(doc(r.out).message)).toMatch(/pipe/);
    expect(runs).toHaveLength(0);
  });

  it('a payload above 512 KiB is refused locally with refused:input-too-large and nothing is sent', async () => {
    const r = await run(['--stdin', '-'], ['task', 'remote-call'], { readStdin: async () => Buffer.alloc(512 * 1024 + 1, 0x61) });
    expect(r.code).toBe(255);
    expect(doc(r.out)).toMatchObject({ type: 'refused', code: 'refused:input-too-large' });
    expect(runs).toHaveLength(0);
  });

  it('`--stdin` without a value is a usage error', async () => {
    const r = await run(['--stdin'], ['task', 'remote-call']);
    expect(r.code).toBe(2);
    expect(doc(r.out)).toMatchObject({ code: 'usage' });
  });
});

describe('machine run --json: every outcome is exactly one document with a stable code', () => {
  it('a command that ran: the answer of the peer plus code and message (full shape)', async () => {
    const r = await run([], ['plain', 'command']);
    expect(shapeOf(doc(r.out))).toEqual({ code: 'string', durationMs: 'number', exitCode: 'number', id: 'string', message: 'string', outputNotUtf8: 'boolean', stderr: 'string', stdout: 'string', timedOut: 'boolean', truncated: 'boolean', type: 'string' });
  });

  it('refused:not-allowed (exit 255, stderr keeps the human text)', async () => {
    const r = await run([], ['not', 'listed']);
    expect(r.code).toBe(255);
    const d = doc(r.out);
    expect(d).toMatchObject({ type: 'refused', code: 'refused:not-allowed', reason: 'not-listed', exitCode: null, stdout: '', stderr: '', timedOut: false, truncated: false });
    expect(shapeOf(d)).toEqual({ code: 'string', exitCode: 'null', id: 'string', message: 'string', reason: 'string', stderr: 'string', stdout: 'string', timedOut: 'boolean', truncated: 'boolean', type: 'string' });
    expect(String(d.message)).toMatch(/refused by laptop/);
    expect(r.err).toMatch(/refused by laptop/);
  });

  it('refused:input-not-allowed: the command is allowed, its entry declares no input', async () => {
    const r = await run(['--stdin', '-'], ['plain', 'command'], { readStdin: async () => Buffer.from('{}') });
    expect(r.code).toBe(255);
    expect(doc(r.out)).toMatchObject({ type: 'refused', code: 'refused:input-not-allowed' });
    expect(runs).toHaveLength(0);
  });

  it('refused:input-chars and refused:input-format name the cause and never print the payload', async () => {
    const chars = await run(['--stdin', '-'], ['task', 'remote-call'], { readStdin: async () => Buffer.from('{"a":"x;y"}') });
    expect(doc(chars.out)).toMatchObject({ code: 'refused:input-chars' });
    expect(chars.out + chars.err).not.toContain('x;y');
    const format = await run(['--stdin', '-'], ['task', 'remote-call'], { readStdin: async () => Buffer.from('{"a":') });
    expect(doc(format.out)).toMatchObject({ code: 'refused:input-format' });
  });

  it('refused:input-too-large names the maximum of the entry', async () => {
    const r = await run(['--stdin', '-'], ['task', 'remote-call'], { readStdin: async () => Buffer.from(`{"a":"${'a'.repeat(5000)}"}`) });
    expect(doc(r.out)).toMatchObject({ code: 'refused:input-too-large' });
    expect(String(doc(r.out).message)).toMatch(/4096/);
  });

  it('unknown-machine', async () => {
    const r = await cli(a, ['run', 'nobody', '--no-wait', '--json', '--', 'x'], undefined, { allowLoopbackPeers: true });
    expect(r.code).toBe(255);
    expect(doc(r.out)).toMatchObject({ type: 'error', code: 'unknown-machine' });
    expect(r.err).toMatch(/nobody/);
  });

  it('usage (no command), exit code unchanged', async () => {
    const r = await cli(a, ['run', 'laptop', '--json'], undefined, { allowLoopbackPeers: true });
    expect(r.code).toBe(255);
    expect(doc(r.out)).toMatchObject({ type: 'error', code: 'usage' });
  });

  it('usage at the level of the command line (an unknown option), exit 2 unchanged', async () => {
    const r = await cli(a, ['run', 'laptop', '--json', '--frobnicate', '--', 'x'], undefined, { allowLoopbackPeers: true });
    expect(r.code).toBe(2);
    expect(doc(r.out)).toMatchObject({ type: 'error', code: 'usage' });
  });

  it('unreachable: nobody listens at the address', async () => {
    const r = await cli(a, ['run', 'laptop', '--address', '127.0.0.1:1', '--shell', SHELL, '--no-wait', '--no-wake', '--json', '--', 'plain command'], undefined, { allowLoopbackPeers: true });
    expect(r.code).toBe(255);
    expect(doc(r.out)).toMatchObject({ type: 'error', code: 'unreachable' });
  });

  it('without --json nothing is printed on stdout for a refusal (as before)', async () => {
    const r = await cli(a, ['run', 'laptop', '--address', address, '--shell', SHELL, '--no-wait', '--no-wake', '--', 'not listed'], undefined, { allowLoopbackPeers: true });
    expect(r.code).toBe(255);
    expect(r.out).toBe('');
    expect(r.err).toMatch(/refused by laptop/);
  });
});
