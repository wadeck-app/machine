import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  POLICY_DOMAIN,
  applyPolicy,
  applyRevocation,
  decodeBase64urlStrict,
  isUuid,
  machineNameProblem,
  signRegistration,
  tryKeyId,
  verifyDocument,
  verifyRegistration,
  type PolicyBody,
  type RegistrationBody,
  type RevocationEntry,
  type SignedPolicy,
  type SignedRegistration,
  type SignedRevocation,
} from '@wadeck-app/machine-core';
import { readAdminPin, unlockAdminKey, adminPinFile, type Prompt } from './admin.js';
import { buildDirectory, type Directory, type PairedRegistration } from './directory.js';
import { writeFileAtomic } from './fsutil.js';
import { readMachine } from './identity.js';
import { SECRETS_DIRNAME } from './paths.js';

// What this machine knows about the network: the pinned admin key, the registrations of its peers with their pair
// secrets, the revocations and the policy in force. Every piece is admin-signed and re-verified when loaded.

export interface MachineInfo {
  v: 1;
  uuid: string;
  name: string;
  identityPublicKey: string;
}

/** What the admin hands to a machine so that it trusts a peer: the peer's signed registration and the pair secret. */
export interface PeerBundle {
  registration: SignedRegistration;
  /** 32 random bytes, unpadded base64url. */
  pairSecret: string;
}

const peersFile = (configDir: string) => join(configDir, SECRETS_DIRNAME, 'peers.json');
const revocationsFile = (configDir: string) => join(configDir, 'revocations.json');
const policyFile = (configDir: string) => join(configDir, 'policy.json');
const policyStateFile = (configDir: string) => join(configDir, 'policy-state.json');

function readJsonObject(file: string, what: string): Record<string, unknown> | undefined {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw new Error(`cannot read ${file}: ${(e as Error).message}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`${file} is corrupt or invalid (not valid JSON): ${what}`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${file} is corrupt or invalid (not an object): ${what}`);
  }
  return parsed as Record<string, unknown>;
}

export function exportMachineInfo(configDir: string): MachineInfo {
  const m = readMachine(configDir);
  return { v: 1, uuid: m.uuid, name: m.name, identityPublicKey: m.identity.publicKey };
}

function readPeers(configDir: string): PairedRegistration[] {
  const file = peersFile(configDir);
  const raw = readJsonObject(file, 'restore it from a backup or import the peers again');
  if (!raw) return [];
  if (raw.v !== 1 || !Array.isArray(raw.peers)) throw new Error(`${file} is corrupt or invalid (unexpected shape): restore it from a backup or import the peers again`);
  return (raw.peers as Array<{ registration?: unknown; pairSecret?: unknown }>).map((p) => ({
    registration: p?.registration as SignedRegistration,
    pairSecret: typeof p?.pairSecret === 'string' ? Buffer.from(p.pairSecret, 'base64url') : Buffer.alloc(0),
  }));
}

function writePeers(configDir: string, peers: PairedRegistration[]): void {
  const content = { v: 1, peers: peers.map((p) => ({ registration: p.registration, pairSecret: p.pairSecret.toString('base64url') })) };
  writeFileAtomic(peersFile(configDir), `${JSON.stringify(content, null, 2)}\n`, 0o600);
}

export interface RegisterOptions {
  now: number;
  prompt: Prompt;
  validForDays: number;
  /** Reuse the pair secret of an existing pairing (so both sides of a pair hold the same secret). */
  pairSecret?: string;
}

/** Admin side: sign the registration of a machine described by its info and produce the bundle to hand to its peer. */
export async function registerMachine(configDir: string, info: MachineInfo, options: RegisterOptions): Promise<PeerBundle> {
  if (typeof info !== 'object' || info === null || typeof info.uuid !== 'string' || !isUuid(info.uuid)) throw new Error('machine info: "uuid" is missing or not a UUID');
  const nameProblem = typeof info.name === 'string' ? machineNameProblem(info.name) : 'a name is required';
  if (nameProblem) throw new Error(`machine info: invalid name: ${nameProblem}`);
  if (typeof info.identityPublicKey !== 'string' || tryKeyId(info.identityPublicKey) === undefined) throw new Error('machine info: "identityPublicKey" is missing or not an Ed25519 public key');
  if (!Number.isSafeInteger(options.validForDays) || options.validForDays < 1 || options.validForDays > 3650) throw new Error('the validity must be 1 to 3650 days');
  const pairSecret = options.pairSecret ?? randomBytes(32).toString('base64url');
  decodeBase64urlStrict(pairSecret, 32, 'pair secret');

  const pin = readAdminPin(configDir);
  const admin = await unlockAdminKey(configDir, options.prompt);
  const body: RegistrationBody = {
    v: 1,
    uuid: info.uuid,
    name: info.name,
    identityPublicKey: info.identityPublicKey,
    // A later registration of the same machine always has a higher serial.
    serial: options.now,
    validFrom: options.now,
    validTo: options.now + options.validForDays * 86_400,
    adminKeyId: pin.adminKeyId,
  };
  return { registration: signRegistration(body, admin.privateKeyPkcs8), pairSecret };
}

/** Machine side: trust a peer. The registration must be signed by the admin key pinned here, otherwise nothing is stored. */
export function importPeer(configDir: string, bundle: PeerBundle, options: { now: number }): void {
  try {
    decodeBase64urlStrict(bundle?.pairSecret, 32, 'pair secret');
  } catch (e) {
    throw new Error(`the bundle's pair secret is invalid (${(e as Error).message}): ask the admin for a new bundle`);
  }
  const pin = readAdminPin(configDir);
  const verified = verifyRegistration(bundle.registration, { adminPublicKey: pin.adminPublicKey, now: options.now });
  if (!verified.ok) {
    throw new Error(`this machine does not trust that registration: it was not accepted by this network's admin key (${verified.reason}: ${verified.message})`);
  }
  const peers = readPeers(configDir);
  const kept = peers.filter((p) => {
    const body = (p.registration as { body?: RegistrationBody } | undefined)?.body;
    return !(body && body.uuid === verified.body.uuid && body.serial <= verified.body.serial);
  });
  kept.push({ registration: bundle.registration, pairSecret: Buffer.from(bundle.pairSecret, 'base64url') });
  writePeers(configDir, kept);
}

function readRevocations(configDir: string): RevocationEntry[] {
  const raw = readJsonObject(revocationsFile(configDir), 'restore it from another machine');
  if (!raw) return [];
  if (raw.v !== 1 || !Array.isArray(raw.entries)) throw new Error(`${revocationsFile(configDir)} is corrupt or invalid (unexpected shape): restore it from another machine`);
  return raw.entries as RevocationEntry[];
}

/** Merge an admin-signed revocation list. A list can only add revocations, never remove one. */
export function installRevocation(configDir: string, signed: SignedRevocation): { changed: boolean } {
  const pin = readAdminPin(configDir);
  const applied = applyRevocation(readRevocations(configDir), signed, { adminPublicKey: pin.adminPublicKey });
  if (!applied.ok) throw new Error(`revocation refused (${applied.reason}): ${applied.message}`);
  if (applied.changed) writeFileAtomic(revocationsFile(configDir), `${JSON.stringify({ v: 1, entries: applied.entries }, null, 2)}\n`, 0o644);
  return { changed: applied.changed };
}

interface PolicyState {
  version: number;
  highestSeen: number;
}

function readPolicyState(configDir: string): PolicyState {
  const raw = readJsonObject(policyStateFile(configDir), 'delete it only if you accept that an older policy could be installed again');
  if (!raw) return { version: 0, highestSeen: 0 };
  if (raw.v !== 1 || !Number.isSafeInteger(raw.version) || !Number.isSafeInteger(raw.highestSeen)) {
    throw new Error(`${policyStateFile(configDir)} is corrupt or invalid (unexpected shape): it protects against installing an older policy`);
  }
  return { version: raw.version as number, highestSeen: raw.highestSeen as number };
}

/** Install a policy signed by the pinned admin for THIS machine. Nothing changes when it is refused. */
export function installPolicy(configDir: string, signed: SignedPolicy, options: { now: number }): PolicyBody {
  const pin = readAdminPin(configDir);
  const self = readMachine(configDir);
  const state = readPolicyState(configDir);
  const applied = applyPolicy(state, signed, { adminPublicKey: pin.adminPublicKey, now: options.now, targetUuid: self.uuid });
  if (!applied.ok) throw new Error(`policy refused (${applied.reason}): ${applied.message}`);
  writeFileAtomic(policyFile(configDir), `${JSON.stringify(signed, null, 2)}\n`, 0o644);
  writeFileAtomic(
    policyStateFile(configDir),
    `${JSON.stringify({ v: 1, version: applied.body.version, highestSeen: Math.max(state.highestSeen, applied.body.version) }, null, 2)}\n`,
    0o644,
  );
  return applied.body;
}

export interface Network {
  /** An admin key is pinned: this machine belongs to a network. */
  enrolled: boolean;
  directory: Directory;
  policy: PolicyBody | undefined;
  revocations: RevocationEntry[];
  /** Everything that was left out and why: shown by `machine status`, never silent. */
  problems: string[];
}

function loadPolicy(configDir: string, adminPublicKey: string, problems: string[]): PolicyBody | undefined {
  const raw = readJsonObject(policyFile(configDir), 'reinstall the policy');
  if (!raw) return undefined;
  const signed = raw as unknown as SignedPolicy;
  // Re-verified at every load: a policy file edited by hand is not a policy.
  if (typeof signed.signature !== 'string' || typeof signed.body !== 'object' || signed.body === null || !verifyDocument(POLICY_DOMAIN, signed.body as never, adminPublicKey, signed.signature)) {
    problems.push(`${policyFile(configDir)} does not match its admin signature: it is ignored and every command is refused until a valid policy is installed`);
    return undefined;
  }
  return signed.body;
}

export function loadNetwork(configDir: string, now: number): Network {
  const self = readMachine(configDir);
  if (!existsSync(adminPinFile(configDir))) {
    return {
      enrolled: false,
      directory: buildDirectory([], { adminPublicKey: '', now, revocations: [], selfUuid: self.uuid }),
      policy: undefined,
      revocations: [],
      problems: [],
    };
  }
  const pin = readAdminPin(configDir);
  const revocations = readRevocations(configDir);
  const directory = buildDirectory(readPeers(configDir), { adminPublicKey: pin.adminPublicKey, now, revocations, selfUuid: self.uuid });
  const problems = [...directory.problems];
  const policy = loadPolicy(configDir, pin.adminPublicKey, problems);
  return { enrolled: true, directory, policy, revocations, problems };
}
