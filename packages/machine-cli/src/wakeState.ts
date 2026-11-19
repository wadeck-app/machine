import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isUuid } from '@wadeck-app/machine-core';
import { withFileLock, writeFileAtomic } from './fsutil.js';

// <configDir>/wake-state.json: when each peer was last woken from this machine (the cooldown between two wake runs). Uuids and times only.
// A same-user process can reset it (AR-5): the cooldown limits a loop of commands, not a local attacker.

export const wakeStateFile = (configDir: string): string => join(configDir, 'wake-state.json');

export interface WakeState {
  v: 1;
  peers: Record<string, { lastWakeAt: number }>;
}

export class WakeStateError extends Error {}

const unusable = (file: string, why: string): WakeStateError =>
  new WakeStateError(`${file} cannot be used (${why}): it remembers when each peer was last woken (the cooldown), nothing secret. Delete it: the cooldown then starts again from nothing`);

export function readWakeState(configDir: string): WakeState {
  const file = wakeStateFile(configDir);
  if (!existsSync(file)) return { v: 1, peers: {} };
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    throw unusable(file, 'not valid JSON');
  }
  const o = raw as { v?: unknown; peers?: unknown } | null;
  if (typeof o !== 'object' || o === null || Array.isArray(o) || o.v !== 1 || typeof o.peers !== 'object' || o.peers === null || Array.isArray(o.peers)) throw unusable(file, 'unexpected shape');
  const peers: WakeState['peers'] = {};
  for (const [uuid, value] of Object.entries(o.peers as Record<string, unknown>)) {
    const at = (value as { lastWakeAt?: unknown } | null)?.lastWakeAt;
    if (!isUuid(uuid) || typeof at !== 'number' || !Number.isFinite(at)) throw unusable(file, `the entry of ${uuid} needs a numeric lastWakeAt`);
    peers[uuid.toLowerCase()] = { lastWakeAt: at };
  }
  return { v: 1, peers };
}

/** Remembers `epochSeconds` as the last wake of `uuid` (one locked read-modify-write). */
export function recordWake(configDir: string, uuid: string, epochSeconds: number): void {
  const file = wakeStateFile(configDir);
  withFileLock(file, () => {
    const state = readWakeState(configDir);
    state.peers[uuid] = { lastWakeAt: epochSeconds };
    writeFileAtomic(file, `${JSON.stringify(state, null, 2)}\n`, 0o644);
  });
}
