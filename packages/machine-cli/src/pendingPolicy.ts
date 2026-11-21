import { existsSync } from 'node:fs';
import { entryMatches, type Shell } from '@wadeck-app/machine-core';
import { readAdminPin } from './admin.js';
import { policyRecordFile, readPolicyRecord } from './adminAllow.js';
import { pendingPolicyNote } from './noPolicy.js';

/**
 * The extra line of a refusal printed by `machine run`: this machine signed a policy for the peer recently (the record `admin allow` /
 * `admin sign-policy` writes), so the refusal is likely the relay delay. Absent when there is no record (not the admin machine), or it is
 * not a recent one. A record that cannot be read is said (a warning), never silently skipped.
 */
export function pendingPolicyLine(
  configDir: string,
  peer: { uuid: string; name: string },
  refusal: { reason: string; shell: string; command: string; selfUuid: string },
  now: number,
  warn: (text: string) => void,
): string | undefined {
  if (refusal.reason !== 'no-policy' && refusal.reason !== 'not-listed') return undefined;
  if (!existsSync(policyRecordFile(configDir, peer.uuid))) return undefined;
  try {
    const record = readPolicyRecord(configDir, peer.uuid, readAdminPin(configDir).adminPublicKey);
    if (record === undefined) return undefined;
    const entries = record.body.peers[refusal.selfUuid] ?? record.body.defaults;
    return pendingPolicyNote({
      reason: refusal.reason,
      machine: peer.name,
      version: record.body.version,
      issuedAt: record.body.issuedAt,
      now,
      // The platform of the target is not known here: the strict answer (reserved device names refused) is the safe one for a hint.
      recordAllowsCommand: entries.some((e) => entryMatches(e, { shell: refusal.shell as Shell, command: refusal.command }, 'windows')),
    });
  } catch (e) {
    warn(`the policy record of ${peer.name} could not be read, so the refusal cannot say whether a policy is in transit: ${(e as Error).message}`);
    return undefined;
  }
}
