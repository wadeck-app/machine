import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { verifyAuditChain } from '@wadeck-app/machine-core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ConnectionsError, connectionsFile, readConnections, removeConnection, updateConnection } from './connectionsStore.js';
import { WakeStateError, readWakeState, recordWake, wakeStateFile } from './wakeState.js';
import { WakeAuditError, wakeAuditFile, writeWakeAudit } from './wakeAudit.js';

const UUID = '3f2a9c10-1b2c-4d3e-8f40-0123456789ab';
const OTHER = '4f2a9c10-1b2c-4d3e-8f40-0123456789ab';
let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'machine-wake-stores-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('connections.json', () => {
  it('a missing file is an empty configuration (every peer is direct)', () => {
    expect(readConnections(dir)).toEqual({ v: 1, peers: {} });
  });

  it('updateConnection writes it atomically and reads it back, keeping the other peers', () => {
    updateConnection(dir, UUID, () => ({ type: 'direct', addresses: [{ host: '192.168.1.40', port: 47921 }] }));
    updateConnection(dir, OTHER, () => ({ type: 'ping-if-not-reachable-magic-packet', wake: { mac: 'aa:bb:cc:dd:ee:01' } }));
    const c = readConnections(dir);
    expect(Object.keys(c.peers).sort()).toEqual([UUID, OTHER]);
    expect(c.peers[UUID]?.addresses).toEqual([{ host: '192.168.1.40', port: 47921 }]);
    expect(existsSync(connectionsFile(dir))).toBe(true);
  });

  it('the updater receives the current entry (merge of a partial change) and may not return an invalid one', () => {
    updateConnection(dir, UUID, () => ({ type: 'direct', addresses: [{ host: '192.168.1.40', port: 1 }] }));
    updateConnection(dir, UUID, (current) => ({ ...(current as object), type: 'direct', wake: { mac: 'aa:bb:cc:dd:ee:01' } }) as never);
    expect(readConnections(dir).peers[UUID]).toEqual({ type: 'direct', addresses: [{ host: '192.168.1.40', port: 1 }], wake: { mac: 'aa:bb:cc:dd:ee:01' } });
    expect(() => updateConnection(dir, UUID, () => ({ type: 'ping-if-not-reachable-magic-packet' }) as never)).toThrow(/needs "wake"/);
    // The invalid entry was not written.
    expect(readConnections(dir).peers[UUID]?.type).toBe('direct');
  });

  it('removeConnection says whether there was an entry', () => {
    updateConnection(dir, UUID, () => ({ type: 'direct' }));
    expect(removeConnection(dir, UUID)).toBe(true);
    expect(removeConnection(dir, UUID)).toBe(false);
    expect(readConnections(dir).peers).toEqual({});
  });

  it('a corrupt file stops with the path, the cause and the fix; nothing is overwritten', () => {
    writeFileSync(connectionsFile(dir), '{ not json');
    let e: unknown;
    try {
      readConnections(dir);
    } catch (x) {
      e = x;
    }
    expect(e).toBeInstanceOf(ConnectionsError);
    expect((e as Error).message).toContain(connectionsFile(dir));
    expect((e as Error).message).toMatch(/not valid JSON/);
    expect((e as Error).message).toMatch(/edit it|delete it/);
    expect(() => updateConnection(dir, UUID, () => ({ type: 'direct' }))).toThrow(/not valid JSON/);
    expect(readFileSync(connectionsFile(dir), 'utf8')).toBe('{ not json');
  });

  it('an unknown field stops with the path and the field', () => {
    writeFileSync(connectionsFile(dir), JSON.stringify({ v: 1, peers: { [UUID]: { type: 'direct', command: 'ssh -W %h:%p jump' } } }));
    expect(() => readConnections(dir)).toThrow(new RegExp(`${connectionsFile(dir).replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')}.*unknown field "command"`, 's'));
  });
});

describe('wake-state.json (cooldown)', () => {
  it('has no record before any wake', () => {
    expect(readWakeState(dir)).toEqual({ v: 1, peers: {} });
  });

  it('records the time of the last wake per peer and keeps the others', () => {
    recordWake(dir, UUID, 1000);
    recordWake(dir, OTHER, 2000);
    recordWake(dir, UUID, 3000);
    expect(readWakeState(dir).peers).toEqual({ [UUID]: { lastWakeAt: 3000 }, [OTHER]: { lastWakeAt: 2000 } });
  });

  it('holds no secret: only uuids and times', () => {
    recordWake(dir, UUID, 1000);
    expect(readFileSync(wakeStateFile(dir), 'utf8')).toBe(`${JSON.stringify({ v: 1, peers: { [UUID]: { lastWakeAt: 1000 } } }, null, 2)}\n`);
  });

  it('a corrupt file stops with the path and the fix', () => {
    writeFileSync(wakeStateFile(dir), '[]');
    expect(() => readWakeState(dir)).toThrow(WakeStateError);
    expect(() => readWakeState(dir)).toThrow(new RegExp(wakeStateFile(dir).replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')));
    expect(() => readWakeState(dir)).toThrow(/delete it/i);
    writeFileSync(wakeStateFile(dir), JSON.stringify({ v: 1, peers: { [UUID]: { lastWakeAt: 'yesterday' } } }));
    expect(() => readWakeState(dir)).toThrow(/lastWakeAt/);
  });
});

describe('wake-audit.log (hash-chained)', () => {
  it('appends entries that verify as one chain, across separate writes (separate processes reopen the file)', () => {
    writeWakeAudit(dir, { event: 'wake.packet', n: 1 });
    writeWakeAudit(dir, { event: 'wake.packet', n: 2 });
    writeWakeAudit(dir, { event: 'wake.result', outcome: 'answered' });
    const lines = readFileSync(wakeAuditFile(dir), 'utf8').trimEnd().split('\n');
    expect(lines).toHaveLength(3);
    expect(verifyAuditChain(lines)).toMatchObject({ ok: true, entries: 3 });
  });

  it('refuses to write into a log that was edited, and says where it is and what to do', () => {
    writeWakeAudit(dir, { event: 'wake.packet', n: 1 });
    writeWakeAudit(dir, { event: 'wake.packet', n: 2 });
    const text = readFileSync(wakeAuditFile(dir), 'utf8').replace('"n":1', '"n":9');
    writeFileSync(wakeAuditFile(dir), text);
    let e: unknown;
    try {
      writeWakeAudit(dir, { event: 'wake.result' });
    } catch (x) {
      e = x;
    }
    expect(e).toBeInstanceOf(WakeAuditError);
    expect((e as Error).message).toContain(wakeAuditFile(dir));
    expect((e as Error).message).toMatch(/no packet was sent/i);
    expect((e as Error).message).toMatch(/move it away/);
  });

  it('is a file of its own: the audit log of the daemon is never touched (its chain head lives in the daemon)', () => {
    writeWakeAudit(dir, { event: 'wake.packet' });
    expect(wakeAuditFile(dir)).not.toBe(join(dir, 'audit.log'));
    expect(existsSync(join(dir, 'audit.log'))).toBe(false);
  });
});
