import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { guardUpdates, loadUpdateStarts, recordUpdateStart, staleUpdateProblem, updateStartLoopProblem } from './updateGuard.js';

// Port of orch's update-guard tests. Two guards, independent of the cause: an update that did not change the running
// version stops the automatic updates and says why; updates that restart the daemon too often stop them as well.

const OLD = '2026.11.14-570-7f35aaa1';
const NEW = '2026.11.14-571-169e111c';
const BUNDLE = 'C:\\App\\nvm\\v24\\node_modules\\@wadeck-app\\machine-cli\\machine.cjs';
const MIN = 60_000;
const NOW = Date.parse('2026-11-14T12:00:00Z');

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop() as string, { recursive: true, force: true });
});
function startsFile(): string {
  const dir = mkdtempSync(join(tmpdir(), 'machine-update-guard-'));
  dirs.push(dir);
  return join(dir, 'update-starts.json');
}

describe('staleUpdateProblem', () => {
  it('nothing to say when the daemon runs the version the update installed', () => {
    expect(staleUpdateProblem(NEW, { status: 'success', targetVersion: NEW }, BUNDLE)).toBeNull();
  });

  it('says both versions, where the daemon runs from and the way out, when they differ', () => {
    const problem = staleUpdateProblem(OLD, { status: 'success', targetVersion: NEW }, BUNDLE);
    expect(problem).not.toBeNull();
    expect(problem).toContain(OLD);
    expect(problem).toContain(NEW);
    expect(problem).toContain(BUNDLE);
    expect(problem).toMatch(/machine stop/);
    expect(problem).toMatch(/machine startup enable/);
    expect(problem).toMatch(/automatic updates are suspended/i);
  });

  it('reads the version from newVersion when targetVersion is absent', () => {
    expect(staleUpdateProblem(OLD, { status: 'success', newVersion: NEW }, BUNDLE)).not.toBeNull();
    expect(staleUpdateProblem(NEW, { status: 'success', newVersion: NEW }, BUNDLE)).toBeNull();
  });

  it('only a successful update can be stale', () => {
    for (const state of [null, { status: 'rolled-back', previousVersion: OLD }, { status: 'failed', error: 'x' }, { status: 'applying', targetVersion: NEW }]) {
      expect(staleUpdateProblem(OLD, state, BUNDLE), JSON.stringify(state)).toBeNull();
    }
  });

  it('a success without any version is not a mismatch we can name', () => {
    expect(staleUpdateProblem(OLD, { status: 'success' }, BUNDLE)).toBeNull();
  });

  it('a development build never updates, so it has nothing to compare', () => {
    expect(staleUpdateProblem('0.1.0', { status: 'success', targetVersion: NEW }, BUNDLE)).toBeNull();
  });
});

describe('updateStartLoopProblem', () => {
  it('two restarts after an update in half an hour are fine', () => {
    expect(updateStartLoopProblem([NOW - 20 * MIN, NOW - 1 * MIN], NOW)).toBeNull();
  });

  it('three in half an hour are a loop, said with the count and the way out', () => {
    const problem = updateStartLoopProblem([NOW - 25 * MIN, NOW - 10 * MIN, NOW - 1 * MIN], NOW);
    expect(problem).toMatch(/3 times in the last 30 minutes/);
    expect(problem).toMatch(/automatic updates are suspended/i);
    expect(problem).toMatch(/machine cli self-check/);
  });

  it('a start dated in the future (the clock went back) does not count as recent forever', () => {
    expect(updateStartLoopProblem([NOW + 10 * 24 * 60 * MIN, NOW + 10 * 24 * 60 * MIN, NOW - 1 * MIN], NOW)).toBeNull();
  });

  it('restarts older than the window are forgotten', () => {
    expect(updateStartLoopProblem([NOW - 90 * MIN, NOW - 80 * MIN, NOW - 70 * MIN, NOW - 1 * MIN], NOW)).toBeNull();
  });
});

describe('the record of the starts that followed an update', () => {
  it('a missing file is an empty record, without a complaint', () => {
    expect(loadUpdateStarts(startsFile())).toEqual({ starts: [], problem: null });
  });

  it('a start is recorded, and what is older than the window goes', () => {
    const f = startsFile();
    recordUpdateStart(f, NOW - 120 * MIN);
    expect(recordUpdateStart(f, NOW - 5 * MIN)).toEqual([NOW - 5 * MIN]);
    expect(loadUpdateStarts(f).starts).toEqual([NOW - 5 * MIN]);
  });

  it('a start dated in the future is dropped from the record when the next one is written', () => {
    const f = startsFile();
    writeFileSync(f, JSON.stringify([NOW + 10 * 24 * 60 * MIN]));
    expect(recordUpdateStart(f, NOW)).toEqual([NOW]);
  });

  it('records accumulate inside the window', () => {
    const f = startsFile();
    recordUpdateStart(f, NOW - 10 * MIN);
    recordUpdateStart(f, NOW - 5 * MIN);
    expect(recordUpdateStart(f, NOW)).toEqual([NOW - 10 * MIN, NOW - 5 * MIN, NOW]);
  });

  it('a corrupt file is reported with its path and counts as empty', () => {
    const f = startsFile();
    writeFileSync(f, '{not json');
    const loaded = loadUpdateStarts(f);
    expect(loaded.starts).toEqual([]);
    expect(loaded.problem).toContain(f);
  });

  it('a file that is valid JSON but not a list of times is reported', () => {
    const f = startsFile();
    writeFileSync(f, '{"a":1}');
    expect(loadUpdateStarts(f).problem).toMatch(/does not hold a list of times/);
  });

  it('an unreadable file (a folder in its place) is reported, never silently empty', () => {
    const f = startsFile();
    mkdirSync(f);
    expect(loadUpdateStarts(f).problem).toMatch(/cannot be read/);
  });
});

describe('guardUpdates', () => {
  function setup() {
    const logs: string[] = [];
    const file = startsFile();
    const call = (state: Parameters<typeof guardUpdates>[0]['state'], version: string = OLD) =>
      guardUpdates({ version, state, bundlePath: BUNDLE, startsFile: file, now: NOW, log: (l) => logs.push(l) });
    return { call, logs, file };
  }

  it('no update state: nothing suspended, recorded or said', () => {
    const { call, logs, file } = setup();
    expect(call(null)).toBeNull();
    expect(existsSync(file)).toBe(false);
    expect(logs).toEqual([]);
  });

  it('an update that took effect is recorded as a start and suspends nothing', () => {
    const { call, logs, file } = setup();
    expect(call({ status: 'success', targetVersion: OLD, timestamp: NOW })).toBeNull();
    expect(loadUpdateStarts(file).starts).toEqual([NOW]);
    expect(logs).toEqual([]);
  });

  it('an update that did not change the running version suspends the updates and says so as an error', () => {
    const { call, logs } = setup();
    const why = call({ status: 'success', targetVersion: NEW, timestamp: NOW });
    expect(why).toContain(NEW);
    expect(logs.some((l) => l.startsWith('ERROR automatic updates suspended: ') && l.includes(why as string))).toBe(true);
  });

  it('the third restart by an update inside half an hour suspends the updates even though each took effect', () => {
    const { call, logs, file } = setup();
    writeFileSync(file, JSON.stringify([NOW - 20 * MIN, NOW - 10 * MIN]));
    expect(call({ status: 'success', targetVersion: OLD, timestamp: NOW })).toMatch(/3 times in the last 30 minutes/);
    expect(logs.some((l) => l.startsWith('ERROR automatic updates suspended: '))).toBe(true);
    expect(loadUpdateStarts(file).starts).toHaveLength(3);
  });

  it('when both guards fire, the version mismatch is the one said: it names the cause', () => {
    const { call, file } = setup();
    writeFileSync(file, JSON.stringify([NOW - 20 * MIN, NOW - 10 * MIN]));
    expect(call({ status: 'success', targetVersion: NEW, timestamp: NOW })).toMatch(/machine stop/);
  });

  it('a record that cannot be read is said, and the daemon goes on with an empty one', () => {
    const { call, logs, file } = setup();
    writeFileSync(file, '{not json');
    expect(call({ status: 'success', targetVersion: OLD, timestamp: NOW })).toBeNull();
    expect(logs.some((l) => l.includes(file) && /not valid JSON/.test(l))).toBe(true);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual([NOW]);
  });

  it('a record that cannot be written is said and does not stop the daemon', () => {
    const { call, logs, file } = setup();
    mkdirSync(file);
    expect(() => call({ status: 'success', targetVersion: OLD, timestamp: NOW })).not.toThrow();
    expect(logs.some((l) => l.includes(file) && /could not be written/.test(l))).toBe(true);
  });
});
