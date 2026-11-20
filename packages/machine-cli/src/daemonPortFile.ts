import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { writeFileAtomic } from './fsutil.js';
import { isPidAlive } from './updateNotice.js';

export const DAEMON_PORT_FILENAME = 'daemon.port.json';

export interface DaemonPortInfo {
  pid: number;
  port: number;
  peerPort: number;
}

export function daemonPortFile(configDir: string): string {
  return join(configDir, DAEMON_PORT_FILENAME);
}

/** What `daemon.port.json` says about the local daemon: running (live pid), or not, with the problem found when the file exists but cannot be trusted. */
export type DaemonState = ({ running: true } & DaemonPortInfo) | { running: false; problem?: string };

/**
 * Read only: the same test orch's portFile liveness makes (the file holds a numeric `pid`, the daemon runs while that pid is alive),
 * plus the ports the daemon wrote. No network, nothing started, nothing removed.
 */
export function readDaemonState(configDir: string, isAlive: (pid: number) => boolean = isPidAlive): DaemonState {
  const file = daemonPortFile(configDir);
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { running: false };
    return { running: false, problem: `${file} cannot be read (${(e as Error).message}): check its permissions` };
  }
  let info: Partial<DaemonPortInfo> | null;
  try {
    info = JSON.parse(text) as Partial<DaemonPortInfo> | null;
  } catch {
    return { running: false, problem: `${file} is not valid JSON, so the daemon state is unknown: delete it, then start the daemon again` };
  }
  if (info === null || typeof info !== 'object' || !Number.isInteger(info.pid) || !Number.isInteger(info.port) || !Number.isInteger(info.peerPort)) {
    return { running: false, problem: `${file} does not hold the numeric pid, port and peerPort a daemon writes: delete it, then start the daemon again` };
  }
  const { pid, port, peerPort } = info as DaemonPortInfo;
  if (!isAlive(pid)) return { running: false, problem: `${file} names pid ${pid}, which is not running: the file is stale (the daemon ended without removing it; the next start replaces it)` };
  return { running: true, pid, port, peerPort };
}

/** Written only once the daemon and its listeners are up: orch skips a start while the pid of this file is alive. */
export function writeDaemonPortFile(configDir: string, info: DaemonPortInfo): void {
  const file = daemonPortFile(configDir);
  try {
    writeFileAtomic(file, `${JSON.stringify(info)}\n`, 0o600);
  } catch (e) {
    throw new Error(`cannot write ${file}: ${(e as Error).message} (orch uses it to know the daemon runs; check the folder permissions and that nothing else uses that name)`);
  }
}

/** Removes the file only when it still names this process: a successor daemon may already have written its own. */
export function removeDaemonPortFile(configDir: string, pid: number): void {
  const file = daemonPortFile(configDir);
  try {
    const current = JSON.parse(readFileSync(file, 'utf8')) as { pid?: unknown };
    if (current.pid !== pid) return;
    rmSync(file, { force: true });
  } catch {
    // Missing or unreadable: nothing of ours to remove (a file that is not valid JSON was not written by this daemon).
  }
}
