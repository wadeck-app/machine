import { isRevoked, verifyRegistration, type MachineEntry, type RevocationEntry, type SignedRegistration } from '@wadeck-app/machine-core';

const PAIR_SECRET_BYTES = 32;

export interface PairedRegistration {
  registration: SignedRegistration;
  /** Secret shared with that peer only (distributed by the admin console). */
  pairSecret: Buffer;
}

export interface PeerRecord {
  peerId: string;
  name: string;
  pairSecret: Buffer;
}

export interface Directory {
  /** The peer that owns this identity key, or undefined for a key that is not registered. */
  lookup(identityPublicKey: string): PeerRecord | undefined;
  machines(): MachineEntry[];
  /** Why registrations were left out. Shown by `machine status`: a missing peer is never silent. */
  problems: string[];
}

export interface DirectoryContext {
  adminPublicKey: string;
  /** Epoch seconds. */
  now: number;
  revocations: RevocationEntry[];
  selfUuid: string;
}

/** The set of machines this one trusts: only admin-signed, current, unrevoked registrations, each with its pair secret. */
export function buildDirectory(entries: PairedRegistration[], ctx: DirectoryContext): Directory {
  const problems: string[] = [];
  const accepted: Array<{ key: string; record: PeerRecord }> = [];

  for (const { registration, pairSecret } of entries) {
    const label = (registration as { body?: { name?: unknown } }).body?.name;
    const name = typeof label === 'string' ? label : '(unnamed)';
    const verified = verifyRegistration(registration, {
      adminPublicKey: ctx.adminPublicKey,
      now: ctx.now,
      isRevoked: (uuid, serial) => isRevoked(ctx.revocations, uuid, serial),
    });
    if (!verified.ok) {
      problems.push(`${name}: registration ${verified.reason} (${verified.message})`);
      continue;
    }
    const { body } = verified;
    if (body.uuid === ctx.selfUuid) continue;
    if (pairSecret.length !== PAIR_SECRET_BYTES) {
      problems.push(`${name}: pair secret must be ${PAIR_SECRET_BYTES} bytes, got ${pairSecret.length}; re-run the pairing from the admin console`);
      continue;
    }
    accepted.push({ key: body.identityPublicKey, record: { peerId: body.uuid, name: body.name, pairSecret } });
  }

  // One key must mean one machine: if two registrations claim the same key, neither is trusted.
  const byKey = new Map<string, PeerRecord[]>();
  for (const { key, record } of accepted) byKey.set(key, [...(byKey.get(key) ?? []), record]);
  const trusted = new Map<string, PeerRecord>();
  for (const [key, records] of byKey) {
    if (records.length > 1) {
      problems.push(`${records.map((r) => r.name).join(' and ')} present the same identity key: none of them is trusted until the admin fixes the registrations`);
    } else {
      trusted.set(key, records[0] as PeerRecord);
    }
  }

  return {
    lookup: (key) => trusted.get(key),
    machines: () => [...trusted.values()].map((r) => ({ uuid: r.peerId, name: r.name })),
    problems,
  };
}
