import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { UpdateManager } from '@wadeck-app/shared-cli/UpdateManager';
import { VersionValidation } from '@wadeck-app/shared-cli/VersionValidation';
import { forgetLastUpdate, prepareRollback, recordUpdateFromState } from './rollbackRecord.js';
import { readUpdateStateReadOnly } from './updateNotice.js';
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

// An update done by an OLDER updater (no last-update.json writing) leaves only update-state.json: the new code records it before it is consumed.
describe('recordUpdateFromState', () => {
  const success = (over: Record<string, unknown> = {}) => ({ status: 'success', targetVersion: TARGET, previousVersion: PREVIOUS, timestamp: 5, ...over });
  const read = () => JSON.parse(readFileSync(recordFile(), 'utf8')) as Record<string, unknown>;

  it('writes the record from a success state', () => {
    expect(recordUpdateFromState(dir, success()).action).toBe('written');
    expect(read()).toEqual({ previousVersion: PREVIOUS, targetVersion: TARGET, timestamp: 5 });
  });

  it('is idempotent and never replaces a newer (or equal) record with an older one', () => {
    writeRecord({ timestamp: 9, previousVersion: '2026.11.14-580-dddddddd' });
    expect(recordUpdateFromState(dir, success({ timestamp: 5 })).action).toBe('kept');
    expect(read().timestamp).toBe(9);
    expect(read().previousVersion).toBe('2026.11.14-580-dddddddd');
    expect(recordUpdateFromState(dir, success({ timestamp: 9 })).action).toBe('kept');
  });

  it('replaces an older record', () => {
    writeRecord({ timestamp: 1, targetVersion: '2026.11.14-500-cccccccc' });
    expect(recordUpdateFromState(dir, success({ timestamp: 5 })).action).toBe('written');
    expect(read().targetVersion).toBe(TARGET);
  });

  it('writes nothing for a state that is not a success', () => {
    for (const status of ['failed', 'rolled-back', 'applying', 'update-available']) {
      expect(recordUpdateFromState(dir, success({ status })).action).toBe('skipped');
    }
    expect(recordUpdateFromState(dir, null).action).toBe('skipped');
    expect(existsSync(recordFile())).toBe(false);
  });

  it('writes nothing, and says why, for a success without a valid previousVersion or target', () => {
    for (const over of [{ previousVersion: undefined }, { previousVersion: 'x; rm -rf /' }, { targetVersion: undefined }, { timestamp: undefined }]) {
      const r = recordUpdateFromState(dir, success(over));
      expect(r.action).toBe('skipped');
      expect(r.reason).toBeDefined();
    }
    expect(existsSync(recordFile())).toBe(false);
  });

  it('an old-updater state consumed by the real readAndClearState leaves a record that makes the rollback work', () => {
    writeState();
    // What the daemon does: record from the state still on disk, then consume it.
    expect(recordUpdateFromState(dir, readUpdateStateReadOnly(dir)).action).toBe('written');
    expect(new UpdateManager('@wadeck-app/machine-cli', dir).readAndClearState()?.status).toBe('success');
    expect(existsSync(stateFile())).toBe(false);
    expect(prepareRollback(dir, TARGET).restored).toBe(true);
    expect((JSON.parse(readFileSync(stateFile(), 'utf8')) as { previousVersion: string }).previousVersion).toBe(PREVIOUS);
  });
});
