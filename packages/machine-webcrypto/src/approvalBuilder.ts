import type { RegistrationBody, SignedRegistration } from '@wadeck-app/machine-core';
import { decodeBase64urlStrict, encodeBase64url } from './base64url.js';
import { canonicalize, type Json } from './canonical.js';
import { assertRegistrationBody, signRegistration } from './documents.js';
import { keyId } from './keys.js';
import { derivePairSecretFromSignature } from './pairSecret.js';
import { finalCode } from './sas.js';
import { sealTo } from './seal.js';

// Approve from the page, lot 2 (admin-ui.md): the admin side of the approval of a candidacy, built in the browser with the non-extractable admin key.
// Pure: no I/O, no clock (`now` is given), no storage. Twin of machine-cli `adminApprove.ts` (registrations, bundles) and `approval.ts` (sealing); the
// seal contexts are copies of machine-core `approvalContext.ts` (tested equal). The pair secret is the V2 one (D27, derived from a signature), so the
// admin machine and the candidate get the same value without the raw admin seed. The relay carries only `approval`; the pair secret never leaves
// the page in clear: it is sealed to the candidate (inside the approval) and to the admin machine (`adminImport`, opened by a daemon command).

const MAX_APPROVAL_BYTES = 16 * 1024;

export interface SealContextParts {
  adminUuid: string | null;
  candidateUuid: string;
  random: string;
  slot: string;
}

export const pairSecretContext = (parts: SealContextParts): string => `pair-secret:${parts.adminUuid ?? 'none'}:${parts.candidateUuid}:${parts.random}:${parts.slot}`;
export const approvalSealContext = (candidateUuid: string, random: string): string => `approval:v2:${candidateUuid}:${random}`;
export const importCandidateSealContext = (adminUuid: string, candidateUuid: string, random: string): string => `import-candidate:v1:${adminUuid}:${candidateUuid}:${random}`;

export interface ApprovalMachine {
  uuid: string;
  name: string;
  identityPublicKey: string;
}

export interface ApprovalCandidate extends ApprovalMachine {
  /** The candidacy random, unpadded base64url (16 bytes), as the relay listed it. */
  random: string;
}

export interface BuildApprovalInput {
  /** The unlocked, non-extractable admin signing key. */
  adminPrivateKey: CryptoKey;
  adminPublicKey: string;
  /** Must be the id of `adminPublicKey` (the one pinned on the machines). */
  adminKeyId: string;
  candidate: ApprovalCandidate;
  /** The machine that holds the admin key (it trusts the candidate and holds the pair secrets); null when it has no identity. */
  adminMachine: ApprovalMachine | null;
  /** Epoch seconds: serial and start of both registrations. */
  now: number;
  validForDays: number;
}

/** What the relay stores as the approval of a candidacy (decision 78): the whole approval sealed to the candidate. */
export interface SealedApproval {
  v: 2;
  random: string;
  sealed: string;
}

/** What the admin machine needs to trust the candidate: its signed registration and the pair secret sealed to the identity key of the admin machine. */
export interface CandidateImport {
  registration: SignedRegistration;
  /** `sealTo(identity key of the admin machine, pair secret, importCandidateSealContext(admin uuid, candidate uuid, random))`. */
  sealedPairSecret: string;
  adminUuid: string;
  candidateUuid: string;
  random: string;
}

export interface BuiltApproval {
  /** The body of the decision `approve` posted through the relay. */
  approval: SealedApproval;
  /** Null when there is no pair to import: the candidate is the admin machine itself, or the admin machine has no identity. */
  adminImport: CandidateImport | null;
  /** The security code (decision 55), computed from the keys held here: shown for the human to compare with the candidate screen, never taken from relay text. */
  finalCode: string;
  registrations: { candidate: SignedRegistration; adminMachine?: SignedRegistration };
}

const text = (s: string): Uint8Array => new TextEncoder().encode(s);

function registrationBody(machine: ApprovalMachine, input: BuildApprovalInput): RegistrationBody {
  return {
    v: 1,
    uuid: machine.uuid,
    name: machine.name,
    identityPublicKey: machine.identityPublicKey,
    // A later registration of the same machine always has a higher serial.
    serial: input.now,
    validFrom: input.now,
    validTo: input.now + input.validForDays * 86_400,
    adminKeyId: input.adminKeyId,
  };
}

export async function buildApproval(input: BuildApprovalInput): Promise<BuiltApproval> {
  const { candidate, adminMachine } = input;
  if (!Number.isSafeInteger(input.validForDays) || input.validForDays < 1 || input.validForDays > 3650) throw new Error('the validity must be 1 to 3650 days');
  decodeBase64urlStrict(candidate.random, 16, 'candidacy random');
  const actualKeyId = await keyId(input.adminPublicKey);
  if (actualKeyId !== input.adminKeyId) {
    throw new Error(`the admin key id (${input.adminKeyId}) does not match the admin public key (${actualKeyId}): the key file is not the one pinned here. Nothing was signed; reload the page and check \`machine admin show\``);
  }
  const candidateBody = registrationBody(candidate, input);
  assertRegistrationBody(candidateBody);

  // The very first machine of a network is its admin machine: its own candidacy is approved, and it is no peer of itself.
  const selfApproval = adminMachine !== null && adminMachine.uuid === candidate.uuid;
  if (selfApproval && (adminMachine.identityPublicKey !== candidate.identityPublicKey || adminMachine.name !== candidate.name)) {
    throw new Error(`refusing to approve this candidacy: it claims the uuid of this machine (${candidate.uuid}) with another key or name than this machine has. Nothing was signed or sent: reject it`);
  }
  const pairWithAdmin = adminMachine !== null && !selfApproval ? adminMachine : null;

  const registrations: BuiltApproval['registrations'] = { candidate: await signRegistration(candidateBody, input.adminPrivateKey) };
  let pairSecret: string;
  if (pairWithAdmin !== null) {
    registrations.adminMachine = await signRegistration(registrationBody(pairWithAdmin, input), input.adminPrivateKey);
    pairSecret = await derivePairSecretFromSignature(input.adminPrivateKey, { uuid: candidate.uuid, serial: input.now }, { uuid: pairWithAdmin.uuid, serial: input.now });
  } else {
    // No pair: the entry only needs a value of the right size (as machine-cli `registerMachine` without a given secret).
    pairSecret = encodeBase64url(globalThis.crypto.getRandomValues(new Uint8Array(32)));
  }
  const secretBytes = decodeBase64urlStrict(pairSecret, 32, 'pair secret');

  const adminUuid = adminMachine?.uuid ?? null;
  const parts = (slot: string): SealContextParts => ({ adminUuid, candidateUuid: candidate.uuid, random: candidate.random, slot });
  const self = { registration: registrations.candidate, sealedPairSecret: await sealTo(candidate.identityPublicKey, secretBytes, pairSecretContext(parts('self'))) };
  const peers =
    pairWithAdmin === null
      ? []
      : [{ registration: registrations.adminMachine as SignedRegistration, sealedPairSecret: await sealTo(candidate.identityPublicKey, secretBytes, pairSecretContext(parts(`peer:${pairWithAdmin.uuid}`))) }];

  // `random` binds the approval to this candidacy (unsigned: the relay can set it, so it only catches old or mixed-up approvals).
  const plain = { v: 1, self, admin: { v: 1, adminPublicKey: input.adminPublicKey, adminKeyId: input.adminKeyId }, adminUuid, peers, random: candidate.random };
  const approval: SealedApproval = {
    v: 2,
    random: candidate.random,
    sealed: await sealTo(candidate.identityPublicKey, text(canonicalize(plain as unknown as Json)), approvalSealContext(candidate.uuid, candidate.random)),
  };
  const size = text(JSON.stringify(approval)).length;
  if (size > MAX_APPROVAL_BYTES) {
    throw new Error(`the approval is ${size} bytes once sealed, the relay accepts ${MAX_APPROVAL_BYTES} bytes: nothing was sent. It lists ${peers.length} peer(s): too many for one approval`);
  }

  const adminImport: CandidateImport | null =
    pairWithAdmin === null
      ? null
      : {
          registration: registrations.candidate,
          sealedPairSecret: await sealTo(pairWithAdmin.identityPublicKey, secretBytes, importCandidateSealContext(pairWithAdmin.uuid, candidate.uuid, candidate.random)),
          adminUuid: pairWithAdmin.uuid,
          candidateUuid: candidate.uuid,
          random: candidate.random,
        };
  secretBytes.fill(0);
  return { approval, adminImport, finalCode: await finalCode(candidate.identityPublicKey, input.adminPublicKey, candidate.random), registrations };
}
