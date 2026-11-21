import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HoldTable } from '@wadeck-app/machine-core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeCommands } from './commands.js';

// The `deny` command of the daemon: the owner refuses a request that a peer's `run --wait` holds (hold-for-approval.md). Restricting, no signature.

const PEER = '1b4e28ba-2fa1-4d3b-a3f4-0123456789ab';
const NOW = 1_800_000_000;
let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'machine-deny-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const holdOf = (table: HoldTable, id: string) => table.admit({ id, peer: PEER, shell: 'sh', command: 'ls', now: NOW, requestedSeconds: 600, capSeconds: 1800 });

describe('daemon command deny', () => {
  it('denies a waiting request with the reason and says which one', () => {
    const table = new HoldTable();
    holdOf(table, 'abcdef-1234');
    const commands = makeCommands(dir, 'test', () => NOW, table);
    const r = commands.deny({ id: 'abcdef-1234', reason: 'not now' });
    expect(r).toEqual({ ok: true, id: 'abcdef-1234', peer: PEER, shell: 'sh', command: 'ls' });
    expect(table.check('abcdef-1234', NOW)).toEqual({ state: 'denied', reason: 'not now' });
  });

  it('takes a unique prefix of the id', () => {
    const table = new HoldTable();
    holdOf(table, 'abcdef-1234');
    const r = makeCommands(dir, 'test', () => NOW, table).deny({ id: 'abcdef' });
    expect(r).toMatchObject({ ok: true, id: 'abcdef-1234' });
  });

  it('names the fix for an unknown id', () => {
    const r = makeCommands(dir, 'test', () => NOW, new HoldTable()).deny({ id: 'nothing-here' });
    expect(r).toMatchObject({ ok: false, reason: 'unknown' });
    expect((r as { message: string }).message).toMatch(/machine requests/);
  });

  it('refuses a reason with a line break and denies nothing', () => {
    const table = new HoldTable();
    holdOf(table, 'abcdef-1234');
    const r = makeCommands(dir, 'test', () => NOW, table).deny({ id: 'abcdef-1234', reason: 'a\nb' });
    expect(r).toMatchObject({ ok: false, reason: 'bad-reason' });
    expect(table.check('abcdef-1234', NOW)).toEqual({ state: 'waiting' });
  });

  it('without a daemon nothing is held: it says so and how to start it', () => {
    const r = makeCommands(dir, 'test', () => NOW).deny({ id: 'abcdef' });
    expect(r).toMatchObject({ ok: false, reason: 'no-daemon' });
    expect((r as { message: string }).message).toMatch(/machine daemon|machine startup enable/);
  });

  it('a payload without an id is refused loudly', () => {
    expect(() => makeCommands(dir, 'test', () => NOW, new HoldTable()).deny({})).toThrow(/id/);
  });

  it('a reason that is not text is refused loudly', () => {
    const table = new HoldTable();
    holdOf(table, 'abcdef-1234');
    expect(() => makeCommands(dir, 'test', () => NOW, table).deny({ id: 'abcdef-1234', reason: 42 })).toThrow(/reason/);
  });
});
