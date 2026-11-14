import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { UpdateManager } from '@wadeck-app/shared-cli/UpdateManager';
import { VersionValidation } from '@wadeck-app/shared-cli/VersionValidation';
import { forgetLastUpdate, prepareRollback } from './rollbackRecord.js';
import { LAST_UPDATE_FILE } from './updater/updateRecords.js';

// `machine cli rollback` needs update-state.json (shared-cli), but the daemon consumes that file at its start (readAndClearState deletes
// a terminal state). The durable record of the last successful update is what makes a rollback possible afterwards.

const PREVIOUS = '2026.11.14-590-aaaaaaaa';
const TARGET = '2026.11.14-592-bbbbbbbb';
let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'machine-rollback-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const stateFile = (): string => join(dir, 'update-state.json');
const recordFile = (): string => join(dir, LAST_UPDATE_FILE);
const writeRecord = (over: Record<string, unknown> = {}): void => writeFileSync(recordFile(), JSON.stringify({ previousVersion: PREVIOUS, targetVersion: TARGET, timestamp: 5, ...over }));
const writeState = (): void => writeFileSync(stateFile(), JSON.stringify({ status: 'success', targetVersion: TARGET, previousVersion: PREVIOUS, timestamp: 5 }));

describe('prepareRollback', () => {
  it('after the daemon consumed update-state.json (real UpdateManager.readAndClearState), restores it from the record, loudly', () => {
    writeState();
    writeRecord();
    expect(new UpdateManager('@wadeck-app/machine-cli', dir).readAndClearState()?.status).toBe('success');
    expect(existsSync(stateFile())).toBe(false);

    const r = prepareRollback(dir, TARGET);
    expect(r.restored).toBe(true);
    expect(r.note).toContain(recordFile());
    const restored = JSON.parse(readFileSync(stateFile(), 'utf8')) as { previousVersion: string; status: string };
    expect(restored.previousVersion).toBe(PREVIOUS);
    expect(VersionValidation.VERSION_RE.test(restored.previousVersion)).toBe(true);
  });

  it('leaves an existing update-state.json alone (nothing was consumed)', () => {
    writeState();
    writeRecord();
    const before = readFileSync(stateFile(), 'utf8');
    expect(prepareRollback(dir, TARGET).restored).toBe(false);
    expect(readFileSync(stateFile(), 'utf8')).toBe(before);
  });

  it('with neither the state nor the record, fails with what to do', () => {
    expect(() => prepareRollback(dir, TARGET)).toThrow(/nothing to roll back.*machine cli update.*npm install -g @wadeck-app\/machine-cli@<version>/s);
    expect(existsSync(stateFile())).toBe(false);
  });

  it('refuses a record whose target is not the installed version (already rolled back, or a newer update), and restores nothing', () => {
    writeRecord({ targetVersion: '2026.11.14-500-cccccccc' });
    expect(() => prepareRollback(dir, TARGET)).toThrow(/2026\.11\.14-500-cccccccc.*2026\.11\.14-592-bbbbbbbb.*already rolled back/s);
    expect(existsSync(stateFile())).toBe(false);
  });

  it('refuses an unusable record, naming the file and how to go on', () => {
    writeFileSync(recordFile(), '{not json');
    expect(() => prepareRollback(dir, TARGET)).toThrow(new RegExp(`${LAST_UPDATE_FILE}.*(delete|npm install -g)`, 's'));
    writeRecord({ previousVersion: 'x; rm -rf /' });
    expect(() => prepareRollback(dir, TARGET)).toThrow(/previousVersion/);
  });
});

describe('forgetLastUpdate', () => {
  it('removes the record, and is fine without one', () => {
    writeRecord();
    forgetLastUpdate(dir);
    expect(existsSync(recordFile())).toBe(false);
    expect(() => forgetLastUpdate(dir)).not.toThrow();
  });
});
