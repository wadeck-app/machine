import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RunDefaultsError, clearRunDefaults, readRunDefaults, runDefaultsFile, updateRunDefaults } from './runDefaultsStore.js';

// <configDir>/run-defaults.json: the machine setting of `machine run` (what to do when the target does not allow the command yet).

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'machine-run-defaults-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('run-defaults.json', () => {
  it('a missing file is "not set": undefined, the built-in default applies', () => {
    expect(readRunDefaults(dir)).toBeUndefined();
  });

  it('updateRunDefaults writes and merges field by field', () => {
    expect(updateRunDefaults(dir, { onRefusal: 'fail' })).toEqual({ v: 1, onRefusal: 'fail' });
    expect(updateRunDefaults(dir, { waitSeconds: 900 })).toEqual({ v: 1, onRefusal: 'fail', waitSeconds: 900 });
    expect(readRunDefaults(dir)).toEqual({ v: 1, onRefusal: 'fail', waitSeconds: 900 });
    expect(JSON.parse(readFileSync(runDefaultsFile(dir), 'utf8'))).toEqual({ v: 1, onRefusal: 'fail', waitSeconds: 900 });
  });

  it('an invalid change is refused and the file stays as it was', () => {
    updateRunDefaults(dir, { onRefusal: 'wait' });
    expect(() => updateRunDefaults(dir, { waitSeconds: 5 })).toThrow(/"waitSeconds"/);
    expect(readRunDefaults(dir)).toEqual({ v: 1, onRefusal: 'wait' });
  });

  it('clearRunDefaults removes the file and says whether there was one', () => {
    updateRunDefaults(dir, { onRefusal: 'fail' });
    expect(clearRunDefaults(dir)).toBe(true);
    expect(existsSync(runDefaultsFile(dir))).toBe(false);
    expect(clearRunDefaults(dir)).toBe(false);
  });

  it.each([
    ['not JSON', '{ not json', /not valid JSON/],
    ['a wrong field', JSON.stringify({ v: 1, onRefusal: 'retry' }), /"onRefusal"/],
    ['an unknown field', JSON.stringify({ v: 1, extra: true }), /unknown field "extra"/],
    ['an empty file', '', /not valid JSON/],
  ])('a damaged file (%s) stops with the path, the cause and the fix; nothing is overwritten and nothing falls back', (_name, text, cause) => {
    writeFileSync(runDefaultsFile(dir), text);
    let error: unknown;
    try {
      readRunDefaults(dir);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(RunDefaultsError);
    const message = (error as Error).message;
    expect(message).toContain(runDefaultsFile(dir));
    expect(message).toMatch(cause);
    expect(message).toMatch(/machine run-defaults --reset/);
    expect(() => updateRunDefaults(dir, { onRefusal: 'fail' })).toThrow(RunDefaultsError);
    expect(readFileSync(runDefaultsFile(dir), 'utf8')).toBe(text);
  });
});
