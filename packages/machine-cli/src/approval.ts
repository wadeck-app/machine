import { canonicalize, decodeBase64urlStrict, isUuid, openSealed, sealTo, verifyRegistration, type Json, type RegistrationBody, type SignedRegistration } from '@wadeck-app/machine-core';
import { assertPinCompatible, parseAdminPinDocument, pinAdminDocument, type AdminPin } from './admin.js';
import { importPeer, type MachineInfo, type PeerBundle } from './network.js';

// The approval an admin returns through the relay for a candidacy (relay-api.md, section Approval). The relay is
// untrusted: everything here is verified locally, with the same validators as the manual flow (decision 48). The pair
// secrets are sealed to the identity key of the candidate (decision 22): the relay cannot read them.

/** A bundle as it travels through the relay: the registration and the pair secret sealed to the candidate. */
export interface SealedBundle {
  registration: SignedRegistration;
  /** `sealTo(candidate identity key, pair secret, pairSecretContext(...))`. */
  sealedPairSecret: string;
}

export interface Approval {
  v: 1;
  /** The registration of THIS machine, with its pair secret sealed to this machine. */
  self: SealedBundle;
  /** Content of the admin's `admin.json`: the key this machine is about to pin. */
  admin: { v: 1; adminPublicKey: string; adminKeyId: string };
  /** The uuid of the admin machine (it holds the pair secrets), or null when the admin machine has no identity. Bound into the seal context, so a relay that changes it only makes opening fail. */
  adminUuid: string | null;
  /** The peers the admin chose to include, each with its pair secret sealed to this machine. */
  peers: SealedBundle[];
  /** The `random` of the candidacy this approval answers. UNSIGNED (the relay can set it): it only catches an old or mixed-up approval, the final code stays the security check. It is also part of the seal context. */
  random: string;
}

export interface CheckedApproval {
  /** The approval after opening: bundles in the format `machine peer import` takes. */
  approval: { v: 1; self: PeerBundle; admin: Approval['admin']; adminUuid: string | null; peers: PeerBundle[]; random: string };
  admin: AdminPin;
  selfBody: RegistrationBody;
  peerBodies: RegistrationBody[];
}

export interface SealContextParts {
  adminUuid: string | null;
  candidateUuid: string;
  /** The random of the candidacy this approval answers. */
  random: string;
  /** `self`, or `peer:<uuid of the peer>`: a sealed value cannot be moved to another entry. */
  slot: string;
}

/** The purpose a pair secret is sealed for: one admin machine, one candidate, one candidacy, one entry of the approval. */
export function pairSecretContext(parts: SealContextParts): string {
  return `pair-secret:${parts.adminUuid ?? 'none'}:${parts.candidateUuid}:${parts.random}:${parts.slot}`;
}

/** Admin side: seal the pair secret of a bundle to the identity key of the candidate. */
export function sealBundle(bundle: PeerBundle, candidateIdentityPublicKey: string, parts: SealContextParts): SealedBundle {
  const secret = decodeBase64urlStrict(bundle.pairSecret, 32, 'pair secret');
  return { registration: bundle.registration, sealedPairSecret: sealTo(candidateIdentityPublicKey, secret, pairSecretContext(parts)) };
}

/** What the relay stores as the approval of a candidacy (decision 78): the whole approval sealed to the candidate. Only the `random` the relay already holds is in clear. */
export interface SealedApproval {
  v: 2;
  random: string;
  /** `sealTo(identity key of the candidate, canonical JSON of the Approval, approvalSealContext(...))`. */
  sealed: string;
}

/** The purpose an approval is sealed for: this candidate machine and this candidacy. A sealed approval opens nowhere else. */
export function approvalSealContext(candidateUuid: string, random: string): string {
  return `approval:v2:${candidateUuid}:${random}`;
}

/** Admin side: seal the whole approval (registrations, admin key, sealed secrets) to the identity key of the candidate. */
export function sealApproval(approval: Approval | Record<string, unknown>, candidateIdentityPublicKey: string, candidateUuid: string): SealedApproval {
  const random = (approval as { random?: unknown }).random;
  if (typeof random !== 'string') {
    throw new Error('internal: the approval has no random binding it to the candidacy: nothing was sealed or sent');
  }
  return { v: 2, random, sealed: sealTo(candidateIdentityPublicKey, Buffer.from(canonicalize(approval as unknown as Json), 'utf8'), approvalSealContext(candidateUuid, random)) };
}

const OUTER_KEYS = ['v', 'random', 'sealed'];
const KEYS = ['v', 'self', 'admin', 'adminUuid', 'peers', 'random'];
const asObject = (value: unknown): Record<string, unknown> | undefined => (typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined);

function bundleShape(value: unknown, where: string): SealedBundle {
  const o = asObject(value);
  if (o && 'pairSecret' in o) {
    throw new Error(
      `${where} carries a pair secret in clear text: it was made by an older machine on the admin side, which sent the secret through the relay unprotected. Treat that secret as exposed and do not use it. ` +
        'Run update machine on the admin machine (it seals pair secrets to the identity key of this machine), then ask the admin to approve again after `machine join --resume`',
    );
  }
  if (!o || asObject(o.registration) === undefined || typeof o.sealedPairSecret !== 'string') throw new Error(`${where} is not a sealed bundle (expected { registration, sealedPairSecret })`);
  return o as unknown as SealedBundle;
}

function openBundle(bundle: SealedBundle, where: string, identityPrivateKey: Uint8Array, parts: SealContextParts): PeerBundle {
  let secret: Uint8Array;
  try {
    secret = openSealed(identityPrivateKey, bundle.sealedPairSecret, pairSecretContext(parts));
  } catch (e) {
    throw new Error(
      `cannot open the sealed pair secret of ${where}: it is not sealed to the identity key of this machine, was altered, or is bound to another admin, candidacy or entry (${(e as Error).message}). Do not trust this approval`,
    );
  }
  if (secret.length !== 32) throw new Error(`the pair secret of ${where} has ${secret.length} bytes after opening, expected 32 bytes: the admin sealed something else than a pair secret. Do not trust this approval`);
  return { registration: bundle.registration, pairSecret: Buffer.from(secret).toString('base64url') };
}

/**
 * Verify everything verifiable BEFORE any trust is given: shape, the registration of this machine (uuid, key and name
 * equal to this machine, signed by the key the approval carries, in its validity window) and each peer registration.
 * This proves the approval is consistent, NOT that the admin key is the right one: only the final code does (T-05).
 */
export function checkApproval(raw: unknown, self: MachineInfo, now: number, candidacyRandom: string, identityPrivateKey: Uint8Array): CheckedApproval {
  const outer = asObject(raw);
  if (!outer) {
    throw new Error('the approval is not a JSON object');
  }
  // First of all: an approval that answers another candidacy (an old one replayed, or mixed up by the relay) is not examined further.
  if (typeof outer.random !== 'string') {
    throw new Error('the approval carries no "random" binding it to this candidacy: it comes from an older admin version or from a replay. Ask the admin to approve again after `machine join --resume`');
  }
  if (outer.random !== candidacyRandom) {
    throw new Error('the approval answers another candidacy (its random differs from the one of this machine): it is a replay of an old approval or the relay mixed candidacies up. Nothing was trusted; ask the admin to approve again after `machine join --resume`');
  }
  // Decision 78: an approval is sealed as a whole. A clear one (envelope version 1) was readable by the relay: refused, nothing is pinned.
  if (outer.v === 1 || 'self' in outer) {
    throw new Error(
      'the approval arrived in PLAINTEXT (envelope version 1): the relay could read the registrations and the admin key in it, so it is refused and nothing was pinned or imported. The admin machine runs an older build: run `machine cli update` there, then ask the admin to approve again after `machine join --resume`',
    );
  }
  for (const key of Object.keys(outer)) {
    if (!OUTER_KEYS.includes(key)) {
      throw new Error(`the approval has an unknown field "${key}": it may come from an incompatible version`);
    }
  }
  if (outer.v !== 2) {
    throw new Error(`the approval has envelope version ${String(outer.v)}, this build reads version 2 (sealed): update machine or ask the admin to update`);
  }
  if (typeof outer.sealed !== 'string') {
    throw new Error('the approval has no "sealed" payload: it may come from an incompatible version');
  }
  let inner: unknown;
  try {
    const plain = openSealed(identityPrivateKey, outer.sealed, approvalSealContext(self.uuid, outer.random));
    inner = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(plain));
  } catch (e) {
    const detail = e instanceof SyntaxError || e instanceof TypeError ? 'it opened but is not JSON: it was not sealed by machine admin approve' : (e as Error).message;
    throw new Error(
      `cannot open the approval: it is not sealed to the identity key of this machine, was altered, or answers another candidacy (${detail}). Nothing was trusted; ask the admin to approve again after \`machine join --resume\``,
    );
  }
  const o = asObject(inner);
  if (!o) {
    throw new Error('the sealed approval is not a JSON object (it is not an approval): nothing was trusted; ask the admin to approve again after `machine join --resume`');
  }
  if (o.random !== candidacyRandom) {
    throw new Error('the sealed approval answers another candidacy (its random differs from the one of this machine): nothing was trusted; ask the admin to approve again after `machine join --resume`');
  }
  for (const key of Object.keys(o)) {
    if (!KEYS.includes(key)) throw new Error(`the approval has an unknown field "${key}": it may come from an incompatible version`);
  }
  if (o.v !== 1) throw new Error(`the approval has version ${String(o.v)}, this build reads version 1: update machine or ask the admin to update`);
  const admin = parseAdminPinDocument(o.admin, 'the approval carries no valid admin key document (expected { v, adminPublicKey, adminKeyId } as in admin.json)');
  const selfBundle = bundleShape(o.self, 'the approval "self" entry');
  if (!Array.isArray(o.peers)) throw new Error('the approval has no "peers" list (an empty list is allowed)');
  const sealedPeers = o.peers.map((p, i) => bundleShape(p, `the approval peer #${i + 1}`));
  if (o.adminUuid !== null && (typeof o.adminUuid !== 'string' || !isUuid(o.adminUuid) || o.adminUuid !== o.adminUuid.toLowerCase())) {
    throw new Error('the approval has no valid "adminUuid" (a lower-case UUID, or null when the admin machine has no identity): it may come from an incompatible version');
  }
  const adminUuid = o.adminUuid;

  const selfResult = verifyRegistration(selfBundle.registration, { adminPublicKey: admin.adminPublicKey, now });
  if (!selfResult.ok) throw new Error(`the registration of this machine was refused (${selfResult.reason}): ${selfResult.message}`);
  const body = selfResult.body;
  if (body.uuid !== self.uuid || body.identityPublicKey !== self.identityPublicKey || body.name !== self.name) {
    throw new Error(
      `the approval registers another machine ("${body.name}", ${body.uuid}) than this one ("${self.name}", ${self.uuid}) or with another key: the relay or the admin mixed candidacies up. Nothing was trusted`,
    );
  }
  const peerBodies = sealedPeers.map((p, i) => {
    const r = verifyRegistration(p.registration, { adminPublicKey: admin.adminPublicKey, now });
    if (!r.ok) throw new Error(`peer #${i + 1} of the approval was refused (${r.reason}): ${r.message}`);
    if (r.body.uuid === self.uuid) throw new Error(`peer #${i + 1} of the approval is this machine itself: ask the admin to rebuild the approval`);
    return r.body;
  });

  // Only now, with every registration verified, the secrets are opened (each bound to its own entry).
  const parts = (slot: string): SealContextParts => ({ adminUuid, candidateUuid: self.uuid, random: o.random as string, slot });
  const openedSelf = openBundle(selfBundle, 'the approval "self" entry', identityPrivateKey, parts('self'));
  const peers = sealedPeers.map((p, i) => openBundle(p, `the approval peer #${i + 1}`, identityPrivateKey, parts(`peer:${(peerBodies[i] as RegistrationBody).uuid}`)));
  return { approval: { v: 1, self: openedSelf, admin: o.admin as Approval['admin'], adminUuid, peers, random: o.random }, admin, selfBody: body, peerBodies };
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
