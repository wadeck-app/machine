import { describe, expect, it } from 'vitest';
import { APPLYING_STALE_MS, isPidAlive, updateNotice } from './updateNotice.js';

// Port of orch's update-notice tests. update-state.json can hold 'applying' (journaled before npm runs): an interrupted
// install must say so instead of being dropped in silence.

const NOW = 1_800_000_000_000;
const alive = () => true;
const dead = () => false;

describe('terminal states', () => {
  it('success', () => {
    expect(updateNotice({ status: 'success', targetVersion: '2026.1.1-001-aaaaaaaa', timestamp: NOW }, { now: NOW, isAlive: alive })?.text).toBe('Updated to v2026.1.1-001-aaaaaaaa');
  });
  it('rolled-back', () => {
    expect(updateNotice({ status: 'rolled-back', previousVersion: '1.0.0', timestamp: NOW }, { now: NOW, isAlive: alive })?.text).toBe('Rollback to v1.0.0');
  });
  it('failed carries the reason, which can be a manual fix command', () => {
    const n = updateNotice({ status: 'failed', error: 'Fix manually: npm install -g x@1', timestamp: NOW }, { now: NOW, isAlive: alive });
    expect(n).toEqual({ level: 'warn', text: 'Update failed (Fix manually: npm install -g x@1)' });
  });
  it('states that are not news are silent', () => {
    expect(updateNotice({ status: 'update-available', timestamp: NOW }, { now: NOW, isAlive: alive })).toBeNull();
    expect(updateNotice(null, { now: NOW, isAlive: alive })).toBeNull();
  });
});

describe('applying', () => {
  const applying = { status: 'applying', pid: 4242, previousVersion: '2026.1.1-001-aaaaaaaa', targetVersion: '2026.2.2-002-bbbbbbbb', timestamp: NOW - 5_000 };

  it('with a live updater it is in progress, not a failure', () => {
    const n = updateNotice(applying, { now: NOW, isAlive: alive });
    expect(n?.level).toBe('info');
    expect(n?.text).toMatch(/update to v2026\.2\.2-002-bbbbbbbb is in progress \(pid 4242\)/);
  });

  it('with a dead updater it is an interrupted install, says how it is repaired and the machine commands', () => {
    const n = updateNotice(applying, { now: NOW, isAlive: dead });
    expect(n?.level).toBe('warn');
    expect(n?.text).toMatch(/interrupted/);
    expect(n?.text).toMatch(/v2026\.2\.2-002-bbbbbbbb/);
    expect(n?.text).toMatch(/machine cli update/);
    expect(n?.text).toMatch(/npm install -g @wadeck-app\/machine-cli@latest/);
  });

  it('a live pid on a record older than the staleness window is a recycled pid: interrupted', () => {
    expect(updateNotice({ ...applying, timestamp: NOW - APPLYING_STALE_MS - 1 }, { now: NOW, isAlive: alive })?.text).toMatch(/interrupted/);
  });

  it('a dead updater whose npm is still running says the repair waits for it', () => {
    const n = updateNotice({ ...applying, npmPid: 777, npmStartedAt: NOW - 3_000 }, { now: NOW, isAlive: (pid) => pid === 777 });
    expect(n?.text).toMatch(/npm \(pid 777\) is still running/);
    expect(n?.text).toMatch(/waits for it/);
  });

  it('a dead updater whose npm is gone does not mention npm', () => {
    expect(updateNotice({ ...applying, npmPid: 777 }, { now: NOW, isAlive: dead })?.text).not.toMatch(/pid 777/);
  });

  it('a record without a pid cannot be called in progress', () => {
    const { pid: _pid, ...noPid } = applying;
    expect(updateNotice(noPid, { now: NOW, isAlive: alive })?.text).toMatch(/interrupted/);
  });

  it('missing versions are shown as unknown rather than "undefined"', () => {
    expect(updateNotice({ status: 'applying', pid: 1, timestamp: NOW }, { now: NOW, isAlive: alive })?.text).not.toMatch(/undefined/);
  });
});

describe('isPidAlive', () => {
  it('the current process is alive, a huge pid is not', () => {
    expect(isPidAlive(process.pid)).toBe(true);
    expect(isPidAlive(2 ** 31 - 2)).toBe(false);
  });
});
