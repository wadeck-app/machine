import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { writeFileAtomic } from './fsutil.js';

export const DAEMON_PORT_FILENAME = 'daemon.port.json';

export interface DaemonPortInfo {
  pid: number;
  port: number;
  peerPort: number;
}

export function daemonPortFile(configDir: string): string {
  return join(configDir, DAEMON_PORT_FILENAME);
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
