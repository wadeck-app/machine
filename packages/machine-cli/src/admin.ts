import { existsSync, linkSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { writeFileAtomic } from './fsutil.js';
import { join } from 'node:path';
import {
  assertPolicyBody,
  decryptAdminKey,
  encryptAdminKey,
  generatePassphrase,
  generateSigningKeyPair,
  keyId,
  signPolicy,
  type AdminKeyEnvelope,
  type PolicyBody,
  type PolicyEntry,
  type SignedPolicy,
} from '@wadeck-app/machine-core';
import { SECRETS_DIRNAME } from './paths.js';

// Admin signing path of the CLI (decision 36): the admin key is encrypted on disk, the passphrase comes from a prompt
// only, and one invocation signs one document and exits. The same core functions serve the browser page (WP8).

const DEFAULT_WINDOW_SECONDS = 7 * 24 * 3600;

export function adminKeyFile(configDir: string): string {
  return join(configDir, SECRETS_DIRNAME, 'admin.key.json');
}

/** The pinned admin PUBLIC key: not a secret, so it lives next to the other configuration. */
export function adminPinFile(configDir: string): string {
  return join(configDir, 'admin.json');
}

export interface AdminPin {
  adminPublicKey: string;
  adminKeyId: string;
}

const NO_ADMIN_KEY = 'no admin key is known on this machine: run `machine admin init` on the machine that administers the network, or enroll this machine to receive the admin key';

export function readAdminPin(configDir: string): AdminPin {
  const file = adminPinFile(configDir);
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') throw new Error(NO_ADMIN_KEY);
    throw new Error(`cannot read ${file}: ${(e as Error).message}`);
  }
  let raw: { v?: unknown; adminPublicKey?: unknown; adminKeyId?: unknown };
  try {
    raw = JSON.parse(text) as typeof raw;
  } catch {
    throw new Error(`${file} is corrupt or invalid (not valid JSON): restore it from another machine`);
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error(`${file} is corrupt or invalid (not an admin pin file): restore it from another machine`);
  }
  if (raw.v !== 1 || typeof raw.adminPublicKey !== 'string' || typeof raw.adminKeyId !== 'string' || keyId(raw.adminPublicKey) !== raw.adminKeyId) {
    throw new Error(`${file} is corrupt or invalid (unexpected content): restore it from another machine`);
  }
  return { adminPublicKey: raw.adminPublicKey, adminKeyId: raw.adminKeyId };
}

/**
 * Create the admin key on THIS machine. Returns the generated passphrase: the caller shows it once and never stores it.
 * Refuses when an admin key exists: a second key would invalidate every signature already issued.
 */
export function adminInit(configDir: string): AdminPin & { passphrase: string } {
  const keyFile = adminKeyFile(configDir);
  if (existsSync(keyFile)) {
    throw new Error(`an admin key already exists (${keyFile}): it is kept; replacing it would invalidate every signed registration and policy. To start a new network, re-initialize every machine`);
  }
  if (existsSync(adminPinFile(configDir))) {
    throw new Error(
      `an admin key is already pinned (${adminPinFile(configDir)}) but its encrypted file is not on this machine: copy ${keyFile} from the machine that holds it. Running init here would replace the network's admin key`,
    );
  }
  const pair = generateSigningKeyPair();
  const passphrase = generatePassphrase();
  const envelope = encryptAdminKey(pair, passphrase);
  const pin: AdminPin = { adminPublicKey: pair.publicKey, adminKeyId: keyId(pair.publicKey) };
  mkdirSync(join(configDir, SECRETS_DIRNAME), { recursive: true, mode: 0o700 });
  // Complete file under a temporary name, then link: no half-written key file, no overwrite.
  const temp = `${keyFile}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(envelope, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  try {
    linkSync(temp, keyFile);
  } finally {
    unlinkSync(temp);
  }
  try {
    writeFileAtomic(adminPinFile(configDir), `${JSON.stringify({ v: 1, ...pin }, null, 2)}\n`, 0o644);
  } catch (e) {
    // Never leave a key without its pin: a retry would be refused and the machine stuck.
    unlinkSync(keyFile);
    throw new Error(`cannot write ${adminPinFile(configDir)}: ${(e as Error).message}; the admin key was not created, nothing changed`);
  }
  return { ...pin, passphrase };
}

function readEnvelope(configDir: string): AdminKeyEnvelope {
  const file = adminKeyFile(configDir);
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') throw new Error(`the encrypted admin key ${file} is missing: copy it from the machine that has it, or run \`machine admin init\``);
    throw new Error(`cannot read ${file}: ${(e as Error).message}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`${file} is corrupt or invalid (not valid JSON): copy it again from another machine`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${file} is corrupt or invalid (not an admin key file): copy it again from another machine`);
  }
  return parsed as AdminKeyEnvelope;
}

export type Prompt = (label: string) => Promise<string>;

async function unlock(configDir: string, pin: AdminPin, prompt: Prompt) {
  const envelope = readEnvelope(configDir);
  const passphrase = await prompt('Admin passphrase: ');
  let pair;
  try {
    pair = decryptAdminKey(envelope, passphrase);
  } catch (e) {
    throw new Error(`${(e as Error).message} (${adminKeyFile(configDir)})`);
  }
  if (pair.publicKey !== pin.adminPublicKey) {
    throw new Error(`the admin key file does not match the admin key pinned on this machine (${adminPinFile(configDir)}): one of them comes from another network`);
  }
  return pair;
}

function describeEntries(entries: PolicyEntry[], indent: string): string[] {
  if (entries.length === 0) return [`${indent}(none: everything is refused)`];
  return entries.map((e) => `${indent}${e.shell}  ${JSON.stringify(e.command)}${e.limits ? `  limits ${JSON.stringify(e.limits)}` : ''}`);
}

/** Everything the admin is about to sign, exactly as signed: commands are shown JSON-escaped so nothing hides in them. */
export function summarizePolicy(body: PolicyBody): string {
  const iso = (s: number) => new Date(s * 1000).toISOString();
  const lines = [
    `Policy for machine ${body.target}`,
    `  version ${body.version} (edited from version ${body.baseVersion}), admin key ${body.adminKeyId}`,
    `  may be applied from ${iso(body.notBefore)} until ${iso(body.notAfter)}`,
    '  default entries (peers without their own list):',
    ...describeEntries(body.defaults, '    '),
  ];
  for (const [peer, entries] of Object.entries(body.peers)) {
    lines.push(`  peer ${peer} (its own list replaces the default):`, ...describeEntries(entries, '    '));
  }
  return `${lines.join('\n')}\n`;
}

export interface SignOptions {
  /** Epoch seconds. */
  now: number;
  prompt: Prompt;
  /** Called with the summary before the passphrase is requested, so the admin sees what is signed first. */
  onSummary?: (summary: string) => void;
}

export async function signPolicyFile(configDir: string, draftFile: string, options: SignOptions): Promise<{ signed: SignedPolicy; summary: string }> {
  const pin = readAdminPin(configDir);
  let draft: Record<string, unknown>;
  try {
    draft = JSON.parse(readFileSync(draftFile, 'utf8')) as Record<string, unknown>;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') throw new Error(`policy draft ${draftFile} does not exist`);
    throw new Error(`policy draft ${draftFile} is not valid JSON: ${(e as Error).message}`);
  }
  // The admin states the substance; the tool fills only what is mechanical, and shows the result before signing.
  const body = {
    ...draft,
    adminKeyId: pin.adminKeyId,
    issuedAt: options.now,
    notBefore: draft.notBefore ?? options.now,
    notAfter: draft.notAfter ?? options.now + DEFAULT_WINDOW_SECONDS,
  };
  assertPolicyBody(body);
  const summary = summarizePolicy(body);
  options.onSummary?.(summary);
  const pair = await unlock(configDir, pin, options.prompt);
  return { signed: signPolicy(body, pair.privateKeyPkcs8), summary };
}

/** Decrypt the admin key after a passphrase prompt. The caller signs one document with it and drops it. */
export async function unlockAdminKey(configDir: string, prompt: Prompt) {
  return unlock(configDir, readAdminPin(configDir), prompt);
}

/** Machine side of enrollment: trust the admin PUBLIC key found in a file copied from the admin machine. */
export function pinAdminKey(configDir: string, file: string): AdminPin {
  let raw: { v?: unknown; adminPublicKey?: unknown; adminKeyId?: unknown } | null;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8')) as typeof raw;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') throw new Error(`${file} does not exist`);
    throw new Error(`${file} is not a valid admin pin file: ${(e as Error).message}`);
  }
  if (typeof raw !== 'object' || raw === null || raw.v !== 1 || typeof raw.adminPublicKey !== 'string' || typeof raw.adminKeyId !== 'string' || keyId(raw.adminPublicKey) !== raw.adminKeyId) {
    throw new Error(`${file} is not a valid admin pin file (it must be the admin.json of the admin machine)`);
  }
  if (existsSync(adminPinFile(configDir))) {
    const current = readAdminPin(configDir);
    if (current.adminPublicKey === raw.adminPublicKey) return current;
    throw new Error(`this machine already trusts another admin key (${current.adminKeyId}); pinning ${raw.adminKeyId} would move it to another network. Re-initialize this machine first if that is what you want`);
  }
  const pin = { adminPublicKey: raw.adminPublicKey, adminKeyId: raw.adminKeyId };
  writeFileAtomic(adminPinFile(configDir), `${JSON.stringify({ v: 1, ...pin }, null, 2)}\n`, 0o644);
  return pin;
}
