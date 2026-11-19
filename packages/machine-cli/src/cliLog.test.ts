import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runCli } from './cli.js';
import { commandForLog, openCliLog } from './cliLog.js';

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
    // The generated passphrase must have been printed, else this test proves nothing.
    expect(passphraseLine).toBeDefined();
    expect(logLines().join('\n')).not.toContain((passphraseLine as string).trim());
  });

  it('logs nothing after "--" and never the value of --hint or --passphrase', () => {
    expect(commandForLog(['--config-dir', 'C:/cfg', 'run', 'laptop', '--', 'curl', '-H', 'token abc'])).toBe('--config-dir C:/cfg run laptop -- <redacted>');
    expect(commandForLog(['admin', 'init', '--hint', 'my cat is Felix', '--generate'])).toBe('admin init --hint <redacted> --generate');
    expect(commandForLog(['admin', 'init', '--hint=my cat'])).toBe('admin init --hint <redacted>');
    expect(commandForLog(['admin', 'init', '--passphrase', 'hunter2'])).toBe('admin init --passphrase <redacted>');
  });

  it('redacts the grouped security code, the 8-digit code and the XXXX-XXXX login code in status lines', () => {
    const log = openCliLog(dir, ['status'], () => {});
    log.output('[info] security code 12345 67890 12345 67890 12345 and login ADMN-7K42 and pairing 12345678\n');
    const joined = logLines().join('\n');
    expect(joined).not.toMatch(/12345 67890/);
    expect(joined).not.toContain('ADMN-7K42');
    expect(joined).not.toContain('12345678');
    expect(joined).toContain('[info] security code <code> and login <code> and pairing <code>');
  });

  it('a message cannot forge a log line or drive the terminal: control characters are replaced', () => {
    const log = openCliLog(dir, ['status'], () => {});
    log.output('[warn] bad\u001b[2Jnews\rthe rest\u0007\n[ok] forged');
    const raw = readdirSync(join(dir, 'logs')).map((f) => readFileSync(join(dir, 'logs', f), 'utf8')).join('');
    // Only the record separators (one per record) are line feeds; no ESC, CR or BEL survives.
    // eslint-disable-next-line no-control-regex
    expect(raw).not.toMatch(/[\u0000-\u0009\u000b-\u001f]/);
    expect(logLines()).toContain('[warn] bad [2Jnews the rest ');
  });

  it('deletes day logs older than 30 days when it opens, only the ones named <day>.ndjson', () => {
    const folder = join(dir, 'logs');
    mkdirSync(folder, { recursive: true });
    const old = join(folder, '2020-01-01.ndjson');
    const recent = join(folder, '2020-02-01.ndjson');
    const other = join(folder, 'notes-old.txt');
    for (const f of [old, recent, other]) writeFileSync(f, '{}\n');
    const longAgo = new Date(Date.now() - 40 * 86_400_000);
    utimesSync(old, longAgo, longAgo);
    utimesSync(other, longAgo, longAgo);
    openCliLog(dir, ['status'], () => {});
    expect(existsSync(old)).toBe(false);
    expect(existsSync(recent)).toBe(true);
    expect(existsSync(other)).toBe(true);
  });
});
