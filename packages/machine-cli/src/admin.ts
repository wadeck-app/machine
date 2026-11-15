import { existsSync, linkSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { writeFileAtomic } from './fsutil.js';
import { join } from 'node:path';
import {
  assertPolicyBody,
  adminKeyHint,
  checkHint,
  checkPassphrase,
  passphraseAdvice,
  PASSPHRASE_MIN_LENGTH,
  PASSPHRASE_RECOMMENDED_LENGTH,
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
import { PromptTimeoutError } from './prompt.js';
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
export function adminInit(configDir: string, chosen?: string, hint?: string): AdminPin & { passphrase: string; generated: boolean } {
  const keyFile = adminKeyFile(configDir);
  assertCanInitAdminKey(configDir);
  const pair = generateSigningKeyPair();
  // A chosen passphrase (decision 51) is checked by encryptAdminKey too: the rule lives in one place (machine-core).
  const passphrase = chosen ?? generatePassphrase();
  const envelope = encryptAdminKey(pair, passphrase, hint !== undefined ? { hint } : {});
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
  return { ...pin, passphrase, generated: chosen === undefined };
}

/** Refuses when an admin key exists or is pinned here: checked BEFORE a passphrase is asked, so that nobody types one for nothing. */
export function assertCanInitAdminKey(configDir: string): void {
  const keyFile = adminKeyFile(configDir);
  if (existsSync(keyFile)) {
    throw new Error(`an admin key already exists (${keyFile}): it is kept; replacing it would invalidate every signed registration and policy. To start a new network, re-initialize every machine`);
  }
  if (existsSync(adminPinFile(configDir))) {
    throw new Error(
      `an admin key is already pinned (${adminPinFile(configDir)}) but its encrypted file is not on this machine: copy ${keyFile} from the machine that holds it. Running init here would replace the network's admin key`,
    );
  }
}

/** Decision 57: a typo at the confirmation, or a passphrase that fails the rules, is asked again; this many attempts in all. */
export const PASSPHRASE_ATTEMPTS = 3;

export interface PassphraseIo {
  /** The explanation paragraph (normal output channel). */
  say: (text: string) => void;
  /** A reason to try again (error channel; never contains a passphrase or a hint). */
  warn: (text: string) => void;
  /** A visible question (the hint). */
  ask: (label: string) => Promise<string>;
}

const HINT_LABEL = 'Hint to help you remember it (optional, shown on every unlock, never write the passphrase itself): ';

/**
 * The passphrase of a new admin key (decision 51): chosen at the hidden prompt (typed twice), or generated (`--generate`, or an
 * empty answer: the hidden prompt cannot show a typo, and a random 100-bit phrase shown once is never worse than what was meant).
 * A mistake is asked again with the reason (PASSPHRASE_ATTEMPTS attempts in all), then it fails with "nothing was created".
 * The prompts are short; the explanation is a separate paragraph above them. Then the optional hint (decision 57).
 * Nothing is created here. `advice` is the single warning line for a valid but short passphrase.
 */
export async function askAdminPassphrase(
  prompt: Prompt,
  options: { generate: boolean; hint?: string } & PassphraseIo,
): Promise<{ chosen: string | undefined; advice: string | undefined; hint: string | undefined }> {
  if (options.generate) return { chosen: undefined, advice: undefined, hint: options.hint };
  options.say(
    '\nThe admin passphrase protects the key that signs every machine and policy of your network (an encrypted copy of it goes to every machine).\n' +
      `At least ${PASSPHRASE_MIN_LENGTH} characters, ${PASSPHRASE_RECOMMENDED_LENGTH} or more recommended. Press Enter at the first prompt to get a random one instead.\n\n`,
  );
  const again = (reason: string, attempt: number, final: string): void => {
    if (attempt >= PASSPHRASE_ATTEMPTS) throw new Error(final);
    options.warn(`[warn] ${reason}. Try again (attempt ${attempt} of ${PASSPHRASE_ATTEMPTS} used)\n`);
  };
  let chosen: string | undefined;
  for (let attempt = 1; chosen === undefined; attempt++) {
    let first: string;
    try {
      first = await prompt('Admin passphrase: ');
    } catch (e) {
      if (e instanceof PromptTimeoutError) throw e;
      const noTerminal = /interactive terminal/.test((e as Error).message);
      throw new Error(`${(e as Error).message}${noTerminal ? '; in a script or without a terminal use `machine admin init --generate` (a random passphrase, shown once)' : ''}`);
    }
    if (first.length === 0) return { chosen: undefined, advice: undefined, hint: options.hint };
    const check = checkPassphrase(first);
    if (!check.ok) {
      again(check.message, attempt, `${check.message}. Nothing was created`);
      continue;
    }
    const second = await prompt('Confirm passphrase: ');
    if (second !== first) {
      again('the two passphrases do not match', attempt, 'the two passphrases do not match: nothing was created, run the command again');
      continue;
    }
    chosen = first;
  }
  return { chosen, advice: passphraseAdvice(chosen), hint: await askHint(chosen, options) };
}

/** The optional hint (decision 57): the flag when given, else a visible question (Enter = none). A hint that gives the passphrase away is refused. */
async function askHint(passphrase: string, options: { hint?: string } & PassphraseIo): Promise<string | undefined> {
  if (options.hint !== undefined) {
    const check = checkHint(options.hint, passphrase);
    if (!check.ok) throw new Error(`--hint: ${check.message}. Nothing was created`);
    return options.hint;
  }
  for (let attempt = 1; ; attempt++) {
    let answer: string;
    try {
      answer = (await options.ask(HINT_LABEL)).trim();
    } catch (e) {
      if (e instanceof PromptTimeoutError) throw e;
      throw new Error(`${(e as Error).message}; the hint question needs a terminal: pass \`--hint <text>\` to give it without a question. Nothing was created`);
    }
    if (answer.length === 0) return undefined;
    const check = checkHint(answer, passphrase);
    if (check.ok) return answer;
    if (attempt >= PASSPHRASE_ATTEMPTS) throw new Error(`${check.message}. Nothing was created`);
    options.warn(`[warn] ${check.message}. Try again, or press Enter for no hint (attempt ${attempt} of ${PASSPHRASE_ATTEMPTS} used)\n`);
  }
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
  // Decision 57: the hint (stored in clear in the key file) is shown above the short prompt, on every machine.
  let hint: string | undefined;
  try {
    hint = adminKeyHint(envelope);
  } catch (e) {
    throw new Error(`${(e as Error).message} (${adminKeyFile(configDir)})`);
  }
  const passphrase = await prompt(hint === undefined ? 'Admin passphrase: ' : `Hint: ${hint}\nAdmin passphrase: `);
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

export async function signPolicyFile(configDir: string, draftFile: string, options: SignOptions): Promise<{ signed: SignedPolicy; summary: string; privateKeyPkcs8: Uint8Array }> {
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
  return { signed: signPolicy(body, pair.privateKeyPkcs8), summary, privateKeyPkcs8: pair.privateKeyPkcs8 };
}

/** Decrypt the admin key after a passphrase prompt. The caller signs one document with it and drops it. */
export async function unlockAdminKey(configDir: string, prompt: Prompt) {
  return unlock(configDir, readAdminPin(configDir), prompt);
}

/** Machine side of enrollment: trust the admin PUBLIC key found in a file copied from the admin machine. */
export function pinAdminKey(configDir: string, file: string): AdminPin {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') throw new Error(`${file} does not exist`);
    throw new Error(`${file} is not a valid admin pin file: ${(e as Error).message}`);
  }
  return pinAdminDocument(configDir, raw, `${file} is not a valid admin pin file (it must be the admin.json of the admin machine)`);
}

/** Validate an admin pin document (what `admin.json` holds) without touching the disk. Throws `invalidMessage` when it is not one. */
export function parseAdminPinDocument(raw: unknown, invalidMessage: string): AdminPin {
  const o = raw as { v?: unknown; adminPublicKey?: unknown; adminKeyId?: unknown } | null;
  if (typeof o !== 'object' || o === null || o.v !== 1 || typeof o.adminPublicKey !== 'string' || typeof o.adminKeyId !== 'string') throw new Error(invalidMessage);
  let matches = false;
  try {
    matches = keyId(o.adminPublicKey) === o.adminKeyId;
  } catch {
    matches = false;
  }
  if (!matches) throw new Error(invalidMessage);
  return { adminPublicKey: o.adminPublicKey, adminKeyId: o.adminKeyId };
}

/** A different admin key is already pinned: refused, because moving to it would move this machine to another network. */
export function assertPinCompatible(configDir: string, pin: AdminPin): { alreadyPinned: boolean } {
  if (!existsSync(adminPinFile(configDir))) return { alreadyPinned: false };
  const current = readAdminPin(configDir);
  if (current.adminPublicKey === pin.adminPublicKey) return { alreadyPinned: true };
  throw new Error(`this machine already trusts another admin key (${current.adminKeyId}); pinning ${pin.adminKeyId} would move it to another network. Re-initialize this machine first if that is what you want`);
}

/** Pin the admin key of an already parsed pin document: the one place where an admin key becomes trusted on this machine. */
export function pinAdminDocument(configDir: string, raw: unknown, invalidMessage: string): AdminPin {
  const pin = parseAdminPinDocument(raw, invalidMessage);
  if (assertPinCompatible(configDir, pin).alreadyPinned) return readAdminPin(configDir);
  writeFileAtomic(adminPinFile(configDir), `${JSON.stringify({ v: 1, ...pin }, null, 2)}
`, 0o644);
  return pin;
}
