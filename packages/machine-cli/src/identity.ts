import { randomUUID } from 'node:crypto';
import { hostname as osHostname } from 'node:os';
import { linkSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { decodeBase64urlStrict, generateSigningKeyPair, machineNameProblem, normalizeMachineName, signBytes, verifyBytes, type SigningKeyPair } from '@wadeck-app/machine-core';
import { MachineNameError, NotInitializedError } from './errors.js';
import { SECRETS_DIRNAME } from './paths.js';

export interface MachineIdentity {
  uuid: string;
  name: string;
  createdAt: string;
  identity: SigningKeyPair;
}

interface IdentityFile {
  v: 1;
  uuid: string;
  name: string;
  createdAt: string;
  publicKey: string;
  privateKey: string;
}

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const PKCS8_ED25519_BYTES = 48;
const PUBLIC_KEY_BYTES = 32;

export function identityFile(configDir: string): string {
  return join(configDir, SECRETS_DIRNAME, 'identity.json');
}

export interface NameChoice {
  name: string;
  /** One line for the person: what was derived or normalised. Absent when the typed name was already valid. */
  note?: string;
}

/**
 * The machine name (decision 52): a typed one is normalised (lowercase, letters, digits and hyphens), never refused for its
 * case; without one the computer name is used, cut at its first dot ("Midgard2.local" is "midgard2"). Both say what they did.
 */
export function chooseMachineName(typed: string | undefined, hostname: () => string = osHostname): NameChoice {
  if (typed !== undefined) {
    const r = normalizeMachineName(typed);
    if (!r.ok) throw new MachineNameError(r.message);
    return r.changed ? { name: r.name, note: `using the name "${r.name}" (typed: "${typed}"; a name is lowercase letters, digits and hyphens, and references are case-insensitive)` } : { name: r.name };
  }
  const raw = hostname();
  const firstLabel = raw.split('.')[0] ?? '';
  const r = normalizeMachineName(firstLabel.length > 0 ? firstLabel : raw);
  if (!r.ok) throw new MachineNameError(`the computer name ${JSON.stringify(raw)} cannot be turned into a machine name: pass one with --name <name> (letters, digits and hyphens, for example --name desktop)`);
  return {
    name: r.name,
    note: `name "${r.name}" taken from the computer name "${raw}" (it is the stable reference of this machine, signed at enrollment; for a friendlier local label later: machine alias set <label> ${r.name})`,
  };
}

/** The identity of this machine, created when there is none (the name from `chooseMachineName`). `--name` on an existing identity is refused, never ignored. */
export function ensureMachine(configDir: string, options: { name?: string; hostname?: () => string } = {}): { machine: MachineIdentity; created: boolean; note?: string } {
  let existing: MachineIdentity | undefined;
  try {
    existing = readMachine(configDir);
  } catch (e) {
    if (!(e instanceof NotInitializedError)) throw e;
  }
  if (existing !== undefined) {
    if (options.name !== undefined) {
      throw new MachineNameError(`this machine is already initialized as "${existing.name}" (${existing.uuid}): --name only applies when the identity is created, its name is signed at enrollment; for a friendlier local label use \`machine alias set <label> ${existing.name}\``);
    }
    return { machine: existing, created: false };
  }
  const choice = chooseMachineName(options.name, options.hostname);
  return { machine: initMachine(configDir, choice.name), created: true, ...(choice.note !== undefined ? { note: choice.note } : {}) };
}



/** Create this machine's UUID and identity key. Refuses to overwrite: a second identity would orphan every registration. */
export function initMachine(configDir: string, name: string): MachineIdentity {
  const problem = machineNameProblem(name);
  if (problem) throw new Error(`invalid machine name ${JSON.stringify(name)}: ${problem}`);
  const identity = generateSigningKeyPair();
  const file: IdentityFile = {
    v: 1,
    uuid: randomUUID(),
    name,
    createdAt: new Date().toISOString(),
    publicKey: identity.publicKey,
    privateKey: Buffer.from(identity.privateKeyPkcs8).toString('base64url'),
  };
  mkdirSync(join(configDir, SECRETS_DIRNAME), { recursive: true, mode: 0o700 });
  // Write the whole file under a temporary name, then link it to its final name: the link fails when the identity exists
  // (an existing identity is never replaced, no check-then-write race) and a crash never leaves a half-written identity.
  const target = identityFile(configDir);
  const temp = `${target}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(file, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  try {
    linkSync(temp, target);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EEXIST') {
      const existing = readMachine(configDir);
      throw new Error(`this machine is already initialized as "${existing.name}" (${existing.uuid}): its identity is kept; delete ${target} only to start over and enroll again`);
    }
    throw e;
  } finally {
    unlinkSync(temp);
  }
  return { uuid: file.uuid, name, createdAt: file.createdAt, identity };
}

export function readMachine(configDir: string): MachineIdentity {
  const path = identityFile(configDir);
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') throw new NotInitializedError();
    throw new Error(`cannot read ${path}: ${(e as Error).message}`);
  }
  // Reasons never include file content: the file holds the private key.
  const corrupt = (why: string) =>
    new Error(`${path} is corrupt or invalid (${why}): restore it from a backup, or delete it and run \`machine init --name <name>\` (a new identity must be enrolled again)`);
  let raw: Partial<IdentityFile>;
  try {
    raw = JSON.parse(text) as Partial<IdentityFile>;
  } catch {
    throw corrupt('not valid JSON');
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw corrupt('not an identity file');
  if (raw.v !== 1) throw corrupt('unknown version');
  if (typeof raw.uuid !== 'string' || !UUID_V4.test(raw.uuid)) throw corrupt('uuid is missing or malformed');
  if (typeof raw.name !== 'string' || machineNameProblem(raw.name)) throw corrupt('name is missing or invalid');
  if (typeof raw.createdAt !== 'string') throw corrupt('createdAt is missing');
  if (typeof raw.publicKey !== 'string' || typeof raw.privateKey !== 'string') throw corrupt('keys are missing');
  let privateKeyPkcs8: Uint8Array;
  try {
    decodeBase64urlStrict(raw.publicKey, PUBLIC_KEY_BYTES, 'public key');
    privateKeyPkcs8 = decodeBase64urlStrict(raw.privateKey, PKCS8_ED25519_BYTES, 'private key');
  } catch {
    throw corrupt('a key is not valid base64url of the expected length');
  }
  const probe = new TextEncoder().encode('machine identity self-check');
  if (!verifyBytes(raw.publicKey, probe, signBytes(privateKeyPkcs8, probe))) throw corrupt('the public key does not match the private key');
  return { uuid: raw.uuid, name: raw.name, createdAt: raw.createdAt, identity: { publicKey: raw.publicKey, privateKeyPkcs8 } };
}
