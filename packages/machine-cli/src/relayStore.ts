import { linkSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { writeFileAtomic } from './fsutil.js';
import { SECRETS_DIRNAME } from './paths.js';

// The relay token of this machine. It lives only in <configDir>/_secrets_/relay.json (mode 0600) and is never part of
// an error, a log line or a command answer: errors here name the file, never its content.

export interface RelayConfig {
  relayUrl: string;
  token: string;
  label: string;
  claimedAt: string;
}

export const relayFile = (configDir: string): string => join(configDir, SECRETS_DIRNAME, 'relay.json');
/** The full-access token of the admin console (`machine admin login`): kept apart from the machine token, same format and protection. */
export const relayAdminFile = (configDir: string): string => join(configDir, SECRETS_DIRNAME, 'relay-admin.json');

export function readRelayConfig(configDir: string): RelayConfig | undefined {
  return readConfigAt(relayFile(configDir), 'machine join <code>', 'a new code from the admin');
}

export function readRelayAdminConfig(configDir: string): RelayConfig | undefined {
  return readConfigAt(relayAdminFile(configDir), 'machine admin login <code>', 'a new pairing opened in the relay console');
}

function readConfigAt(path: string, command: string, codeSource: string): RelayConfig | undefined {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw new Error(`cannot read ${path}: ${(e as Error).message}`);
  }
  const corrupt = (why: string) => new Error(`${path} is corrupt or invalid (${why}): delete it and run \`${command}\` again with ${codeSource}`);
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw corrupt('not valid JSON');
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw corrupt('not a JSON object');
  const o = raw as Record<string, unknown>;
  for (const key of ['relayUrl', 'token', 'label', 'claimedAt'] as const) {
    if (typeof o[key] !== 'string') throw corrupt(`${key} is missing`);
  }
  if ((o.token as string).length === 0 || (o.relayUrl as string).length === 0) throw corrupt('relayUrl or token is empty');
  return { relayUrl: o.relayUrl as string, token: o.token as string, label: o.label as string, claimedAt: o.claimedAt as string };
}

/** Without `replace`, an existing relay.json is never overwritten (exclusive link, no check-then-write race). */
export function writeRelayConfig(configDir: string, config: RelayConfig, replace: boolean): void {
  writeConfigAt(configDir, relayFile(configDir), config, replace, 'this machine already joined a relay');
}

export function writeRelayAdminConfig(configDir: string, config: RelayConfig, replace: boolean): void {
  writeConfigAt(configDir, relayAdminFile(configDir), config, replace, 'this machine already holds an admin relay token');
}

function writeConfigAt(configDir: string, target: string, config: RelayConfig, replace: boolean, already: string): void {
  const content = `${JSON.stringify(config, null, 2)}\n`;
  if (replace) {
    writeFileAtomic(target, content, 0o600);
    return;
  }
  mkdirSync(join(configDir, SECRETS_DIRNAME), { recursive: true, mode: 0o700 });
  const temp = `${target}.${process.pid}.tmp`;
  writeFileSync(temp, content, { flag: 'wx', mode: 0o600 });
  try {
    linkSync(temp, target);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EEXIST') throw new Error(`${target} already exists: ${already}; pass --force to replace it`);
    throw e;
  } finally {
    unlinkSync(temp);
  }
}

// The pending candidacy of this machine, kept so that a later `machine join --resume` can continue after a Ctrl-C, a
// timeout or a lost SSH session. Not a secret itself, but once approved it holds the approval (pair secrets of the
// peers), so it lives next to the token with the same 0600 mode.

export interface CandidacyState {
  v: 1;
  id: string;
  random: string;
  name: string;
  identityPublicKey: string;
  createdAt: number;
  expiresAt: number;
  /** The approval as received from the relay, kept so that a refused or interrupted enrollment can be run again. */
  approval?: unknown;
}

export const candidacyFile = (configDir: string): string => join(configDir, SECRETS_DIRNAME, 'relay-candidacy.json');

export function readCandidacy(configDir: string): CandidacyState | undefined {
  const path = candidacyFile(configDir);
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw new Error(`cannot read ${path}: ${(e as Error).message}`);
  }
  const corrupt = (why: string) => new Error(`${path} is corrupt or invalid (${why}): delete it, then run \`machine join --resume\` to post a new candidacy`);
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw corrupt('not valid JSON');
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw corrupt('not a JSON object');
  const o = raw as Record<string, unknown>;
  for (const key of ['id', 'random', 'name', 'identityPublicKey'] as const) {
    if (typeof o[key] !== 'string' || (o[key] as string).length === 0) throw corrupt(`${key} is missing`);
  }
  for (const key of ['createdAt', 'expiresAt'] as const) {
    if (typeof o[key] !== 'number') throw corrupt(`${key} is missing`);
  }
  return {
    v: 1,
    id: o.id as string,
    random: o.random as string,
    name: o.name as string,
    identityPublicKey: o.identityPublicKey as string,
    createdAt: o.createdAt as number,
    expiresAt: o.expiresAt as number,
    ...(o.approval !== undefined ? { approval: o.approval } : {}),
  };
}

export function writeCandidacy(configDir: string, state: CandidacyState): void {
  writeFileAtomic(candidacyFile(configDir), `${JSON.stringify(state, null, 2)}\n`, 0o600);
}

export function deleteCandidacy(configDir: string): void {
  try {
    unlinkSync(candidacyFile(configDir));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error(`cannot delete ${candidacyFile(configDir)}: ${(e as Error).message}`);
  }
}
