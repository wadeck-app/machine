import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseConnections, serializeConnections, type Connections, type PeerConnection } from '@wadeck-app/machine-core';
import { withFileLock, writeFileAtomic } from './fsutil.js';

// <configDir>/connections.json (decision 62): how THIS machine reaches each peer. Public data (no secret), unsigned, local to the caller.

export const connectionsFile = (configDir: string): string => join(configDir, 'connections.json');

/** The file cannot be read as it is: the message names the path, the cause and the way out. */
export class ConnectionsError extends Error {}

const unusable = (file: string, why: string): ConnectionsError =>
  new ConnectionsError(
    `${file} cannot be used (${why}): it holds how this machine reaches each peer (pinned addresses, wake settings), nothing secret. Edit it to fix the field named above, or delete it to go back to the addresses of the relay (the pinned addresses and wake settings are then lost)`,
  );

/** A missing file is an empty configuration: every peer is reached directly. A file that does not validate stops the command. */
export function readConnections(configDir: string): Connections {
  const file = connectionsFile(configDir);
  if (!existsSync(file)) return { v: 1, peers: {} };
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    throw unusable(file, 'not valid JSON');
  }
  try {
    return parseConnections(raw);
  } catch (e) {
    throw unusable(file, (e as Error).message);
  }
}

/**
 * One locked read-modify-write of one peer's entry. `change` gets the current entry (or undefined) and returns the new one; the result is
 * validated before anything is written, so an invalid change leaves the file as it was.
 */
export function updateConnection(configDir: string, uuid: string, change: (current: PeerConnection | undefined) => PeerConnection): PeerConnection {
  const file = connectionsFile(configDir);
  return withFileLock(file, () => {
    const all = readConnections(configDir);
    const next = change(all.peers[uuid]);
    // The same validation as reading: what is written can always be read back.
    const checked = parseConnections({ v: 1, peers: { ...all.peers, [uuid]: next } });
    writeFileAtomic(file, serializeConnections(checked), 0o644);
    return checked.peers[uuid] as PeerConnection;
  });
}

/** True when there was an entry to remove. */
export function removeConnection(configDir: string, uuid: string): boolean {
  const file = connectionsFile(configDir);
  return withFileLock(file, () => {
    const all = readConnections(configDir);
    if (!(uuid in all.peers)) return false;
    const { [uuid]: _removed, ...rest } = all.peers;
    writeFileAtomic(file, serializeConnections({ v: 1, peers: rest }), 0o644);
    return true;
  });
}
