import { join } from 'node:path';
import type { Json } from '@wadeck-app/machine-core';
import { withFileLock } from './fsutil.js';
import { FileAuditLog } from './stores.js';

// Who woke what (decision 62): a hash-chained log on the CALLER, in a file of its own. It is NOT the audit.log of the daemon: that log keeps its
// chain head in the memory of the running daemon, so a second writer would break the chain and the daemon would refuse to reopen it. Same format
// and same verification (T-07). A packet sent is recorded as "sent", never as "woke": only the connection answering says more.

export const wakeAuditFile = (configDir: string): string => join(configDir, 'wake-audit.log');

export class WakeAuditError extends Error {}

/** Appends one entry (a locked append to a chain that is verified first). Throws a `WakeAuditError` when the log cannot take it: the caller must send no packet then. */
export function writeWakeAudit(configDir: string, entry: Record<string, Json>): void {
  const file = wakeAuditFile(configDir);
  try {
    withFileLock(file, () => new FileAuditLog(file).write(entry));
  } catch (e) {
    throw new WakeAuditError(`cannot write the wake audit log: ${(e as Error).message}. No packet was sent: a wake is never sent without its trace`);
  }
}
