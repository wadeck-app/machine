import { existsSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { parseHoldLimits, readHoldLimits, resolveHoldLimits, serializeHoldLimits, type EffectiveHoldLimits, type HoldLimitsSetting } from '@wadeck-app/machine-core';
import { withFileLock, writeFileAtomic } from './fsutil.js';

// <configDir>/hold-limits.json: how many requests this machine HOLDS (`machine run --wait` of its peers): per calling peer and in all. Public data
// (no secret), unsigned, LOCAL: only the owner of this machine writes it (`machine hold-limits`); nothing a peer sends or a signed policy carries
// can change it (threat model T-64). Read by the daemon at start and at each admission of a hold.

export const holdLimitsFile = (configDir: string): string => join(configDir, 'hold-limits.json');

/** The file cannot be read as it is: the message names the path, the cause and the way out. */
export class HoldLimitsError extends Error {}

const unusable = (file: string, why: string): HoldLimitsError =>
  new HoldLimitsError(
    `${file} cannot be used (${why}): it holds how many requests this machine keeps waiting for approval, nothing secret. Run \`machine hold-limits --reset\` to delete it and go back to the built-in defaults (5 per peer, 10 per machine), or edit the field named above`,
  );

function parseFile(file: string): { setting: HoldLimitsSetting; problems: string[] } {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch (e) {
    return { setting: { v: 1 }, problems: [(e as NodeJS.ErrnoException).code === undefined ? 'not valid JSON' : `cannot be read: ${(e as Error).message}`] };
  }
  return readHoldLimits(raw);
}

/** Undefined when the file does not exist (not set: the built-in defaults apply). A file that does not validate stops the command. */
export function readHoldLimitsSetting(configDir: string): HoldLimitsSetting | undefined {
  const file = holdLimitsFile(configDir);
  if (!existsSync(file)) {
    return undefined;
  }
  const { setting, problems } = parseFile(file);
  if (problems.length > 0) {
    throw unusable(file, problems[0] ?? 'invalid');
  }
  return setting;
}

/** One locked read-modify-write. The result is validated (ranges and per machine >= per peer) before anything is written. */
export function updateHoldLimits(configDir: string, change: { perPeer?: number; perMachine?: number }): HoldLimitsSetting {
  const file = holdLimitsFile(configDir);
  return withFileLock(file, () => {
    const current = readHoldLimitsSetting(configDir) ?? { v: 1 as const };
    let next: HoldLimitsSetting;
    try {
      next = parseHoldLimits({ ...current, ...change });
    } catch (e) {
      throw new HoldLimitsError(`${(e as Error).message}; nothing was saved`);
    }
    writeFileAtomic(file, serializeHoldLimits(next), 0o644);
    return next;
  });
}

/** True when there was a file to delete. */
export function clearHoldLimits(configDir: string): boolean {
  const file = holdLimitsFile(configDir);
  return withFileLock(file, () => {
    if (!existsSync(file)) {
      return false;
    }
    rmSync(file);
    return true;
  });
}

export interface HoldLimitsView {
  setting: HoldLimitsSetting | undefined;
  limits: EffectiveHoldLimits;
  /** A hand-edited file the daemon does not fully apply (a per-machine value below the per-peer one). */
  problems: string[];
}

export function holdLimitsView(configDir: string): HoldLimitsView {
  const setting = readHoldLimitsSetting(configDir);
  const resolved = resolveHoldLimits(setting);
  return { setting, limits: resolved.limits, problems: resolved.problems };
}

/**
 * The limits the daemon applies, read at each admission with a cheap stat cache (the file is parsed again only when its size or modification time
 * changed), so a change by the owner needs no restart. A missing file is the built-in defaults. An invalid or unreadable file is a loud `[warn]`
 * (once per state of the file) and the built-in default applies ONLY for the value concerned, the reason named. Never throws.
 */
export function createHoldLimitsReader(configDir: string, warn: (line: string) => void): () => { perPeer: number; perMachine: number } {
  const file = holdLimitsFile(configDir);
  let key: string | undefined;
  let cached = resolveHoldLimits(undefined).limits;
  return () => {
    let nextKey: string;
    try {
      const stat = statSync(file);
      nextKey = `${stat.size}:${stat.mtimeMs}`;
    } catch (e) {
      nextKey = (e as NodeJS.ErrnoException).code === 'ENOENT' ? 'absent' : `error:${(e as Error).message}`;
    }
    if (nextKey !== key) {
      key = nextKey;
      if (nextKey === 'absent') {
        cached = resolveHoldLimits(undefined).limits;
      } else if (nextKey.startsWith('error:')) {
        warn(`[warn] ${file} cannot be read (${nextKey.slice(6)}): the built-in hold limits apply (5 per peer, 10 per machine). Fix the permissions of the file, or run \`machine hold-limits --reset\``);
        cached = resolveHoldLimits(undefined).limits;
      } else {
        const { setting, problems } = parseFile(file);
        const resolved = resolveHoldLimits(setting);
        for (const problem of [...problems, ...resolved.problems]) {
          warn(`[warn] ${file}: ${problem}. The built-in default applies in place of that value only. Fix it with \`machine hold-limits\`, or \`machine hold-limits --reset\``);
        }
        cached = resolved.limits;
      }
    }
    return { perPeer: cached.perPeer, perMachine: cached.perMachine };
  };
}
