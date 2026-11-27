import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCommand, type RunOptions, type RunResult } from '@wadeck-app/machine-exec';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startMachineDaemon } from './daemonEntry.js';
import type { InboxTimer } from './inboxLoop.js';
import { cli, provision } from './testing.js';

// The shape of `machine run --json` is a contract for scripts and for the task project (run-log.md, "run --json"): the document is the
// peer's answer as is. These tests pin the EXACT key set and the type of every value, so a field that is added, removed or retyped fails here.
// Real daemon on loopback; the success and the non-zero exit run a real shell, the timeout and the truncation are a stand-in for the
// executor (a real 60 s timeout or a 1 MiB output would make the suite slow), shaped like the RunResult of machine-exec.

const SHELL = process.platform === 'win32' ? 'cmd' : 'sh';
const idleTimer: InboxTimer = { set: () => 0, clear: () => undefined };

const TIMEOUT_COMMAND = 'echo case-timeout';
const TRUNCATED_COMMAND = 'echo case-truncated';
const CODE_PAGE_COMMAND = 'echo case-codepage';

const base = { stderr: '', durationMs: 12 };
const STAND_INS: Record<string, RunResult> = {
  [TIMEOUT_COMMAND]: { ...base, exitCode: null, stdout: 'partial', timedOut: true, truncated: false, outputNotUtf8: false },
  [TRUNCATED_COMMAND]: { ...base, exitCode: null, stdout: 'xxxx', timedOut: false, truncated: true, outputNotUtf8: false },
  [CODE_PAGE_COMMAND]: { ...base, exitCode: 0, stdout: 'converted', timedOut: false, truncated: false, outputNotUtf8: true, decodedFrom: 'cp850' },
};

const standIn = (options: RunOptions): Promise<RunResult> => {
  const fake = STAND_INS[options.command];
  return fake !== undefined ? Promise.resolve(fake) : runCommand(options);
};

/** Every key with the type of its value ('null' for null), sorted: the whole contract in one comparable object. */
const shapeOf = (value: object): Record<string, string> => {
  const shape: Record<string, string> = {};
  for (const [key, v] of Object.entries(value).sort(([x], [y]) => x.localeCompare(y))) {
    shape[key] = v === null ? 'null' : typeof v;
  }
  return shape;
};

const BASE_SHAPE = {
  durationMs: 'number',
  exitCode: 'number',
  id: 'string',
  outputNotUtf8: 'boolean',
  stderr: 'string',
  stdout: 'string',
  timedOut: 'boolean',
  truncated: 'boolean',
  type: 'string',
};

let root: string;
let a: string;
let b: string;
let address: string;
const stoppers: Array<() => Promise<void>> = [];

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'machine-runjson-'));
  a = join(root, 'a');
  b = join(root, 'b');
  const exitCommand = 'exit 3';
  await provision(root, a, b, [
    { shell: SHELL, command: 'echo listed' },
    { shell: SHELL, command: exitCommand },
    { shell: SHELL, command: TIMEOUT_COMMAND },
    { shell: SHELL, command: TRUNCATED_COMMAND },
    { shell: SHELL, command: CODE_PAGE_COMMAND },
  ]);
  const daemon = await startMachineDaemon(b, { port: 0, version: 'e2e', peerPort: 0, peerHost: '127.0.0.1', advertise: [], inbox: { timer: idleTimer }, exec: { run: standIn }, log: () => undefined });
  stoppers.push(daemon.stop);
  address = `127.0.0.1:${daemon.peerPort}`;
});
afterEach(async () => {
  while (stoppers.length > 0) {
    await stoppers.pop()?.();
  }
  rmSync(root, { recursive: true, force: true });
});

const runJson = async (command: string[]): Promise<Record<string, unknown>> => {
  const r = await cli(a, ['run', 'laptop', '--address', address, '--shell', SHELL, '--no-wait', '--json', '--', ...command], undefined, { allowLoopbackPeers: true });
  // The exit code is the command's own (or 255 for a failure of machine): the document is on stdout in every case.
  expect(r.out, r.err).not.toBe('');
  const doc: Record<string, unknown> = JSON.parse(r.out);
  return doc;
};

describe('machine run --json: the full shape of the document', () => {
  it('success: exactly the nine documented keys, with their types, and no decodedFrom', async () => {
    const doc = await runJson(['echo', 'listed']);
    expect(shapeOf(doc)).toEqual(BASE_SHAPE);
    expect(doc).toMatchObject({ type: 'result', exitCode: 0, timedOut: false, truncated: false, outputNotUtf8: false });
    expect(doc.stdout).toContain('listed');
    expect(doc.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(doc.durationMs as number).toBeGreaterThanOrEqual(0);
  });

  it('non-zero exit: the same keys, exitCode is the number of the command', async () => {
    const doc = await runJson(['exit', '3']);
    expect(shapeOf(doc)).toEqual(BASE_SHAPE);
    expect(doc).toMatchObject({ type: 'result', exitCode: 3, timedOut: false, truncated: false });
  });

  it('timeout: timedOut true and exitCode null (the only change of type), the other keys unchanged', async () => {
    const doc = await runJson(['echo', 'case-timeout']);
    expect(shapeOf(doc)).toEqual({ ...BASE_SHAPE, exitCode: 'null' });
    expect(doc).toMatchObject({ type: 'result', exitCode: null, timedOut: true, truncated: false, stdout: 'partial' });
  });

  it('truncated output: truncated true and exitCode null, the other keys unchanged', async () => {
    const doc = await runJson(['echo', 'case-truncated']);
    expect(shapeOf(doc)).toEqual({ ...BASE_SHAPE, exitCode: 'null' });
    expect(doc).toMatchObject({ type: 'result', exitCode: null, timedOut: false, truncated: true });
  });

  it('output converted from a code page: decodedFrom (a string) is the tenth and only optional key', async () => {
    const doc = await runJson(['echo', 'case-codepage']);
    expect(shapeOf(doc)).toEqual({ ...BASE_SHAPE, decodedFrom: 'string' });
    expect(doc).toMatchObject({ outputNotUtf8: true, decodedFrom: 'cp850' });
  });
});
