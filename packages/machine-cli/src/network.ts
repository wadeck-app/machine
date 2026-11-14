import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  DOCUMENT_SKEW_SECONDS,
  POLICY_DOMAIN,
  applyPolicy,
  applyRevocation,
  canonicalSignedRevocation,
  decodeBase64urlStrict,
  isUuid,
  machineNameProblem,
  mergeRevocations,
  revocationDigest,
  verifyRevocation,
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
import { withFileLock, writeFileAtomic } from './fsutil.js';
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
// The admin-signed lists kept for the catch-up between peers (bounded set): the merged entries carry no signature of their own.
const revocationListsFile = (configDir: string) => join(configDir, 'revocation-lists.json');
// The revocation version each peer announced at its last handshake: shown by `machine list`, so the admin sees who is behind.
const revocationSeenFile = (configDir: string) => join(configDir, 'revocation-seen.json');
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
  /** Epoch seconds, or a function read AFTER the passphrase was typed (a slow prompt must not backdate the registration). */
  now: number | (() => number);
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
  const issuedAt = typeof options.now === 'function' ? options.now() : options.now;
  const body: RegistrationBody = {
    v: 1,
    uuid: info.uuid,
    name: info.name,
    identityPublicKey: info.identityPublicKey,
    // A later registration of the same machine always has a higher serial.
    serial: issuedAt,
    validFrom: issuedAt,
    validTo: issuedAt + options.validForDays * 86_400,
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
  // The same clock tolerance as the documents that carry a registration (machine-core DOCUMENT_SKEW_SECONDS).
  const verified = verifyRegistration(bundle.registration, { adminPublicKey: pin.adminPublicKey, now: options.now, skewSeconds: DOCUMENT_SKEW_SECONDS });
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

/** Signed lists kept for the catch-up between peers: bounded, so a flood of lists cannot fill the disk or a frame. */
export const MAX_STORED_LISTS = 32;
const MAX_STORED_BYTES = 2 * 1024 * 1024;
/** A list dated further ahead than this (against the caller's clock) is refused: a far future date would hide it among older ones. */
export const MAX_FUTURE_SECONDS = 86_400;

export interface InstallOptions {
  /** The caller's clock (epoch seconds). Given: a list dated more than a day ahead is refused. */
  now?: number;
  /** How long to wait for another process that holds the lock (default 5 s). */
  lockTimeoutMs?: number;
  /** Tests: runs between the read and the write, inside the lock. */
  afterRead?: () => void;
}

export interface InstallResult {
  /** The merged entries grew. */
  changed: boolean;
  /** Lists dropped to stay within the bound (the oldest). */
  dropped: number;
}

const lockOptions = (o: InstallOptions) => (o.lockTimeoutMs !== undefined ? { timeoutMs: o.lockTimeoutMs } : {});

function covers(union: RevocationEntry[], list: RevocationEntry[]): boolean {
  return list.every((entry) => union.some((u) => u.uuid === entry.uuid && u.serial >= entry.serial));
}

/** Dedupe by signature, drop every list fully covered (uuid and serial) by the union of the others, then bound the set (oldest dropped first). */
function pruneLists(lists: SignedRevocation[]): { kept: SignedRevocation[]; dropped: number } {
  const bySignature = new Map<string, SignedRevocation>();
  for (const l of lists) bySignature.set(l.signature, l);
  let kept = [...bySignature.values()].sort((p, q) => p.body.issuedAt - q.body.issuedAt || p.body.entries.length - q.body.entries.length || (p.signature < q.signature ? -1 : 1));
  for (const candidate of [...kept]) {
    const others = kept.filter((l) => l !== candidate);
    if (others.length > 0 && covers(mergeRevocations(...others.map((l) => l.body.entries)), candidate.body.entries)) kept = others;
  }
  let dropped = 0;
  while (kept.length > MAX_STORED_LISTS || (kept.length > 1 && Buffer.byteLength(JSON.stringify(kept)) > MAX_STORED_BYTES)) {
    kept = kept.slice(1);
    dropped += 1;
  }
  return { kept, dropped };
}

function readStoredLists(configDir: string, adminPublicKey: string): SignedRevocation[] {
  const file = revocationListsFile(configDir);
  const raw = readJsonObject(file, 'delete it: the next admin revocation list restores it');
  if (!raw) return [];
  if (raw.v !== 1 || !Array.isArray(raw.lists)) throw new Error(`${file} is corrupt or invalid (unexpected shape): delete it, the next admin revocation list restores it`);
  return (raw.lists as unknown[]).map((value) => {
    const signed = canonicalSignedRevocation(value);
    const verified = verifyRevocation(signed, { adminPublicKey });
    if (!verified.ok) {
      throw new Error(`${file} does not match its admin signature (${verified.reason}: ${verified.message}): delete it, the next admin revocation list restores it`);
    }
    return signed;
  });
}

/** The body of an install, with the lock held and everything re-read: what another process wrote meanwhile is kept. */
function installLocked(configDir: string, adminPublicKey: string, signed: SignedRevocation, options: InstallOptions): InstallResult {
  const stored = readStoredLists(configDir, adminPublicKey);
  // A list already held is not verified again (cheap against a peer that repeats it).
  if (stored.some((l) => l.signature === signed.signature)) return { changed: false, dropped: 0 };
  const local = readRevocations(configDir);
  const applied = applyRevocation(local, signed, { adminPublicKey });
  if (!applied.ok) throw new Error(`revocation refused (${applied.reason}): ${applied.message}`);
  if (options.now !== undefined && signed.body.issuedAt > options.now + MAX_FUTURE_SECONDS) {
    throw new Error(`revocation refused (future): the list is dated ${signed.body.issuedAt}, more than a day in the future of this machine's clock (${options.now}): check the clock of the machine that signed it, or of this one`);
  }
  options.afterRead?.();
  if (applied.changed) writeFileAtomic(revocationsFile(configDir), `${JSON.stringify({ v: 1, entries: applied.entries }, null, 2)}\n`, 0o644);
  const { kept, dropped } = pruneLists([...stored, signed]);
  writeFileAtomic(revocationListsFile(configDir), `${JSON.stringify({ v: 1, lists: kept }, null, 2)}\n`, 0o644);
  return { changed: applied.changed, dropped };
}

/**
 * Merge an admin-signed revocation list (grow-only, whatever its date) and keep it for the catch-up between peers. Runs under a lock shared
 * with every other writer of the revocation files: the daemon, the inbox and the CLI never lose each other's update.
 */
export function installRevocation(configDir: string, signed: SignedRevocation, options: InstallOptions = {}): InstallResult {
  const pin = readAdminPin(configDir);
  let list: SignedRevocation;
  try {
    list = canonicalSignedRevocation(signed);
  } catch (e) {
    throw new Error(`revocation refused (malformed): ${(e as Error).message}`);
  }
  return withFileLock(revocationsFile(configDir), () => installLocked(configDir, pin.adminPublicKey, list, options), lockOptions(options));
}

/**
 * Admin side: build the list to sign from what is installed AT THIS MOMENT (read inside the lock, after any slow prompt), sign it with `build`,
 * and install it in the same locked step: an install that landed during the passphrase prompt is part of the signed union.
 */
export function signAndInstallRevocation(
  configDir: string,
  build: (current: { entries: RevocationEntry[]; version: number }) => SignedRevocation,
  options: InstallOptions = {},
): InstallResult & { signed: SignedRevocation } {
  const pin = readAdminPin(configDir);
  return withFileLock(
    revocationsFile(configDir),
    () => {
      const entries = readRevocations(configDir);
      const version = Math.max(0, ...readStoredLists(configDir, pin.adminPublicKey).map((l) => l.body.issuedAt));
      const signed = canonicalSignedRevocation(build({ entries, version }));
      return { ...installLocked(configDir, pin.adminPublicKey, signed, options), signed };
    },
    lockOptions(options),
  );
}

export interface RevocationState {
  /** revocationDigest of the merged entries. */
  digest: string;
  /** Informational: the highest issuedAt among the signed lists held here, 0 when none. */
  version: number;
  /** The admin-signed lists kept for the catch-up (canonical, verified against the pinned key). */
  lists: SignedRevocation[];
}

const stateCache = new Map<string, { key: string; state: RevocationState }>();

function fileKey(file: string): string {
  try {
    const s = statSync(file);
    return `${s.mtimeMs}:${s.size}:${s.ino}`;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return 'absent';
    throw e;
  }
}

/** What this machine tells a peer at handshake time about its revocations. Re-read only when one of the files changed. */
export function revocationState(configDir: string): RevocationState {
  const pin = readAdminPin(configDir);
  const key = [revocationsFile(configDir), revocationListsFile(configDir), adminPinFile(configDir)].map(fileKey).join('|');
  const cached = stateCache.get(configDir);
  if (cached && cached.key === key) return cached.state;
  const lists = readStoredLists(configDir, pin.adminPublicKey);
  const state: RevocationState = { digest: revocationDigest(readRevocations(configDir)), version: Math.max(0, ...lists.map((l) => l.body.issuedAt)), lists };
  stateCache.set(configDir, { key, state });
  return state;
}

export interface RevocationSeen {
  version: number;
  /** revocationDigest the peer announced: compared with ours to see who is out of sync. */
  digest: string;
  /** Epoch seconds of that handshake. */
  at: number;
}

const SEEN_HINT = 'it is rebuilt at the next handshake';

/** A corrupt file counts as empty and is reported through `onWarning`: it must never make `list` or `status` fail. */
export function readRevocationSeen(configDir: string, onWarning?: (message: string) => void): Record<string, RevocationSeen> {
  const file = revocationSeenFile(configDir);
  let raw: Record<string, unknown> | undefined;
  try {
    raw = readJsonObject(file, SEEN_HINT);
    if (!raw) return {};
    const peers = raw.peers;
    if (raw.v !== 1 || typeof peers !== 'object' || peers === null || Array.isArray(peers)) throw new Error(`${file} is corrupt or invalid (unexpected shape): ${SEEN_HINT}`);
    const out: Record<string, RevocationSeen> = {};
    for (const [uuid, value] of Object.entries(peers as Record<string, unknown>)) {
      const v = value as { version?: unknown; digest?: unknown; at?: unknown } | null;
      if (!isUuid(uuid) || typeof v?.version !== 'number' || typeof v.digest !== 'string' || typeof v.at !== 'number') throw new Error(`${file} is corrupt or invalid (bad entry for "${uuid}"): ${SEEN_HINT}`);
      out[uuid] = { version: v.version, digest: v.digest, at: v.at };
    }
    return out;
  } catch (e) {
    onWarning?.(`${(e as Error).message}; it is treated as empty`);
    return {};
  }
}

/** Remember what a peer announced. Locked read-modify-write: the daemon and the CLI do not lose each other's entries. */
export function recordRevocationSeen(configDir: string, peerUuid: string, announced: { version: number; digest: string }, now: number, onWarning?: (message: string) => void): void {
  withFileLock(revocationSeenFile(configDir), () => {
    const seen = readRevocationSeen(configDir, onWarning);
    seen[peerUuid] = { version: announced.version, digest: announced.digest, at: now };
    writeFileAtomic(revocationSeenFile(configDir), `${JSON.stringify({ v: 1, peers: seen }, null, 2)}\n`, 0o644);
  });
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
  // Order matters: highestSeen first (a version once started can never be applied again), then the policy, then the version.
  const highestSeen = Math.max(state.highestSeen, applied.body.version);
  writeFileAtomic(policyStateFile(configDir), `${JSON.stringify({ v: 1, version: state.version, highestSeen }, null, 2)}\n`, 0o644);
  writeFileAtomic(policyFile(configDir), `${JSON.stringify(signed, null, 2)}\n`, 0o644);
  writeFileAtomic(policyStateFile(configDir), `${JSON.stringify({ v: 1, version: applied.body.version, highestSeen }, null, 2)}\n`, 0o644);
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

/** The highest serial among the registrations stored here for `uuid`: what a revocation of that machine must cover. */
export function registeredSerial(configDir: string, uuid: string): number | undefined {
  let highest: number | undefined;
  for (const p of readPeers(configDir)) {
    const body = (p.registration as { body?: RegistrationBody } | undefined)?.body;
    if (body && body.uuid === uuid && (highest === undefined || body.serial > highest)) highest = body.serial;
  }
  return highest;
}

/**
 * The registrations of the peers this machine trusts right now (admin-signed, current, unrevoked, newest serial per machine):
 * what the admin distributes to the other peers. A registration that the directory left out is never handed on.
 */
export function trustedRegistrations(configDir: string, now: number): SignedRegistration[] {
  const network = loadNetwork(configDir, now);
  const stored = readPeers(configDir);
  const trusted: SignedRegistration[] = [];
  for (const machine of network.directory.machines()) {
    const peer = network.directory.find(machine.uuid);
    if (!peer) continue;
    let best: SignedRegistration | undefined;
    for (const p of stored) {
      const body = (p.registration as { body?: RegistrationBody } | undefined)?.body;
      if (!body || body.uuid !== machine.uuid || body.identityPublicKey !== peer.identityPublicKey) continue;
      if (best === undefined || body.serial > best.body.serial) best = p.registration;
    }
    if (best) trusted.push(best);
  }
  return trusted;
}
