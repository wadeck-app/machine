import { existsSync } from 'node:fs';
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
      recordAllowsCommand: entries.some((e) => e.shell === refusal.shell && e.command === refusal.command),
    });
  } catch (e) {
    warn(`the policy record of ${peer.name} could not be read, so the refusal cannot say whether a policy is in transit: ${(e as Error).message}`);
    return undefined;
  }
}
