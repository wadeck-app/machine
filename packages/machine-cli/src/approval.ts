import { decodeBase64urlStrict, verifyRegistration, type RegistrationBody } from '@wadeck-app/machine-core';
import { assertPinCompatible, parseAdminPinDocument, pinAdminDocument, type AdminPin } from './admin.js';
import { importPeer, type MachineInfo, type PeerBundle } from './network.js';

// The approval an admin returns through the relay for a candidacy (relay-api.md, section Approval). The relay is
// untrusted: everything here is verified locally, with the same validators as the manual flow (decision 48).

export interface Approval {
  v: 1;
  /** The registration of THIS machine, with the pair secret slot of the existing bundle format. */
  self: PeerBundle;
  /** Content of the admin's `admin.json`: the key this machine is about to pin. */
  admin: { v: 1; adminPublicKey: string; adminKeyId: string };
  /** The peers the admin chose to include, each as the bundle `machine peer import` takes. */
  peers: PeerBundle[];
  /** The `random` of the candidacy this approval answers. UNSIGNED (the relay can set it): it only catches an old or mixed-up approval, the final code stays the security check. */
  random: string;
}

export interface CheckedApproval {
  approval: Approval;
  admin: AdminPin;
  selfBody: RegistrationBody;
  peerBodies: RegistrationBody[];
}

const KEYS = ['v', 'self', 'admin', 'peers', 'random'];
const asObject = (value: unknown): Record<string, unknown> | undefined => (typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined);

function bundleShape(value: unknown, where: string): PeerBundle {
  const o = asObject(value);
  if (!o || asObject(o.registration) === undefined || typeof o.pairSecret !== 'string') throw new Error(`${where} is not a bundle (expected { registration, pairSecret })`);
  try {
    decodeBase64urlStrict(o.pairSecret, 32, 'pair secret');
  } catch (e) {
    throw new Error(`${where} has an invalid pair secret (${(e as Error).message})`);
  }
  return o as unknown as PeerBundle;
}

/**
 * Verify everything verifiable BEFORE any trust is given: shape, the registration of this machine (uuid, key and name
 * equal to this machine, signed by the key the approval carries, in its validity window) and each peer registration.
 * This proves the approval is consistent, NOT that the admin key is the right one: only the final code does (T-05).
 */
export function checkApproval(raw: unknown, self: MachineInfo, now: number, candidacyRandom: string): CheckedApproval {
  const o = asObject(raw);
  if (!o) throw new Error('the approval is not a JSON object');
  // First of all: an approval that answers another candidacy (an old one replayed, or mixed up by the relay) is not examined further.
  if (typeof o.random !== 'string') {
    throw new Error('the approval carries no "random" binding it to this candidacy: it comes from an older admin version or from a replay. Ask the admin to approve again after `machine join --resume`');
  }
  if (o.random !== candidacyRandom) {
    throw new Error('the approval answers another candidacy (its random differs from the one of this machine): it is a replay of an old approval or the relay mixed candidacies up. Nothing was trusted; ask the admin to approve again after `machine join --resume`');
  }
  for (const key of Object.keys(o)) {
    if (!KEYS.includes(key)) throw new Error(`the approval has an unknown field "${key}": it may come from an incompatible version`);
  }
  if (o.v !== 1) throw new Error(`the approval has version ${String(o.v)}, this build reads version 1: update machine or ask the admin to update`);
  const admin = parseAdminPinDocument(o.admin, 'the approval carries no valid admin key document (expected { v, adminPublicKey, adminKeyId } as in admin.json)');
  const selfBundle = bundleShape(o.self, 'the approval "self" entry');
  if (!Array.isArray(o.peers)) throw new Error('the approval has no "peers" list (an empty list is allowed)');
  const peers = o.peers.map((p, i) => bundleShape(p, `the approval peer #${i + 1}`));

  const selfResult = verifyRegistration(selfBundle.registration, { adminPublicKey: admin.adminPublicKey, now });
  if (!selfResult.ok) throw new Error(`the registration of this machine was refused (${selfResult.reason}): ${selfResult.message}`);
  const body = selfResult.body;
  if (body.uuid !== self.uuid || body.identityPublicKey !== self.identityPublicKey || body.name !== self.name) {
    throw new Error(
      `the approval registers another machine ("${body.name}", ${body.uuid}) than this one ("${self.name}", ${self.uuid}) or with another key: the relay or the admin mixed candidacies up. Nothing was trusted`,
    );
  }
  const peerBodies = peers.map((p, i) => {
    const r = verifyRegistration(p.registration, { adminPublicKey: admin.adminPublicKey, now });
    if (!r.ok) throw new Error(`peer #${i + 1} of the approval was refused (${r.reason}): ${r.message}`);
    if (r.body.uuid === self.uuid) throw new Error(`peer #${i + 1} of the approval is this machine itself: ask the admin to rebuild the approval`);
    return r.body;
  });
  return { approval: { v: 1, self: selfBundle, admin: o.admin as Approval['admin'], peers, random: o.random }, admin, selfBody: body, peerBodies };
}

/** The pin conflicts with another admin key already pinned here: checked before the human is asked anything. */
export function isAlreadyPinned(configDir: string, checked: CheckedApproval): boolean {
  return assertPinCompatible(configDir, checked.admin).alreadyPinned;
}

/** Pin the admin key, then import every peer through the existing validator. The caller confirmed the final code. */
export function applyApproval(configDir: string, checked: CheckedApproval, now: number): void {
  pinAdminDocument(configDir, checked.approval.admin, 'the approval carries an invalid admin key document');
  for (const peer of checked.approval.peers) importPeer(configDir, peer, { now });
}
