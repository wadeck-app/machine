import { mkdtempSync, rmSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runCli } from './cli.js';
import { parseSince, shellQuote } from './cliRequests.js';
import { initMachine } from './identity.js';
import { FileAuditLog } from './stores.js';

const PEER = '11111111-1111-4111-8111-111111111111';
const NOW = new Date(2026, 10, 20, 22, 0, 0);
const at = (offsetSeconds: number) => new Date(NOW.getTime() + offsetSeconds * 1000).toISOString();

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'machine-cli-requests-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

async function run(...args: string[]): Promise<{ code: number; out: string; err: string }> {
  let out = '';
  let err = '';
  const code = await runCli([...args, '--config-dir', dir], { stdout: (t) => (out += t), stderr: (t) => (err += t), now: () => NOW });
  return { code, out, err };
}

const refusal = (offset: number, command: string, shell = 'sh') => ({ ts: at(offset), event: 'refused', source: PEER, reason: 'not-listed', id: `i${offset}`, shell, command });

function seed(): void {
  initMachine(dir, 'target');
  const log = new FileAuditLog(join(dir, 'audit.log'));
  log.write(refusal(-3 * 3600, 'ls'));
  log.write(refusal(-2 * 3600, 'ls'));
  log.write(refusal(-300, 'ls'));
  log.write(refusal(-60, 'df -h'));
  log.write({ ts: at(-30), event: 'accepted', source: PEER, id: 'r1', shell: 'sh', command: 'uptime' });
  log.write({ ts: at(-29), event: 'completed', id: 'r1', exitCode: 0, timedOut: false, truncated: false, durationMs: 1500 });
  log.write({ ts: at(-10), event: 'session-closed', source: PEER, reason: 'too-many-refusals', refusals: 21 });
}

describe('machine requests', () => {
  it('lists the pending requests, newest first, with the exact next command (admin mode)', async () => {
    seed();
    const r = await run('requests');
    expect(r.code, r.err).toBe(0);
    const lines = r.out.split('\n');
    const first = lines.findIndex((l) => l.includes('df -h'));
    const second = lines.findIndex((l) => l.includes('sh "ls"'));
    expect(first).toBeGreaterThan(-1);
    expect(second).toBeGreaterThan(first);
    expect(r.out).toContain(`${PEER.slice(0, 8)} -> sh "ls"  3 times, first `);
    expect(r.out).toContain('3 h ago');
    expect(r.out).toContain('5 min ago');
    expect(r.out).toContain('machine admin allow target --shell sh -- ls');
    expect(r.out).toContain('machine admin allow target --shell sh -- "df -h"');
    expect(r.out).toMatch(/admin machine/);
    // The limitation is stated, not implied.
    expect(r.out).toMatch(/this machine's requests/i);
  });

  it('says what to run in mode local', async () => {
    seed();
    writeFileSync(join(dir, 'policy-mode.json'), 'not used: see below');
    // A damaged mode file is reported by the loader as a problem and the mode is local (fail closed): the local command is shown.
    const r = await run('requests');
    expect(r.out).toContain('machine policy allow --shell sh -- ls');
    expect(r.out).not.toContain('machine admin allow');
  });

  it('says there is nothing pending, and why when no request ever came', async () => {
    initMachine(dir, 'target');
    const r = await run('requests');
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/no request waiting for approval/i);
    expect(r.out).toMatch(/no audit log yet/i);
  });

  it('fails with the command to run when the machine is not initialized', async () => {
    const r = await run('requests');
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/machine init|machine setup/);
  });

  it('warns loudly about a broken chain and still lists what is readable', async () => {
    seed();
    appendFileSync(join(dir, 'audit.log'), '{edited\n');
    const r = await run('requests');
    expect(r.code).toBe(0);
    expect(r.err).toMatch(/\[warn\] audit log is broken at line 8/);
    expect(r.err).toMatch(/Keep a copy/);
    expect(r.out).toContain('sh "ls"');
  });

  it('--json is one document with the pending groups and the chain', async () => {
    seed();
    const r = await run('requests', '--json');
    const doc = JSON.parse(r.out) as { summary: { pending: unknown[]; chain: { ok: boolean } } };
    expect(doc.summary.pending).toHaveLength(2);
    expect(doc.summary.chain.ok).toBe(true);
  });

  it('--limit caps the groups and says how many were left out', async () => {
    seed();
    const r = await run('requests', '--limit', '1');
    expect(r.out).toContain('df -h');
    expect(r.out).not.toContain('sh "ls"');
    expect(r.out).toMatch(/showing 1 of 2/);
  });
});

describe('machine requests --history', () => {
  it('shows the runs with exit code and duration, the refusals with their reason and the session events', async () => {
    seed();
    const r = await run('requests', '--history');
    expect(r.code, r.err).toBe(0);
    expect(r.out).toMatch(/run .*sh "uptime" -> exit 0 in 1\.5 s/);
    expect(r.out).toMatch(/refused \(not-listed\) sh "df -h"/);
    expect(r.out).toMatch(/session .*session-closed \(too-many-refusals\)/);
  });

  it('filters by --event, --since and --limit', async () => {
    seed();
    const events = await run('requests', '--history', '--event', 'session');
    expect(events.out).toContain('session-closed');
    expect(events.out).not.toContain('uptime');
    const since = await run('requests', '--history', '--since', '10m', '--event', 'refused');
    expect(since.out).toContain('df -h');
    expect(since.out).not.toContain('3 h ago');
    const limited = await run('requests', '--history', '--limit', '1');
    expect(limited.out).toContain('session-closed');
    expect(limited.out).toMatch(/showing the last 1 of 6/);
  });

  it('--peer needs a known machine', async () => {
    seed();
    const r = await run('requests', '--history', '--peer', 'nobody');
    // 3: an unknown or ambiguous machine, as everywhere else.
    expect(r.code).toBe(3);
    expect(r.err).toMatch(/nobody/);
    const byUuid = await run('requests', '--history', '--peer', PEER, '--event', 'run');
    expect(byUuid.out).toContain('uptime');
  });

  it('rejects options that only make sense with --history, and bad values, with the fix', async () => {
    seed();
    expect((await run('requests', '--since', '1h')).err).toMatch(/--history/);
    expect((await run('requests', '--history', '--event', 'bogus')).err).toMatch(/run, refused, session, document/);
    expect((await run('requests', '--history', '--limit', '0')).err).toMatch(/--limit/);
    expect((await run('requests', '--history', '--since', 'yesterday-ish')).err).toMatch(/--since/);
  });
});

describe('parseSince', () => {
  const nowSeconds = Math.floor(NOW.getTime() / 1000);
  it('reads durations and local dates', () => {
    expect(parseSince('30m', nowSeconds)).toBe(nowSeconds - 1800);
    expect(parseSince('2h', nowSeconds)).toBe(nowSeconds - 7200);
    expect(parseSince('3d', nowSeconds)).toBe(nowSeconds - 3 * 86400);
    expect(parseSince('2026-11-20', nowSeconds)).toBe(Math.floor(new Date(2026, 10, 20, 0, 0, 0).getTime() / 1000));
    expect(parseSince('2026-11-20 21:30', nowSeconds)).toBe(Math.floor(new Date(2026, 10, 20, 21, 30, 0).getTime() / 1000));
  });
  it('refuses anything else with the accepted forms', () => {
    expect(() => parseSince('soon', nowSeconds)).toThrow(/30m.*2h.*3d.*2026-11-20/s);
    expect(() => parseSince('0h', nowSeconds)).toThrow();
  });
});

describe('shellQuote', () => {
  it('leaves a plain word alone and quotes the rest', () => {
    expect(shellQuote('ls')).toBe('ls');
    expect(shellQuote('df -h')).toBe('"df -h"');
    expect(shellQuote('echo $HOME')).toBe(`'echo $HOME'`);
  });
});
