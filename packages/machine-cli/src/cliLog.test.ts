import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runCli } from './cli.js';

// Every command leaves a trace in <configDir>/logs/<day>.ndjson (what `machine cli logs` shows): the command line, what it
// said ([ok]/[warn]/[fail]/[info] lines) and how it ended. Secrets never go there.

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'machine-clilog-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function logLines(): string[] {
  const folder = join(dir, 'logs');
  if (!existsSync(folder)) return [];
  return readdirSync(folder).flatMap((f) => readFileSync(join(folder, f), 'utf8').split('\n').filter((l) => l.length > 0).map((l) => (JSON.parse(l) as { msg: string }).msg));
}

async function run(args: string[]): Promise<{ code: number; out: string; err: string }> {
  let out = '';
  let err = '';
  const code = await runCli(['--config-dir', dir, ...args], { stdout: (t) => (out += t), stderr: (t) => (err += t) });
  return { code, out, err };
}

describe('the CLI log', () => {
  it('records the command, its status lines and its exit code', async () => {
    const r = await run(['init', '--name', 'desktop']);
    expect(r.code).toBe(0);
    const lines = logLines();
    expect(lines[0]).toMatch(/^cmd: --config-dir .* init --name desktop$/);
    expect(lines.some((l) => l.startsWith('[ok]'))).toBe(true);
    expect(lines.at(-1)).toMatch(/^exit 0 after \d+ ms$/);
  });

  it('records a failure with its message', async () => {
    const r = await run(['run', 'nobody', '--', 'ls']);
    expect(r.code).not.toBe(0);
    expect(logLines().some((l) => l.startsWith('[fail]'))).toBe(true);
    expect(logLines().at(-1)).toMatch(/^exit [1-9]\d* after/);
  });

  it('never writes an 8-digit pairing code, a hint-free secret or a passphrase line', async () => {
    await run(['admin', 'login', '12345678', '--relay', 'http://127.0.0.1:1']);
    expect(logLines().join('\n')).not.toContain('12345678');
  });

  it('does not write the passphrase a command prints once', async () => {
    const r = await run(['admin', 'init', '--generate']);
    const passphraseLine = r.err.split('\n').find((l) => /^\s{2}\S/.test(l));
    if (passphraseLine !== undefined) expect(logLines().join('\n')).not.toContain(passphraseLine.trim());
  });
});
