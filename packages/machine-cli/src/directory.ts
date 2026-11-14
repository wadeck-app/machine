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

function labelOf(registration: unknown): string {
  const name = (registration as { body?: { name?: unknown } } | null | undefined)?.body?.name;
  return typeof name === 'string' ? name : '(unnamed)';
}

interface Accepted {
  key: string;
  serial: number;
  record: PeerRecord;
}

/** The set of machines this one trusts: only admin-signed, current, unrevoked registrations, each with its pair secret. */
export function buildDirectory(entries: PairedRegistration[], ctx: DirectoryContext): Directory {
  const problems: string[] = [];
  const accepted: Accepted[] = [];

  for (const entry of entries) {
    const registration = (entry as { registration?: unknown } | null | undefined)?.registration;
    const pairSecret = (entry as { pairSecret?: unknown } | null | undefined)?.pairSecret;
    const name = labelOf(registration);
    if (typeof registration !== 'object' || registration === null) {
      problems.push(`${name}: registration is not a registration document; ask the admin to issue it again`);
      continue;
    }
    const verified = verifyRegistration(registration as SignedRegistration, {
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
    if (!Buffer.isBuffer(pairSecret) || pairSecret.length !== PAIR_SECRET_BYTES) {
      problems.push(`${name}: pair secret must be ${PAIR_SECRET_BYTES} bytes; re-run the pairing from the admin console`);
      continue;
    }
    accepted.push({ key: body.identityPublicKey, serial: body.serial, record: { peerId: body.uuid, name: body.name, pairSecret } });
  }

  // One uuid, one registration: when the admin re-registers a machine, the highest serial wins and the older key is no longer trusted.
  const newestByUuid = new Map<string, Accepted>();
  for (const a of accepted) {
    const known = newestByUuid.get(a.record.peerId);
    if (!known || a.serial > known.serial) newestByUuid.set(a.record.peerId, a);
  }
  const current: Accepted[] = [];
  for (const a of accepted) {
    if (newestByUuid.get(a.record.peerId) === a) current.push(a);
    else problems.push(`${a.record.name}: registration superseded by a newer one with a higher serial (the older key is no longer trusted)`);
  }

  // One key must mean one machine: if two registrations claim the same key, neither is trusted.
  const byKey = new Map<string, Accepted[]>();
  for (const a of current) byKey.set(a.key, [...(byKey.get(a.key) ?? []), a]);
  const trusted = new Map<string, PeerRecord>();
  for (const [key, list] of byKey) {
    if (list.length > 1) {
      problems.push(`${list.map((a) => a.record.name).join(' and ')} present the same identity key: none of them is trusted until the admin fixes the registrations`);
    } else {
      trusted.set(key, (list[0] as Accepted).record);
    }
  }

  return {
    lookup: (key) => trusted.get(key),
    machines: () => [...trusted.values()].map((r) => ({ uuid: r.peerId, name: r.name })),
    problems,
  };
}
