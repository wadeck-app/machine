import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { HoldTable } from '@wadeck-app/machine-core';
import { holdLimitsFile, createHoldLimitsReader } from './holdLimitsStore.js';
import { cli } from './testing.js';

// `machine hold-limits` (the owner's setting of how many requests this machine holds) and the reader the daemon applies at each admission.

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'machine-hold-limits-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('machine hold-limits', () => {
  it('shows the built-in defaults, where they come from and how to change them', async () => {
    const r = await cli(dir, ['hold-limits']);
    expect(r.code, r.err).toBe(0);
    expect(r.out).toMatch(/per peer: 5 \(built-in default\)/);
    expect(r.out).toMatch(/per machine: 10 \(built-in default\)/);
    expect(r.out).toContain(holdLimitsFile(dir));
    expect(r.out).toMatch(/machine hold-limits --per-peer <1\.\.20> --per-machine <1\.\.50>/);
    expect(existsSync(holdLimitsFile(dir))).toBe(false);
  });

  it('sets a value, shows its origin, and --json is one document', async () => {
    const set = await cli(dir, ['hold-limits', '--per-peer', '3']);
    expect(set.code, set.err).toBe(0);
    expect(JSON.parse(readFileSync(holdLimitsFile(dir), 'utf8'))).toEqual({ v: 1, perPeer: 3 });
    const shown = await cli(dir, ['hold-limits']);
    expect(shown.out).toMatch(/per peer: 3 \(setting hold-limits\)/);
    expect(shown.out).toMatch(/per machine: 10 \(built-in default\)/);
    const json = JSON.parse((await cli(dir, ['hold-limits', '--json'])).out) as { perPeer: number; perPeerSource: string; perMachine: number; perMachineSource: string; setting: unknown };
    expect(json).toMatchObject({ perPeer: 3, perPeerSource: 'setting', perMachine: 10, perMachineSource: 'built-in', setting: { v: 1, perPeer: 3 } });
  });

  it('keeps the other value when one is changed', async () => {
    await cli(dir, ['hold-limits', '--per-peer', '3', '--per-machine', '6']);
    await cli(dir, ['hold-limits', '--per-machine', '8']);
    expect(JSON.parse(readFileSync(holdLimitsFile(dir), 'utf8'))).toEqual({ v: 1, perPeer: 3, perMachine: 8 });
  });

  it.each([
    ['zero', '0', /--per-peer "0" is not a whole number from 1 to 20/],
    ['above the maximum', '21', /1 to 20/],
    ['text', 'many', /--per-peer "many".*1 to 20/],
    ['a fraction', '2.5', /1 to 20/],
  ])('refuses --per-peer %s, saves nothing and names the range', async (_n, value, message) => {
    const r = await cli(dir, ['hold-limits', '--per-peer', value]);
    expect(r.code).toBe(2);
    expect(r.err).toMatch(message);
    expect(existsSync(holdLimitsFile(dir))).toBe(false);
  });

  it('refuses --per-machine above 50', async () => {
    const r = await cli(dir, ['hold-limits', '--per-machine', '51']);
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/--per-machine "51".*1 to 50/);
  });

  it('refuses a per-machine value below the per-peer one, and a per-peer above the built-in per-machine default, naming the fix', async () => {
    const below = await cli(dir, ['hold-limits', '--per-peer', '8', '--per-machine', '6']);
    expect(below.code).toBe(2);
    expect(below.err).toMatch(/limit per machine \(6\) must be at least the limit per peer \(8\).*nothing was saved/s);
    const above = await cli(dir, ['hold-limits', '--per-peer', '15']);
    expect(above.code).toBe(2);
    expect(above.err).toMatch(/\(10, the built-in default\).*--per-machine 30/s);
    expect(existsSync(holdLimitsFile(dir))).toBe(false);
    expect((await cli(dir, ['hold-limits', '--per-peer', '15', '--per-machine', '20'])).code).toBe(0);
  });

  it('--reset deletes the setting, stands alone, and works on a damaged file', async () => {
    await cli(dir, ['hold-limits', '--per-peer', '3']);
    const alone = await cli(dir, ['hold-limits', '--reset', '--per-peer', '3']);
    expect(alone.code).toBe(2);
    writeFileSync(holdLimitsFile(dir), '{ nope');
    const reset = await cli(dir, ['hold-limits', '--reset']);
    expect(reset.code, reset.err).toBe(0);
    expect(existsSync(holdLimitsFile(dir))).toBe(false);
    expect((await cli(dir, ['hold-limits', '--reset'])).out).toMatch(/no setting file/);
  });

  it('a damaged file stops the command with the path and the way out, never a fallback', async () => {
    writeFileSync(holdLimitsFile(dir), '{ nope');
    const r = await cli(dir, ['hold-limits']);
    expect(r.code).toBe(1);
    expect(r.err).toContain(holdLimitsFile(dir));
    expect(r.err).toMatch(/machine hold-limits --reset/);
  });

  it('refuses the flags on another command and a stray argument', async () => {
    expect((await cli(dir, ['status', '--per-peer', '3'])).err).toMatch(/only apply to `machine hold-limits`/);
    expect((await cli(dir, ['hold-limits', 'extra'])).err).toMatch(/unexpected argument "extra"/);
  });
});

describe('the reader of the daemon', () => {
  const warnings: string[] = [];
  const reader = () => createHoldLimitsReader(dir, (line) => warnings.push(line));
  beforeEach(() => {
    warnings.length = 0;
  });

  it('applies the built-in defaults without a file, without a warning', () => {
    expect(reader()()).toEqual({ perPeer: 5, perMachine: 10 });
    expect(warnings).toEqual([]);
  });

  it('follows a change of the file at the next read, without a restart', () => {
    const read = reader();
    expect(read().perPeer).toBe(5);
    writeFileSync(holdLimitsFile(dir), JSON.stringify({ v: 1, perPeer: 2, perMachine: 4 }));
    expect(read()).toEqual({ perPeer: 2, perMachine: 4 });
    rmSync(holdLimitsFile(dir));
    expect(read()).toEqual({ perPeer: 5, perMachine: 10 });
    expect(warnings).toEqual([]);
  });

  it('an invalid value is a loud warning and the built-in default applies for that value only; the warning is not repeated', () => {
    writeFileSync(holdLimitsFile(dir), JSON.stringify({ v: 1, perPeer: 99, perMachine: 7 }));
    const read = reader();
    expect(read()).toEqual({ perPeer: 5, perMachine: 7 });
    read();
    read();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/^\[warn\] .*hold-limits\.json: "perPeer" must be a whole number from 1 to 20, got 99.*built-in default applies/);
  });

  it('a file that is not JSON is a warning and the built-in defaults', () => {
    writeFileSync(holdLimitsFile(dir), '{ nope');
    expect(reader()()).toEqual({ perPeer: 5, perMachine: 10 });
    expect(warnings[0]).toMatch(/\[warn\].*not valid JSON/);
  });

  it('a per-machine value below the per-peer one is raised to it, with a warning', () => {
    writeFileSync(holdLimitsFile(dir), JSON.stringify({ v: 1, perPeer: 12 }));
    expect(reader()()).toEqual({ perPeer: 12, perMachine: 12 });
    expect(warnings[0]).toMatch(/must be at least the limit per peer/);
  });

  it('feeds a HoldTable: a change of the file is applied at the next admission', () => {
    const table = new HoldTable(reader());
    const admit = (id: string) => table.admit({ id, peer: 'p1', shell: 'sh', command: 'ls', now: 1000, requestedSeconds: 60, capSeconds: 600 });
    for (const id of ['a', 'b', 'c', 'd', 'e']) expect(admit(id).ok).toBe(true);
    expect(admit('f')).toMatchObject({ ok: false, reason: 'hold-limit-peer' });
    writeFileSync(holdLimitsFile(dir), JSON.stringify({ v: 1, perPeer: 6 }));
    expect(admit('f').ok).toBe(true);
  });
});
