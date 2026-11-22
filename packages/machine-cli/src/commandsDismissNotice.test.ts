import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeCommands } from './commands.js';
import { noticesFile } from './noticesStore.js';

// The `dismissNotice` command of the daemon (decision 100): removes a refused or an expired notice from notices.json. Restricting and display only: no signature,
// nothing is sent to the target, the audit log is never touched.

const SENDER = '0a1b2c3d-4e5f-4a6b-9c7d-8e9f0a1b2c3d';
const PEER = '6f1c2d3e-4a5b-4c6d-8e7f-0a1b2c3d4e5f';
const NOW = 1_800_000_000;
const idOf = (n: number): string => `3f1c2d3e-4a5b-4c6d-8e7f-${String(n).padStart(12, '0')}`;
const notice = (n: number, over: Record<string, unknown> = {}) => ({
  machine: SENDER, machineName: 'thinkcentre', receivedAt: NOW - 1000 - n, id: idOf(n), peer: PEER, peerName: 'agent-box', shell: 'sh', command: `echo ${n}`, commandTruncated: false, state: 'held', deadline: NOW - 100, ts: NOW - 1000 - n, ...over,
});

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'machine-dismiss-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const seed = (...list: unknown[]) => writeFileSync(noticesFile(dir), JSON.stringify({ v: 1, notices: list }));
const stored = (): string[] => (JSON.parse(readFileSync(noticesFile(dir), 'utf8')) as { notices: Array<{ id: string }> }).notices.map((n) => n.id);
const commands = () => makeCommands(dir, 'test', () => NOW);

describe('daemon command dismissNotice', () => {
  it('removes an expired notice and keeps the others; the change survives a new read of the file', () => {
    seed(notice(1), notice(2, { deadline: NOW + 300 }));
    expect(commands().dismissNotice({ machine: SENDER, id: idOf(1) })).toEqual({ ok: true, removed: 1 });
    expect(stored()).toEqual([idOf(2)]);
  });

  it('removes a refused notice', () => {
    seed(notice(3, { state: 'refused', deadline: null }));
    expect(commands().dismissNotice({ machine: SENDER, id: idOf(3) })).toEqual({ ok: true, removed: 1 });
    expect(stored()).toEqual([]);
  });

  it('refuses a live hold and leaves the file as it was', () => {
    seed(notice(2, { deadline: NOW + 300 }));
    const before = readFileSync(noticesFile(dir), 'utf8');
    expect(commands().dismissNotice({ machine: SENDER, id: idOf(2) })).toMatchObject({ ok: false, reason: 'live' });
    expect(readFileSync(noticesFile(dir), 'utf8')).toBe(before);
  });

  it('refuses an unknown id with a message that says what to do', () => {
    seed(notice(1));
    const r = commands().dismissNotice({ machine: SENDER, id: idOf(9) });
    expect(r).toMatchObject({ ok: false, reason: 'unknown' });
    expect((r as { message: string }).message).toMatch(/reload/i);
    expect(stored()).toEqual([idOf(1)]);
  });

  it('refuses an unknown id when there is no notices file at all', () => {
    expect(commands().dismissNotice({ machine: SENDER, id: idOf(1) })).toMatchObject({ ok: false, reason: 'unknown' });
  });

  it('clears every expired notice with { expired: true } and says how many', () => {
    seed(notice(1), notice(2, { deadline: NOW + 300 }), notice(3), notice(4, { state: 'refused', deadline: null }));
    expect(commands().dismissNotice({ expired: true })).toEqual({ ok: true, removed: 2 });
    expect(new Set(stored())).toEqual(new Set([idOf(2), idOf(4)]));
  });

  it('refuses a payload that is neither { machine, id } nor { expired: true }, naming what is expected', () => {
    expect(() => commands().dismissNotice({})).toThrow(/machine.*id|expired/);
    expect(() => commands().dismissNotice({ machine: 'not-a-uuid', id: idOf(1) })).toThrow(/machine/);
    expect(() => commands().dismissNotice({ machine: SENDER, id: 'x' })).toThrow(/id/);
    expect(() => commands().dismissNotice({ expired: false })).toThrow(/expired/);
  });

  it('a damaged notices file is refused loudly with its fix', () => {
    writeFileSync(noticesFile(dir), '{ nope');
    expect(() => commands().dismissNotice({ expired: true })).toThrow(/notices\.json.*Delete it/);
  });
});
