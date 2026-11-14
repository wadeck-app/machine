import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

// Two small records the updater keeps next to update-state.json. Plain fs on purpose: the updater runs from the install it is about to
// replace and must not import a machine runtime module.

/** The update is installed but its post-update (startup job refresh, daemon restart) failed: the next updater run retries it. */
export const POST_UPDATE_PENDING_FILE = 'post-update-pending.json';
/** The last update to this version failed or was rolled back: it is not retried automatically (`machine cli update` forces it). */
export const UPDATE_BLOCKED_FILE = 'update-blocked.json';

export interface PendingPostUpdate {
  targetVersion: string;
  error: string;
  timestamp: number;
}

export interface BlockedUpdate {
  version: string;
  error: string;
  timestamp: number;
  /** The skip was already logged: said once, not every 30 minutes. */
  skipLogged?: boolean;
}

export interface UpdateRecords {
  readPending(): PendingPostUpdate | null;
  writePending(pending: PendingPostUpdate): void;
  clearPending(): void;
  readBlocked(): BlockedUpdate | null;
  writeBlocked(blocked: BlockedUpdate): void;
  clearBlocked(): void;
}

function readJson<T>(file: string, valid: (value: unknown) => value is T): T | null {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new Error(`${file} cannot be read (${(e as Error).message}): delete it if it is not needed`);
  }
  try {
    const parsed: unknown = JSON.parse(text);
    if (valid(parsed)) return parsed;
  } catch {
    // Reported below with the same message.
  }
  throw new Error(`${file} is not a valid record: delete it, the updater writes it again when needed`);
}

function write(file: string, value: unknown): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  renameSync(tmp, file);
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;
const isPending = (v: unknown): v is PendingPostUpdate => isObject(v) && typeof v.targetVersion === 'string' && typeof v.error === 'string' && typeof v.timestamp === 'number';
const isBlocked = (v: unknown): v is BlockedUpdate => isObject(v) && typeof v.version === 'string' && typeof v.error === 'string' && typeof v.timestamp === 'number';

/** Reads throw on a file that is there but unusable (the caller logs it and goes on); a missing file is null. */
export function createUpdateRecords(configDir: string): UpdateRecords {
  const pendingFile = join(configDir, POST_UPDATE_PENDING_FILE);
  const blockedFile = join(configDir, UPDATE_BLOCKED_FILE);
  return {
    readPending: () => readJson(pendingFile, isPending),
    writePending: (pending) => write(pendingFile, pending),
    clearPending: () => rmSync(pendingFile, { force: true }),
    readBlocked: () => readJson(blockedFile, isBlocked),
    writeBlocked: (blocked) => write(blockedFile, blocked),
    clearBlocked: () => rmSync(blockedFile, { force: true }),
  };
}
