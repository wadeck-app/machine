import { randomUUID } from 'node:crypto';
import { linkSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { decodeBase64urlStrict, generateSigningKeyPair, machineNameProblem, signBytes, verifyBytes, type SigningKeyPair } from '@wadeck-app/machine-core';
import { NotInitializedError } from './errors.js';
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
