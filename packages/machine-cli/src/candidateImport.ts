import { existsSync } from 'node:fs';
import { decodeBase64urlStrict, DOCUMENT_SKEW_SECONDS, importCandidateSealContext, isUuid, NOT_YET_VALID_LEEWAY_SECONDS, openSealed, verifyRegistration, type SignedRegistration } from '@wadeck-app/machine-core';
import { adminKeyFile, readAdminPin } from './admin.js';
import { NotInitializedError } from './errors.js';
import { readMachine, type MachineIdentity } from './identity.js';
import { importPeer, installedRevocations, loadNetwork } from './network.js';

// Approve from the page, lot 3 (admin-ui.md): the daemon side of the approval of a candidacy. The BROWSER holds the passphrase and signs (machine-webcrypto
// `buildApproval`); this machine, the one that holds the admin key, only verifies and imports. It never receives a passphrase or an unlocked key and signs nothing.
//
// Hard rule 4: a registration widens rights, so it is imported only when the PINNED admin key signed it. The pair secret does not cross the module backend in
// clear: it arrives sealed to the identity key of this machine, for this admin machine, this candidate and this candidacy only (`importCandidateSealContext`).

export type Failure = { ok: false; reason: string; message: string };
const fail = (reason: string, message: string): Failure => ({ ok: false, reason, message });

const IMPORT_FIELDS = ['registration', 'sealedPairSecret', 'adminUuid', 'candidateUuid', 'random'];
const BAD_IMPORT = `expected exactly {"registration": <signed registration>, "sealedPairSecret": <text>, "adminUuid": <uuid>, "candidateUuid": <uuid>, "random": <text>}: reload the page and approve again`;

const notAdminHere = (configDir: string): Failure =>
  fail('no-admin-key', `this machine has no admin key (${adminKeyFile(configDir)} does not exist): the approval can only be made on the machine that holds the admin key, run this page there (\`machine admin init\` creates the key). Nothing was imported`);

function selfOf(configDir: string): MachineIdentity | Failure {
  try {
    return readMachine(configDir);
  } catch (e) {
    if (e instanceof NotInitializedError) return fail('not-initialized', `${e.message}. Nothing was imported`);
    throw e;
  }
}

export interface ApproveContextOk {
  ok: true;
  /** The machine that holds the admin key: the page signs a registration for it and seals the pair secret to its identity key. */
  adminMachine: { uuid: string; name: string; identityPublicKey: string };
  /** The pinned admin key: the public half of the key file the page unlocks. */
  adminPublicKey: string;
  adminKeyId: string;
  candidate: { trusted: boolean; name?: string; identityPublicKey?: string; revokedSerial?: number };
}

/** Everything the page needs BEFORE it asks the passphrase. Read-only. Payload: exactly `{ candidateUuid }`. */
export function approveContext(configDir: string, payload: unknown, _now: number): ApproveContextOk | Failure {
  const p = typeof payload === 'object' && payload !== null && !Array.isArray(payload) ? (payload as Record<string, unknown>) : {};
  const extra = Object.keys(p).find((k) => k !== 'candidateUuid');
  const uuid = p['candidateUuid'];
  if (extra !== undefined || typeof uuid !== 'string' || !isUuid(uuid)) {
    return fail('bad-payload', 'expected exactly {"candidateUuid": "<uuid of the candidacy>"}: reload the page and approve again');
  }
  if (!existsSync(adminKeyFile(configDir))) return notAdminHere(configDir);
  const self = selfOf(configDir);
  if ('ok' in self) return self;
  const pin = readAdminPin(configDir);
  const known = loadNetwork(configDir, _now).directory.find(uuid);
  const revoked = installedRevocations(configDir).filter((entry) => entry.uuid === uuid).at(-1);
  return {
    ok: true,
    adminMachine: { uuid: self.uuid, name: self.name, identityPublicKey: self.identity.publicKey },
    adminPublicKey: pin.adminPublicKey,
    adminKeyId: pin.adminKeyId,
    candidate: { trusted: known !== undefined, ...(known === undefined ? {} : { name: known.name, identityPublicKey: known.identityPublicKey }), ...(revoked === undefined ? {} : { revokedSerial: revoked.serial }) },
  };
}

export type ImportCandidateAnswer = { ok: true; candidate: { uuid: string; name: string }; serial: number; warnings: string[] } | Failure;

/**
 * The admin machine trusts the candidate, exactly as `machine admin approve` does before it tells the relay (`importPeer`): the registration is verified
 * against the pinned admin key, the pair secret is opened with the identity key of this machine, then both are stored. Idempotent: the page can retry.
 * Payload: exactly `{ registration, sealedPairSecret, adminUuid, candidateUuid, random }`; any other field is refused.
 */
export async function importCandidate(configDir: string, payload: unknown, now: number): Promise<ImportCandidateAnswer> {
  const p = typeof payload === 'object' && payload !== null && !Array.isArray(payload) ? (payload as Record<string, unknown>) : undefined;
  if (p === undefined || Object.keys(p).some((k) => !IMPORT_FIELDS.includes(k)) || IMPORT_FIELDS.some((k) => p[k] === undefined)) return fail('bad-payload', BAD_IMPORT);
  const { registration, sealedPairSecret, adminUuid, candidateUuid, random } = p;
  if (typeof registration !== 'object' || registration === null || typeof sealedPairSecret !== 'string' || sealedPairSecret.length === 0 || sealedPairSecret.length > 4096) return fail('bad-payload', BAD_IMPORT);
  if (typeof adminUuid !== 'string' || !isUuid(adminUuid) || typeof candidateUuid !== 'string' || !isUuid(candidateUuid) || typeof random !== 'string') return fail('bad-payload', BAD_IMPORT);
  try {
    decodeBase64urlStrict(random, 16, 'candidacy random');
  } catch (e) {
    return fail('bad-payload', `"random" is not a candidacy random (${(e as Error).message}): ${BAD_IMPORT}`);
  }

  if (!existsSync(adminKeyFile(configDir))) return notAdminHere(configDir);
  const self = selfOf(configDir);
  if ('ok' in self) return self;
  if (adminUuid !== self.uuid) {
    return fail('wrong-machine', `the secret was sealed for the admin machine ${adminUuid}, this machine is ${self.uuid} (${self.name}): the page and the daemon it talks to are not the same machine. Nothing was imported; open the page of the machine that holds the admin key`);
  }
  const pin = readAdminPin(configDir);
  const verified = verifyRegistration(registration as SignedRegistration, { adminPublicKey: pin.adminPublicKey, now, skewSeconds: DOCUMENT_SKEW_SECONDS, notBeforeLeewaySeconds: NOT_YET_VALID_LEEWAY_SECONDS });
  if (!verified.ok) {
    return fail('bad-registration', `this machine does not trust that registration: it was not accepted by the admin key pinned on this machine (${verified.reason}: ${verified.message}). The page unlocked another key or the registration was altered; nothing was imported`);
  }
  const body = verified.body;
  if (body.uuid !== candidateUuid) {
    return fail('bad-payload', `the registration is for ${body.uuid}, not for the candidate ${candidateUuid} of the request: reload the page and approve again. Nothing was imported`);
  }
  if (body.uuid === self.uuid) return fail('bad-payload', 'the candidate is this machine itself: it is no peer of itself, nothing to import (the approval of the first machine needs no import)');

  // A uuid trusted here with another identity key is a replacement of the key, not a renewal: only `machine admin approve` asks the human about the rebind.
  const known = loadNetwork(configDir, now).directory.find(body.uuid);
  if (known !== undefined && known.identityPublicKey !== body.identityPublicKey) {
    return fail(
      'key-changed',
      `"${known.name}" (${body.uuid}) is already trusted here with another identity key, and this registration carries a different one: replacing a key is a decision that needs the relay's binding information. Nothing was imported; run \`machine admin approve\` in a terminal, or reject the candidacy and revoke the old machine (\`machine admin revoke ${known.name}\`) first`,
    );
  }

  let secret: Uint8Array;
  try {
    secret = openSealed(self.identity.privateKeyPkcs8, sealedPairSecret, importCandidateSealContext(adminUuid, candidateUuid, random));
  } catch (e) {
    return fail('cannot-open', `cannot open the sealed pair secret: it is not sealed to the identity key of this machine, was altered, or is bound to another admin machine, candidate or candidacy (${(e as Error).message}). Nothing was imported; reload the page and approve again`);
  }
  if (secret.length !== 32) return fail('cannot-open', `the pair secret has ${secret.length} bytes after opening, expected 32: the page sealed something else than a pair secret. Nothing was imported`);

  const warnings: string[] = [];
  const revoked = installedRevocations(configDir).filter((entry) => entry.uuid === body.uuid).at(-1);
  if (revoked !== undefined) {
    warnings.push(`this machine was REVOKED here earlier (serial ${revoked.serial}): the new registration enrolls it again`);
  }
  try {
    importPeer(configDir, { registration: registration as SignedRegistration, pairSecret: Buffer.from(secret).toString('base64url') }, { now });
  } catch (e) {
    return fail('refused', `${(e as Error).message}. Nothing was imported`);
  } finally {
    secret.fill(0);
  }
  return { ok: true, candidate: { uuid: body.uuid, name: body.name }, serial: body.serial, warnings };
}
