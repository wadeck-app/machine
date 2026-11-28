import { existsSync, linkSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import {
  DEFAULT_APPLY_WINDOW_SECONDS,
  PASSPHRASE_MIN_LENGTH,
  PASSPHRASE_RECOMMENDED_LENGTH,
  adminKeyHint,
  checkHint,
  checkPassphrase,
  commandForHint,
  decryptAdminKey,
  encryptAdminKey,
  entryKey,
  generateSigningKeyPair,
  isTyped,
  keyId,
  nextPolicyBody,
  parseTemplate,
  resolveMachineRef,
  signPolicy,
  templateExamples,
  type AdminKeyEnvelope,
  type InputDeclaration,
  type LifetimeInput,
  type PolicyBody,
  type PolicyEntry,
  type Shell,
  type SigningKeyPair,
} from '@wadeck-app/machine-core';
import { PASSPHRASE_ATTEMPTS, askHint, type PassphraseIo, type Prompt } from './admin.js';
import { unchangedMessage } from './adminAllow.js';
import { UnresolvedReferenceError } from './adminRevoke.js';
import { unsafeTypedWarnings } from './allowSafety.js';
import { buildAllowEntry, entryLine, inputSummary, leftOutLines, platformOfShell, renewalLines, typedSummary } from './allowText.js';
import { FileUsageStore } from './stores.js';
import { join } from 'node:path';
import { writeFileAtomic } from './fsutil.js';
import { clockText, relativeText } from './humanTime.js';
import { exportMachineInfo, installPolicy, loadNetwork, activePolicyState } from './network.js';
import { localPolicyKeyFile, modeFileContent, policyFiles, policyModeFile, readPolicyMode } from './policyMode.js';
import { PromptTimeoutError } from './prompt.js';
import { networkAliasMap } from './aliasesStore.js';
import { readAliases } from './state.js';

// Policy mode `local` (hard rule 4 as amended): this machine manages its own allow list with its OWN policy key, independent of the
// admin machine. The passphrase is asked every time (nothing is cached), at the hidden prompt only.

const KEY_LABEL = 'local policy key file';
const PASSPHRASE_PROMPT = 'Local policy passphrase: ';

/** Same envelope and rules as the admin key; the advice never offers a generated passphrase (the local key has none). */
const LOCAL_FIX = 'type a longer one';

export interface LocalIo {
  prompt: Prompt;
  /** A visible question; rejects without a terminal. */
  ask: (label: string) => Promise<string>;
  say: (text: string) => void;
  warn: (text: string) => void;
  /** Epoch seconds. */
  now: () => number;
}

const isYes = (answer: string): boolean => /^\s*(y|yes)\s*$/i.test(answer);

async function confirm(io: LocalIo, question: string, whatNotDone: string, command: string): Promise<void> {
  let answer: string;
  try {
    answer = await io.ask(question);
  } catch (e) {
    if (e instanceof PromptTimeoutError) throw e;
    throw new Error(`no terminal to confirm: run \`${command}\` in a terminal window. ${whatNotDone}`);
  }
  if (!isYes(answer)) throw new Error(`not confirmed: ${whatNotDone}`);
}


/** A file that appears complete or not at all, and never over an existing file. */
function writeNewFile(file: string, content: string, mode: number): void {
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, content, { flag: 'wx', mode });
  try {
    linkSync(temp, file);
  } finally {
    unlinkSync(temp);
  }
}

function readKeyEnvelope(configDir: string): AdminKeyEnvelope {
  const file = localPolicyKeyFile(configDir);
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`the encrypted local policy key ${file} is missing: this machine cannot sign its allow list. The way back to the admin without the key is in getting-started.md ("Forgotten local passphrase": delete the local files by hand while the daemon is stopped)`);
    }
    throw new Error(`cannot read ${file}: ${(e as Error).message}`);
  }
  try {
    const parsed = JSON.parse(text) as unknown;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('not an object');
    return parsed as AdminKeyEnvelope;
  } catch {
    throw new Error(`${file} is corrupt or invalid (not a key file): restore it from a backup`);
  }
}

/** The passphrase is typed now, every time; the hint (stored in clear in the key file) is shown above the prompt. */
async function unlockLocalKey(configDir: string, expectedPublicKey: string, prompt: Prompt): Promise<SigningKeyPair> {
  const envelope = readKeyEnvelope(configDir);
  const file = localPolicyKeyFile(configDir);
  let hint: string | undefined;
  try {
    hint = adminKeyHint(envelope);
  } catch (e) {
    throw new Error(`${(e as Error).message.replace('admin key file', KEY_LABEL)} (${file})`);
  }
  const passphrase = await prompt(hint === undefined ? PASSPHRASE_PROMPT : `Hint: ${hint}\n${PASSPHRASE_PROMPT}`);
  let pair: SigningKeyPair;
  try {
    pair = decryptAdminKey(envelope, passphrase, KEY_LABEL);
  } catch (e) {
    throw new Error(`${(e as Error).message} (${file})`);
  }
  if (pair.publicKey !== expectedPublicKey) {
    throw new Error(`the local policy key file does not match the public key pinned in ${policyModeFile(configDir)}: one of them was replaced; restore the right file`);
  }
  return pair;
}

/**
 * A new local passphrase, typed twice at the hidden prompt, with the rules of the admin key (decision 51 and 57): a mistake is asked again,
 * PASSPHRASE_ATTEMPTS attempts in all. Unlike the admin key there is no generated passphrase: an empty answer is refused.
 */
async function askLocalPassphrase(io: LocalIo & PassphraseIo, hint: string | undefined): Promise<{ passphrase: string; hint: string | undefined }> {
  io.say(
    `The local passphrase protects the key that signs the allow list of THIS machine: whoever has it and a copy of this machine's files decides what peers may run here.\nAt least ${PASSPHRASE_MIN_LENGTH} characters, ${PASSPHRASE_RECOMMENDED_LENGTH} or more recommended. It is asked every time you change the list; nothing is cached, and it cannot be recovered.\n\n`,
  );
  const again = (reason: string, attempt: number, final: string): void => {
    if (attempt >= PASSPHRASE_ATTEMPTS) throw new Error(final);
    io.warn(`[warn] ${reason}. Try again (attempt ${attempt} of ${PASSPHRASE_ATTEMPTS} used)\n`);
  };
  for (let attempt = 1; ; attempt++) {
    let first: string;
    try {
      first = await io.prompt(PASSPHRASE_PROMPT);
    } catch (e) {
      if (e instanceof PromptTimeoutError) throw e;
      throw new Error(`${(e as Error).message}; a local policy key needs a passphrase typed at a terminal. Nothing was created`);
    }
    if (first.length === 0) throw new Error('a passphrase is required: the local policy key cannot be created without one. Nothing was created');
    const check = checkPassphrase(first, LOCAL_FIX);
    if (!check.ok) {
      again(check.message, attempt, `${check.message}. Nothing was created`);
      continue;
    }
    const second = await io.prompt('Confirm passphrase: ');
    if (second !== first) {
      again('the two passphrases do not match', attempt, 'the two passphrases do not match: nothing was created, run the command again');
      continue;
    }
    const chosenHint = await askHint(first, { ...(hint !== undefined ? { hint } : {}), say: io.say, warn: io.warn, ask: io.ask });
    const length = Array.from(first.normalize('NFKC')).length;
    if (length < PASSPHRASE_RECOMMENDED_LENGTH) {
      io.warn(`[warn] this passphrase has ${length} characters (${PASSPHRASE_RECOMMENDED_LENGTH} or more is recommended): an encrypted copy of the local key is on this machine, so someone who steals it can try to guess the passphrase offline\n`);
    }
    return { passphrase: first, hint: chosenHint };
  }
}

/** Where the files of the local line go when it is left: renamed next to themselves, never deleted, never reused. */
const archived = (file: string, id: string): string => `${file}.archived-${id.slice(0, 8)}`;

export interface EnableResult {
  keyId: string;
  publicKey: string;
  /** Entries of the admin-signed list that stopped applying (it is kept on disk, ignored in mode local). */
  setAside: number;
}

/** `machine policy local enable`. Nothing is created when it is refused or cancelled. */
export async function runLocalEnable(configDir: string, o: LocalIo & { hint?: string }): Promise<EnableResult> {
  const self = exportMachineInfo(configDir);
  const current = readPolicyMode(configDir);
  if (current.mode === 'local') {
    throw new Error(`this machine already manages its own allow list (policy key ${current.localKeyId}): \`machine policy delegate\` gives it back to the admin, \`machine policy allow\` edits it`);
  }
  const keyFile = localPolicyKeyFile(configDir);
  if (existsSync(keyFile)) {
    throw new Error(`a local policy key file is already there (${keyFile}) although this machine is in mode admin: a previous \`machine policy delegate\` was interrupted, or the file was copied here. It is not used: move it away (or delete it) and run this command again. Nothing was changed`);
  }
  if (o.hint !== undefined) {
    const early = checkHint(o.hint);
    if (!early.ok) throw new Error(`--hint: ${early.message}. Nothing was created`);
  }
  const network = loadNetwork(configDir, o.now());
  const inForce = network.policy;
  o.say(
    [
      `Policy mode local for "${self.name}": this machine will manage its own allow list, with its own policy key, independent of the admin machine.`,
      '  - policies signed by the admin key are REFUSED here from now on (and audited when they arrive through the relay inbox);',
      '  - the allow list starts EMPTY: every command from a peer is refused until you run `machine policy allow`;',
      '  - this changes nothing else: who is trusted and who is revoked still comes from the admin (registrations and revocations).',
      '',
    ].join('\n'),
  );
  if (inForce !== undefined && (inForce.defaults.length > 0 || Object.keys(inForce.peers).length > 0)) {
    const lines = [...inForce.defaults.map((e) => `    ${entryLine(e, o.now())}`), ...Object.entries(inForce.peers).map(([peer, entries]) => `    only for ${peer}: ${entries.map((e) => entryLine(e, o.now())).join('; ')}`)];
    o.say(`The list signed by the admin (version ${inForce.version}) stops applying and is kept on disk, unused:\n${lines.join('\n')}\nAdd again what you still want with \`machine policy allow\`.\n\n`);
    await confirm(o, 'Stop applying the admin-signed list and manage it locally? [y/N] ', 'Nothing was created or changed', 'machine policy local enable');
  }
  const { passphrase, hint } = await askLocalPassphrase(o, o.hint);
  const pair = generateSigningKeyPair();
  const envelope = encryptAdminKey(pair, passphrase, hint !== undefined ? { hint } : {});
  const id = keyId(pair.publicKey);
  writeNewFile(keyFile, `${JSON.stringify(envelope, null, 2)}\n`, 0o600);
  try {
    // An old local policy document (an interrupted delegate) is not verifiable with the new key: moved aside, said.
    const staleFile = policyFiles(configDir, 'local').policy;
    if (existsSync(staleFile)) {
      renameSync(staleFile, archived(staleFile, id));
      o.say(`[info] an old local policy file was moved to ${archived(staleFile, id)}\n`);
    }
    // The mode file comes last: it is what switches the machine over.
    writeFileAtomic(policyModeFile(configDir), modeFileContent({ mode: 'local', localPublicKey: pair.publicKey, localKeyId: id, since: o.now() }), 0o644);
  } catch (e) {
    unlinkSync(keyFile);
    throw new Error(`cannot switch this machine to mode local: ${(e as Error).message}; nothing changed`);
  }
  return { keyId: id, publicKey: pair.publicKey, setAside: (inForce?.defaults.length ?? 0) + Object.values(inForce?.peers ?? {}).reduce((n, l) => n + l.length, 0) };
}

export interface DelegateResult {
  archivedKey: string;
  archivedPolicy: string | undefined;
}

/** `machine policy delegate`: leave mode local. The effective list becomes EMPTY until the admin signs one. */
export async function runDelegate(configDir: string, o: LocalIo): Promise<DelegateResult> {
  const mode = readPolicyMode(configDir);
  if (mode.mode !== 'local') {
    throw new Error('the allow list of this machine is already managed by the admin: nothing to give back (`machine policy local enable` is the way to manage it locally)');
  }
  const self = exportMachineInfo(configDir);
  const network = loadNetwork(configDir, o.now());
  const entries = (network.policy?.defaults.length ?? 0) + Object.values(network.policy?.peers ?? {}).reduce((n, l) => n + l.length, 0);
  const keyFile = localPolicyKeyFile(configDir);
  o.say(
    [
      `Giving the allow list of "${self.name}" back to the admin:`,
      `  - the local list${network.policy === undefined ? ' (none is installed)' : ` (version ${network.policy.version}, ${entries} entr${entries === 1 ? 'y' : 'ies'})`} stops applying: the allow list becomes EMPTY, every command from a peer is refused,`,
      '    until the admin signs and sends a policy for this machine (`machine admin allow <this machine> -- <command>` on the admin machine);',
      `  - the local policy key is archived next to its place (${archived(keyFile, mode.localKeyId)}), no longer used; delete it by hand when you do not need it any more;`,
      '  - an admin-signed policy is accepted again, a document signed by the local key is refused.',
      '',
    ].join('\n'),
  );
  await confirm(o, 'Give the allow list back to the admin, leaving it EMPTY until then? [y/N] ', 'Nothing was changed', 'machine policy delegate');
  o.say('Enter the local policy passphrase to confirm, Ctrl-C to cancel.\n');
  await unlockLocalKey(configDir, mode.localPublicKey, o.prompt);

  // Order: first what makes the admin line empty (the old admin list never comes back by itself), then the mode switch, then the archive.
  const admin = policyFiles(configDir, 'admin');
  if (existsSync(admin.policy)) renameSync(admin.policy, archived(admin.policy, mode.localKeyId));
  unlinkSync(policyModeFile(configDir));
  const archivedKey = archived(keyFile, mode.localKeyId);
  renameSync(keyFile, archivedKey);
  const local = policyFiles(configDir, 'local');
  let archivedPolicy: string | undefined;
  if (existsSync(local.policy)) {
    archivedPolicy = archived(local.policy, mode.localKeyId);
    renameSync(local.policy, archivedPolicy);
  }
  return { archivedKey, archivedPolicy };
}

export interface LocalAllowOptions extends LocalIo {
  mode: 'allow' | 'remove' | 'list';
  /** The command line (or the template), for `allow` and `remove`. */
  command?: string;
  /** `allow`: --times, --for or --until (permanent when none). */
  lifetime?: LifetimeInput;
  /** `--stdin text|json --stdin-chars ...`: the input the entry accepts (decision 114). */
  input?: InputDeclaration;
  inputAdded?: readonly string[];
  /** `allow --renew`: replace the entry even with the same limits; its counter starts again. */
  renew?: boolean;
  /** `remove`: the 1-based place in the list shown by `machine allowed` (or `--list`), instead of the command. */
  index?: number;
  shell?: Shell;
  /** A peer (name, alias, uuid): its OWN list is edited. */
  peer?: string;
  defaultShell: Shell;
}

export type LocalAllowResult =
  | { kind: 'listed'; version: number; policyMode: 'admin' | 'local' }
  | { kind: 'unchanged'; reason: 'already-allowed' | 'not-allowed' | 'bad-index' | 'ambiguous' }
  | { kind: 'signed'; version: number; keyId: string };

/** `machine policy allow`: the next policy of THIS machine, signed with the local policy key and installed here (no relay involved). */
export async function runLocalAllow(configDir: string, o: LocalAllowOptions): Promise<LocalAllowResult> {
  const self = exportMachineInfo(configDir);
  const mode = readPolicyMode(configDir);
  const network = loadNetwork(configDir, o.now());
  const nameOf = (uuid: string): string => (uuid === self.uuid ? self.name : network.directory.machines().find((m) => m.uuid === uuid)?.name ?? uuid);

  if (o.mode === 'list') {
    const managed = mode.mode === 'local' ? 'managed locally' : 'managed by the admin';
    const current = network.policy;
    if (current === undefined) {
      o.say(`Nothing is allowed on this machine "${self.name}" yet (${managed}): no policy is installed, so every command is refused.\n`);
      return { kind: 'listed', version: 0, policyMode: mode.mode };
    }
    o.say(`Allowed on this machine "${self.name}" (policy version ${current.version}, ${managed}):\n`);
    // The counters live here: a limited entry shows the calls left. A counter file that cannot be read is said, never skipped.
    let counters: FileUsageStore | undefined;
    try {
      counters = new FileUsageStore(join(configDir, 'usage.json'));
    } catch (e) {
      o.warn(`[warn] ${(e as Error).message}; the calls left are not shown\n`);
    }
    const numbered = (entries: PolicyEntry[], scope: string, indent: string): string =>
      entries.map((e, i) => `${indent}#${i + 1} ${entryLine(e, o.now(), e.limits?.maxCalls === undefined || counters === undefined ? undefined : counters.count(entryKey(scope, e)))}`).join('\n');
    o.say(current.defaults.length === 0 ? '  (nothing by default)\n' : `${numbered(current.defaults, 'default', '  ')}\n`);
    for (const [peer, entries] of Object.entries(current.peers)) o.say(`  only for ${nameOf(peer)} (own list, it replaces the default):\n${numbered(entries, peer, '    ')}\n`);
    return { kind: 'listed', version: current.version, policyMode: mode.mode };
  }

  if (mode.mode !== 'local') {
    throw new Error(
      `the allow list of this machine is managed by the admin: change it on the admin machine with \`machine admin allow ${self.name} -- <command>\`, or take it over with \`machine policy local enable\` (this machine then manages its own list and ignores admin-signed policies). Nothing was signed`,
    );
  }

  let peerUuid: string | undefined;
  if (o.peer !== undefined) {
    const peers = network.directory.machines();
    const resolved = resolveMachineRef(o.peer, peers, readAliases(configDir), networkAliasMap(configDir));
    if (!resolved.ok) throw new UnresolvedReferenceError(`${resolved.message} (only a registered peer of this machine can have its own list: \`machine list\`)`);
    peerUuid = resolved.uuid;
  }

  const state = activePolicyState(configDir);
  // The base of the edit: the installed local policy; when none is readable the counters still give the base (a delegate and a new enable keep going from them).
  const current: PolicyBody | undefined =
    network.policy ?? (state.version > 0 ? { v: 1, target: self.uuid, version: state.version, baseVersion: state.version - 1, adminKeyId: mode.localKeyId, issuedAt: 0, notBefore: 0, notAfter: 0, defaults: [], peers: {} } : undefined);

  const command = o.command as string;
  const shell = o.shell ?? o.defaultShell;
  if (o.mode === 'allow' && o.shell === undefined) {
    o.say(`[info] shell "${shell}" chosen from this machine's platform (the commands run here): pass --shell cmd|ps|bash|sh to allow another\n`);
  }
  // The entry is built (and every refusal of its text or lifetime said) before anything else happens.
  const entry = o.mode === 'allow' ? buildAllowEntry(command, shell, o.lifetime ?? {}, o.now(), o.input) : undefined;
  const edit = nextPolicyBody(
    current,
    { target: self.uuid, adminKeyId: mode.localKeyId, now: o.now(), windowSeconds: DEFAULT_APPLY_WINDOW_SECONDS },
    entry !== undefined
      ? { kind: 'allow', entry, ...(peerUuid !== undefined ? { peer: peerUuid } : {}), ...(o.renew === true ? { renew: true } : {}) }
      : { kind: 'remove', ...(o.index !== undefined ? { index: o.index } : { command }), ...(o.shell !== undefined ? { shell: o.shell } : {}), ...(peerUuid !== undefined ? { peer: peerUuid } : {}) },
  );
  const scope = peerUuid === undefined ? 'every trusted peer' : `"${nameOf(peerUuid)}" only`;
  if (!edit.changed) {
    o.say(unchangedMessage(edit, `this machine for ${scope}`, o.index !== undefined ? undefined : command, o.index, o.now(), `machine policy allow${peerUuid === undefined ? '' : ` --peer ${nameOf(peerUuid)}`} --remove`));
    return { kind: 'unchanged', reason: edit.reason };
  }

  const { body } = edit;
  o.say(
    [
      `Policy for this machine "${self.name}" (${self.uuid}): version ${body.baseVersion} -> ${body.version}`,
      ...edit.added.map((e) => `  + ${entryLine(e, o.now())}  (for ${scope})`),
      ...edit.removed.map((e) => `  - ${entryLine(e, o.now())}  (for ${scope})`),
      ...renewalLines(edit.renewed, o.now()),
      `  ${body.defaults.length} entr${body.defaults.length === 1 ? 'y' : 'ies'} allowed to every trusted peer after this change; may be applied until ${clockText(body.notAfter, o.now())} (${relativeText(body.notAfter, o.now())})`,
      '',
    ].join('\n'),
  );
  // The summary of a typed entry and the cases a type cannot make safe come BEFORE the question and the passphrase.
  if (entry !== undefined) {
    const summary = typedSummary(entry, o.now());
    if (summary.length > 0) {
      o.say(`${summary.join('\n')}\n\n`);
    }
    for (const warning of unsafeTypedWarnings(entry)) o.say(warning);
    if (entry.input !== undefined) {
      o.say(`${inputSummary(entry.input, o.inputAdded ?? []).join('\n')}\n\n`);
    }
  }
  if (edit.seededPeerList && peerUuid !== undefined) {
    const kept = (body.peers[peerUuid] as PolicyEntry[]).length - 1;
    o.say(`[warn] "${nameOf(peerUuid)}" had no list of its own: it now has one, starting with the ${kept} permanent default entr${kept === 1 ? 'y' : 'ies'} plus this one, and later changes of the default list no longer reach it\n`);
    for (const text of leftOutLines(edit.leftOut, nameOf(peerUuid), o.now())) o.say(`${text}\n`);
  } else if (edit.peersWithOwnList.length > 0 && peerUuid === undefined) {
    o.say(`[warn] these peers have their own list and are NOT affected by this change: ${edit.peersWithOwnList.map(nameOf).join(', ')}\n`);
  }

  await confirm(
    o,
    `${o.mode === 'allow' ? 'Allow' : 'Remove'} this on this machine: sign policy version ${body.version} with the local policy key and install it? [y/N] `,
    'Nothing was signed or installed',
    `machine policy allow ${o.mode === 'remove' ? '--remove ' : ''}...`,
  );
  o.say('Enter the local policy passphrase to sign this policy, Ctrl-C to cancel.\n');
  const pair = await unlockLocalKey(configDir, mode.localPublicKey, o.prompt);
  const signed = signPolicy(body, pair.privateKeyPkcs8, 'local');
  installPolicy(configDir, signed, { now: o.now() });
  o.say(`[ok] policy version ${body.version} signed with the local policy key and installed on this machine: \`machine policy allow --list\` shows it, the daemon applies it within seconds\n`);
  // The shell is part of the exact entry and the caller may run another platform: the peer types it (decision 71).
  if (o.mode === 'allow') {
    // For a typed entry the hint shows a command the validator accepts.
    const hintCommand = entry !== undefined && isTyped(entry) ? (templateExamples(parseTemplate(entry.template, shell), platformOfShell(shell)).accepted[0] ?? command) : command;
    o.say(`Then, from another machine: machine run ${self.name} --shell ${shell} -- ${commandForHint(hintCommand)} (or make ${shell} its default there: machine peer connect ${self.name} --shell ${shell})\n`);
  }
  return { kind: 'signed', version: body.version, keyId: mode.localKeyId };
}
