import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { VersionValidation } from '@wadeck-app/shared-cli/VersionValidation';
import { writeFileAtomic } from './fsutil.js';
import { createUpdateRecords, LAST_UPDATE_FILE } from './updater/updateRecords.js';

// `machine cli rollback` (shared-cli) reads previousVersion from update-state.json, but the daemon deletes that file at its start. The updater
// keeps the versions of its last successful update in last-update.json; this brings update-state.json back for the shared command.

const PACKAGE = '@wadeck-app/machine-cli';
const BY_HAND = `to go back by hand: npm install -g ${PACKAGE}@<version>, then machine cli post-update`;

export interface PreparedRollback {
  /** True when update-state.json was written from the record (the caller removes it again if the reinstall fails). */
  restored: boolean;
  /** What to tell the user about where the information came from. */
  note?: string;
}

/** Makes sure update-state.json holds what the rollback needs. Throws with the fix when nothing does. */
export function prepareRollback(configDir: string, installedVersion: string): PreparedRollback {
  const stateFile = join(configDir, 'update-state.json');
  if (existsSync(stateFile)) return { restored: false };
  const recordFile = join(configDir, LAST_UPDATE_FILE);
  let last;
  try {
    last = createUpdateRecords(configDir).readLastUpdate();
  } catch (e) {
    throw new Error(`${(e as Error).message}; ${BY_HAND}`);
  }
  if (last === null) {
    throw new Error(`nothing to roll back: neither ${stateFile} nor ${recordFile} exists (no update was installed by \`machine cli update\` or the background updater, or it was already rolled back). Run \`machine cli update\` first, or ${BY_HAND}`);
  }
  if (!VersionValidation.VERSION_RE.test(last.previousVersion)) {
    throw new Error(`${recordFile} has an invalid previousVersion "${last.previousVersion}": delete it, then ${BY_HAND}`);
  }
  if (last.targetVersion !== installedVersion) {
    throw new Error(
      `${recordFile} records an update to v${last.targetVersion}, but v${installedVersion} is installed: it was already rolled back, or a newer update was installed since. ` +
        `Nothing was changed; ${BY_HAND}`,
    );
  }
  writeFileAtomic(stateFile, `${JSON.stringify({ status: 'success', previousVersion: last.previousVersion, currentVersion: last.previousVersion, targetVersion: last.targetVersion, timestamp: last.timestamp })}\n`, 0o600);
  return { restored: true, note: `update-state.json was already consumed (the daemon reads it at its start): rolling back v${last.targetVersion} to v${last.previousVersion} from ${recordFile}` };
}

/** After a successful rollback: the record describes an update that is no longer installed. */
export function forgetLastUpdate(configDir: string): void {
  createUpdateRecords(configDir).clearLastUpdate();
}
