import { existsSync } from 'node:fs';
import { effectiveList, entryText, type PolicyEntry, type SignedPolicy } from '@wadeck-app/machine-core';
import { readAdminPin } from './admin.js';
import { entryDescription } from './allowText.js';
import { policyRecordFile, readPolicyRecord } from './adminAllow.js';

// What the caller knows about the allow list of a machine: the last policy signed on THIS machine (adminAllow.ts writes it). Used by
// `machine allowed <machine>` and by the extra line of a `not-listed` refusal of `machine run`. Nothing here asks the target.

/** The refusal line names at most this many entries (the full list is one command away). */
export const REFUSAL_LIST_CAP = 10;

/** The last line of `machine allowed <peer>`: the policy signed here is not necessarily the one installed there. */
export const REMOTE_VIEW_LINE = (name: string): string => `as installed on ${name}: ask there with machine policy allow --list (remote view: machine requests/policy views are not built yet)`;

/** `commands allowed on X per the policy signed here (v N): sh "ls", ... (machine allowed X)`, at most REFUSAL_LIST_CAP entries. */
export function refusalAllowedLine(machine: string, version: number, entries: PolicyEntry[]): string {
  const shown = entries.slice(0, REFUSAL_LIST_CAP).map((e) => `${e.shell} ${JSON.stringify(entryText(e))}`);
  const more = entries.length > REFUSAL_LIST_CAP ? `, and ${entries.length - REFUSAL_LIST_CAP} more` : '';
  return `commands allowed on ${machine} per the policy signed here (v ${version}): ${shown.length === 0 ? 'nothing for this machine' : `${shown.join(', ')}${more}`} (machine allowed ${machine})`;
}

/**
 * The entries grouped under their shell (the shells in the order of their first entry), each on its own line with its place in the list
 * (`#3`, what `--remove --index 3` takes), the tag `typed` for a template and its lifetime. `used`: calls already counted, when the counter is known.
 */
export function allowedByShell(entries: PolicyEntry[], indent: string, now: number, used?: (entry: PolicyEntry) => number | undefined): string[] {
  if (entries.length === 0) return [`${indent}(nothing)`];
  const shells = [...new Set(entries.map((e) => e.shell))];
  return shells.flatMap((shell) => [
    `${indent}${shell}`,
    ...entries.flatMap((e, i) => (e.shell === shell ? [`${indent}  #${i + 1} ${entryDescription(e, now, used?.(e))}`] : [])),
  ]);
}

/**
 * The policy recorded here for a machine, or undefined when this machine never signed one. A record that cannot be read is an error with
 * its own fix (readPolicyRecord): never treated as "no policy".
 */
export function recordedPolicy(configDir: string, uuid: string): SignedPolicy | undefined {
  if (!existsSync(policyRecordFile(configDir, uuid))) return undefined;
  return readPolicyRecord(configDir, uuid, readAdminPin(configDir).adminPublicKey);
}

/**
 * The extra line of a `not-listed` refusal of `machine run`: what the policy signed HERE allows for this caller. The target says only whether
 * the very command exists under another shell (T-03); this line is local knowledge, never learned from the target. A record that cannot be
 * read is said through `warn`, never silently skipped.
 */
export function refusalListLine(configDir: string, peer: { uuid: string; name: string }, selfUuid: string, warn: (text: string) => void): string | undefined {
  try {
    const record = recordedPolicy(configDir, peer.uuid);
    if (record === undefined) return undefined;
    return refusalAllowedLine(peer.name, record.body.version, effectiveList(record.body, selfUuid).entries);
  } catch (e) {
    warn(`the policy record of ${peer.name} could not be read, so the refusal cannot list what is allowed there: ${(e as Error).message}`);
    return undefined;
  }
}
