import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runCommand, type RunOptions } from './run.js';

// R1 (stdin-input.md): the payload is written to the stdin pipe of the spawned process and nowhere else: not the command line, not the
// environment. Real shells of the machine that runs the tests, a real child that reads its stdin.

const shell = process.platform === 'win32' ? 'cmd' : 'sh';
const quick: Pick<RunOptions, 'timeoutMs' | 'maxOutputBytes'> = { timeoutMs: 30_000, maxOutputBytes: 2_000_000 };

let dir: string;
let reader: string;
let ignorer: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'machine-stdin-'));
  reader = join(dir, 'reader.mjs');
  ignorer = join(dir, 'ignorer.mjs');
  // Prints what reached the child: the stdin bytes as hex, the argv after the script, and whether any environment value holds a marker.
  writeFileSync(
    reader,
    [
      "const chunks = [];",
      "process.stdin.on('data', (c) => chunks.push(c));",
      "process.stdin.on('end', () => {",
      "  const bytes = Buffer.concat(chunks);",
      "  const env = JSON.stringify(process.env);",
      "  process.stdout.write(JSON.stringify({ hex: bytes.toString('hex'), argv: process.argv.slice(2), envHasPayload: env.includes('PAYLOAD-MARKER') }));",
      "});",
    ].join('\n'),
  );
  // Never reads its stdin and exits at once: a large payload then hits a closed pipe.
  writeFileSync(ignorer, "process.stdout.write('done');\n");
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const nodeCommand = (script: string): string => `"${process.execPath}" "${script}"`;
const decode = (stdout: string): { hex: string; argv: string[]; envHasPayload: boolean } => JSON.parse(stdout);

describe('runCommand with a stdin payload', () => {
  it('writes the payload byte for byte, shell metacharacters, quotes and newlines included, and ends the stream', async () => {
    const payload = Buffer.from('{"q":"$(id) `x` ; & | > < \\" \' %PATH% PAYLOAD-MARKER"}\nline 2 é日\n', 'utf8');
    const r = await runCommand({ shell, command: nodeCommand(reader), ...quick, stdin: payload });
    expect(r.exitCode, r.stderr).toBe(0);
    const seen = decode(r.stdout);
    expect(Buffer.from(seen.hex, 'hex').equals(payload)).toBe(true);
    // R1: nothing of it on the command line or in the environment
    expect(seen.argv).toEqual([]);
    expect(seen.envHasPayload).toBe(false);
  });

  it('an empty payload is an empty stream, closed (not a hang)', async () => {
    const r = await runCommand({ shell, command: nodeCommand(reader), ...quick, stdin: new Uint8Array(0) });
    expect(decode(r.stdout).hex).toBe('');
  });

  it('without a payload stdin stays closed as before (end of file at once)', async () => {
    const r = await runCommand({ shell, command: nodeCommand(reader), ...quick });
    expect(decode(r.stdout).hex).toBe('');
  });

  it('a command that never reads its stdin is not an error (EPIPE is ignored), even with a large payload', async () => {
    const payload = Buffer.alloc(512 * 1024, 0x61);
    const r = await runCommand({ shell, command: nodeCommand(ignorer), ...quick, stdin: payload });
    expect(r.exitCode, r.stderr).toBe(0);
    expect(r.stdout).toBe('done');
  });

  it('a payload of 512 KiB reaches a reading command whole', async () => {
    const payload = Buffer.alloc(512 * 1024);
    for (let i = 0; i < payload.length; i += 1) payload[i] = 0x20 + (i % 90);
    const r = await runCommand({ shell, command: nodeCommand(reader), ...quick, stdin: payload });
    expect(Buffer.from(decode(r.stdout).hex, 'hex').equals(payload)).toBe(true);
  });
});
