import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { assertPolicyBody, commandForHint, type InputDeclaration, isTyped, nextPolicyBody, parseTemplate, POLICY_DOMAIN, resolveMachineRef, resolveRunShell, signPolicy, templateExamples, verifyDocument, type LifetimeInput, type PolicyBody, type PolicyEdit, type PolicyEntry, type Shell, type SignedPolicy } from '@wadeck-app/machine-core';
import type { Json } from '@wadeck-app/machine-core';
import { adminKeyFile, readAdminPin, unlockAdminKey, type Prompt } from './admin.js';
import { buildAllowEntry, entryLine, inputSummary, platformOfShell, renewalLines, typedSummary } from './allowText.js';
import { unsafeTypedWarnings } from './allowSafety.js';
import { missingAdminTokenMessage } from './adminApprove.js';
import { adminMachineUuid, adminRelayAccess, distributePolicy, formatDistribution } from './distribute.js';
import { directDeliveryFor } from './directDelivery.js';
import { ConnectionsError, readConnections } from './connectionsStore.js';
import { writeFileAtomic } from './fsutil.js';
import { exportMachineInfo, installPolicy, loadNetwork } from './network.js';
import { clockText, relativeText } from './humanTime.js';
import { PromptTimeoutError } from './prompt.js';
import type { RelayClient } from './relayClient.js';
import { UnresolvedReferenceError } from './adminRevoke.js';
import { readRelayConfig } from './relayStore.js';
import { networkAliasMap } from './aliasesStore.js';
import { readAliases } from './state.js';

// `machine admin allow` (decision 54): the next policy of ONE machine, built from the current one, shown as a difference, confirmed,
// signed with the admin passphrase and sent like `admin sign-policy` does. The admin signature, the human y/N and the
// compare-and-set of the target are untouched: nothing widens without them.

export const policiesDir = (configDir: string): string => join(configDir, 'policies');
/** The last policy signed here for a machine (a signed document, not a secret): the base of the next edit. */
export const policyRecordFile = (configDir: string, uuid: string): string => join(policiesDir(configDir), `${uuid}.json`);

export function recordSignedPolicy(configDir: string, signed: SignedPolicy): void {
  mkdirSync(policiesDir(configDir), { recursive: true });
  writeFileAtomic(policyRecordFile(configDir, signed.body.target), `${JSON.stringify(signed, null, 2)}\n`, 0o644);
}

/** The recorded policy of a machine, verified against the pinned admin key (a file edited by hand is not a base). */
export function readPolicyRecord(configDir: string, uuid: string, adminPublicKey: string): SignedPolicy | undefined {
  const file = policyRecordFile(configDir, uuid);
  if (!existsSync(file)) return undefined;
  let signed: SignedPolicy;
  try {
    signed = JSON.parse(readFileSync(file, 'utf8')) as SignedPolicy;
    assertPolicyBody(signed.body);
  } catch (e) {
    throw new Error(`${file} is not a valid policy record (${(e as Error).message}): delete it, the next policy is then built from nothing`);
  }
  if (!verifyDocument(POLICY_DOMAIN, signed.body as unknown as Json, adminPublicKey, signed.signature) || signed.body.target !== uuid) {
    throw new Error(`${file} does not match the admin key of this machine or its machine: delete it, the next policy is then built from nothing`);
  }
  return signed;
}

export interface AllowOptions {
  reference: string;
  mode: 'allow' | 'remove' | 'list';
  /** The command line (or the template), for `allow` and `remove`. */
  command?: string;
  /** `allow`: --times, --for or --until (permanent when none). */
  lifetime?: LifetimeInput;
  /** `allow --renew`: replace the entry even with the same limits; its counter starts again (hold-for-approval.md, "Renewal"). */
  renew?: boolean;
  /** `allow --stdin text|json --stdin-chars ...`: the input the entry accepts (decision 114), and the families the format added to what was typed. */
  input?: InputDeclaration;
  inputAdded?: readonly string[];
  /** `remove`: the 1-based place in the list shown by `machine allowed`, instead of the command. */
  index?: number;
  /** Absent: the platform of this machine (said), for `allow`; every shell, for `remove`. */
  shell?: Shell;
  /** Also write the signed policy to this file (the only delivery without an admin relay token). */
  out?: string;
  prompt: Prompt;
  /** Visible question; rejects without a terminal. */
  ask: (label: string) => Promise<string>;
  say: (text: string) => void;
  /** Epoch seconds. */
  now: () => number;
  client?: RelayClient;
}

export type AllowResult =
  | { kind: 'listed'; uuid: string; version: number }
  | { kind: 'unchanged'; reason: 'already-allowed' | 'not-allowed' | 'bad-index' | 'ambiguous' }
  | { kind: 'signed'; uuid: string; name: string; version: number; delivery: 'inbox' | 'direct' | 'installed' | 'file'; failed: boolean; out: string };

/**
 * The `machine run` that matches the entry just allowed (the shell is part of the exact entry, decision 71). `--shell` is left out only when it equals
 * the shell `run` picks on THIS machine: the default of that peer in connections.json, else the platform. A damaged connections.json is said (a
 * `[warn]`) and the hint keeps `--shell`, which is right whatever the file says.
 */
export function runHint(configDir: string, name: string, uuid: string, shell: Shell, command: string, say: (text: string) => void): string {
  let picked: Shell | undefined;
  try {
    picked = resolveRunShell({ peerDefault: readConnections(configDir).peers[uuid]?.shell, platform: process.platform }).shell;
  } catch (e) {
    if (!(e instanceof ConnectionsError)) throw e;
    say(`[warn] ${e.message}: the command below names the shell explicitly\n`);
  }
  const quoted = commandForHint(command);
  if (picked === shell) return `machine run ${name} -- ${quoted}`;
  return `machine run ${name} --shell ${shell} -- ${quoted} (or make ${shell} the default for that machine: machine peer connect ${name} --shell ${shell})`;
}

/**
 * What `--remove` says when it did not change anything: the cause and the fix, with the matching entries and their number when several
 * share the text (`--index` takes it).
 */
export function unchangedMessage(edit: Extract<PolicyEdit, { changed: false }>, what: string, command: string | undefined, index: number | undefined, now: number, removeCommand: string): string {
  switch (edit.reason) {
    case 'already-allowed':
      return `already allowed on ${what}: ${command === undefined ? '' : JSON.stringify(command)}, with these limits. Nothing was signed. An entry that is used up or expired is renewed with --renew (the counter starts again), or with other limits\n`;
    case 'not-allowed':
      return `${command === undefined ? 'this entry' : JSON.stringify(command)} is not allowed on ${what}: nothing to remove, nothing was signed. \`machine allowed\` lists the entries with their number\n`;
    case 'bad-index':
      return `there is no entry number ${String(index)} in the list of ${what}: nothing to remove, nothing was signed. \`machine allowed\` lists the entries with their number\n`;
    case 'ambiguous':
      return `${JSON.stringify(command)} matches several entries of ${what}: nothing was signed. Say which one: add --shell <shell>, or ${removeCommand} --index <number> with one of:\n${edit.candidates.map((c) => `  #${c.index} ${entryLine(c.entry, now)}`).join('\n')}\n`;
  }
}

export async function runAllow(configDir: string, o: AllowOptions): Promise<AllowResult> {
  if (!existsSync(adminKeyFile(configDir))) {
    throw new Error(`this machine has no admin key (${adminKeyFile(configDir)} does not exist): run this command on the machine that holds the admin key (\`machine setup <relay>\` creates it)`);
  }
  const pin = readAdminPin(configDir);
  const self = exportMachineInfo(configDir);
  const network = loadNetwork(configDir, o.now());
  const everyone = [{ uuid: self.uuid, name: self.name }, ...network.directory.machines()];
  const resolved = resolveMachineRef(o.reference, everyone, readAliases(configDir), networkAliasMap(configDir));
  if (!resolved.ok) throw new UnresolvedReferenceError(resolved.message);
  const target = everyone.find((m) => m.uuid === resolved.uuid) as { uuid: string; name: string };
  const toSelf = target.uuid === self.uuid;
  const nameOf = (uuid: string): string => everyone.find((m) => m.uuid === uuid)?.name ?? uuid;

  // The base of the edit: this machine's own policy when it is the target (authoritative), else the last one signed here.
  let current: PolicyBody | undefined;
  let source: string;
  if (toSelf) {
    current = network.policy;
    source = 'installed on this machine';
  } else {
    current = readPolicyRecord(configDir, target.uuid, pin.adminPublicKey)?.body;
    source = 'the last one signed here';
  }

  if (o.mode === 'list') {
    if (current === undefined) {
      o.say(`Nothing is allowed on "${target.name}" yet: no policy is on record, so every command is refused${toSelf ? '' : ` (only policies signed on this machine are on record)`}.\n`);
      return { kind: 'listed', uuid: target.uuid, version: 0 };
    }
    o.say(`Allowed on "${target.name}" (policy version ${current.version}, ${source}):\n`);
    // The number is the place in the list: what `--remove --index <n>` takes.
    const numbered = (entries: PolicyEntry[], indent: string): string => entries.map((e, i) => `${indent}#${i + 1} ${entryLine(e, o.now())}`).join('\n');
    o.say(current.defaults.length === 0 ? '  (nothing by default)\n' : `${numbered(current.defaults, '  ')}\n`);
    for (const [peer, entries] of Object.entries(current.peers)) o.say(`  only for ${nameOf(peer)} (own list, it replaces the default):\n${numbered(entries, '    ')}\n`);
    return { kind: 'listed', uuid: target.uuid, version: current.version };
  }

  if (toSelf && network.policyMode === 'local') {
    throw new Error(`this machine manages its own allow list (policy mode local): an admin signature would be refused here. Use \`machine policy allow -- <command>\` on this machine, or \`machine policy delegate\` to give the list back to the admin first. Nothing was signed`);
  }
  const command = o.command as string;
  const defaultShell: Shell = process.platform === 'win32' ? 'cmd' : 'sh';
  const shell = o.shell ?? defaultShell;
  if (o.mode === 'allow' && o.shell === undefined) {
    o.say(`[info] shell "${shell}" chosen from this machine's platform (the platform of "${target.name}" is not known here): pass --shell cmd|ps|bash|sh if it differs\n`);
  }
  // The entry is built (and every refusal of its text or lifetime said) before anything else happens.
  const entry = o.mode === 'allow' ? buildAllowEntry(command, shell, o.lifetime ?? {}, o.now(), o.input) : undefined;
  // For a typed entry the `machine run` hint shows a command the validator accepts.
  const hintCommand = entry !== undefined && isTyped(entry) ? (templateExamples(parseTemplate(entry.template, shell), platformOfShell(shell)).accepted[0] ?? command) : command;
  const edit = nextPolicyBody(
    current,
    { target: target.uuid, adminKeyId: pin.adminKeyId, now: o.now() },
    entry !== undefined ? { kind: 'allow', entry, ...(o.renew === true ? { renew: true } : {}) } : { kind: 'remove', ...(o.index !== undefined ? { index: o.index } : { command }), ...(o.shell !== undefined ? { shell: o.shell } : {}) },
  );
  if (!edit.changed) {
    o.say(unchangedMessage(edit, `"${target.name}"`, o.index !== undefined ? undefined : command, o.index, o.now(), `machine admin allow ${o.reference} --remove`));
    return { kind: 'unchanged', reason: edit.reason };
  }

  // Where it goes is known before anything is asked: a missing token is said first, with the exact command.
  const access = toSelf ? undefined : adminRelayAccess(configDir, o.client);
  if (!toSelf && access === undefined && o.out === undefined) {
    throw new Error(`${missingAdminTokenMessage(configDir, readRelayConfig(configDir)?.relayUrl)}; or pass --out <file> to write the signed policy and install it on "${target.name}" yourself with \`machine policy install <file>\`. Nothing was signed`);
  }

  const { body } = edit;
  o.say(
    [
      `Policy for "${target.name}" (${target.uuid}): version ${body.baseVersion} -> ${body.version}`,
      ...edit.added.map((e) => `  + ${entryLine(e, o.now())}`),
      ...edit.removed.map((e) => `  - ${entryLine(e, o.now())}`),
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
  if (body.v === 3) {
    o.say(`[info] this policy is version 3 (it holds an input declaration): "${target.name}" must run a build that knows it, otherwise it refuses it with "unsupported version 3": run \`machine cli update\` there first\n`);
  } else if (body.v === 2) {
    o.say(`[info] this policy is version 2 (it holds typed entries or a renewed entry): "${target.name}" must run a build that knows them, otherwise it refuses it with "unsupported version 2": run \`machine cli update\` there first\n`);
  }
  if (!toSelf && current === undefined) {
    o.say(`[info] no policy signed here for "${target.name}" on record: this assumes it has none (the new policy is version 1, edited from 0). If it already has a policy signed from another machine, it refuses this one with "policy changed, reload": see its version with \`machine status\` there\n`);
  }
  if (edit.peersWithOwnList.length > 0) {
    o.say(`[warn] these peers have their own list and are NOT affected by this change: ${edit.peersWithOwnList.map(nameOf).join(', ')}\n`);
  }

  let answer: string;
  try {
    answer = await o.ask(`${o.mode === 'allow' ? 'Allow' : 'Remove'} this on "${target.name}": sign policy version ${body.version} and ${toSelf ? 'install it on this machine' : 'send it'}? [y/N] `);
  } catch (e) {
    if (e instanceof PromptTimeoutError) throw e;
    throw new Error(`no terminal to confirm the policy: run \`machine admin allow ${o.reference} ...\` in a terminal window. Nothing was signed`);
  }
  if (!/^\s*(y|yes)\s*$/i.test(answer)) throw new Error('not confirmed: the policy was not confirmed. Nothing was signed or sent');

  o.say('Enter the admin passphrase to sign this policy, Ctrl-C to cancel.\n');
  const pair = await unlockAdminKey(configDir, o.prompt);
  const signed = signPolicy(body, pair.privateKeyPkcs8);
  recordSignedPolicy(configDir, signed);

  let delivery: 'inbox' | 'direct' | 'installed' | 'file' = 'file';
  let failed = false;
  let out = '';
  if (o.out !== undefined) {
    writeFileAtomic(o.out, `${JSON.stringify(signed, null, 2)}\n`, 0o644);
    out += `[ok] signed policy written to ${o.out}${access === undefined && !toSelf ? `: install it on "${target.name}" with \`machine policy install ${o.out}\`, or send it later with \`machine admin distribute --policy ${o.out}\`` : ''}\n`;
  }
  if (toSelf) {
    installPolicy(configDir, signed, { now: o.now() });
    delivery = 'installed';
    out += `[ok] policy version ${body.version} installed on this machine (it is the target): \`machine status\` shows it\n`;
  } else if (access !== undefined) {
    delivery = 'inbox';
    const report = await distributePolicy(signed, { client: access.client, adminPrivateKeyPkcs8: pair.privateKeyPkcs8, adminUuid: adminMachineUuid(configDir), now: o.now, configDir, direct: directDeliveryFor(configDir, { now: o.now }) });
    const retry = `machine admin distribute --policy ${o.out ?? policyRecordFile(configDir, target.uuid)}`;
    const formatted = formatDistribution(report, 'the signed policy', retry);
    failed = formatted.failed;
    out += formatted.out;
    // The path is said by formatDistribution above (directly, or the relay inbox with the cause); this line says what it means for the target.
    const direct = (report.direct ?? []).some((d) => d.kind === 'policy');
    if (direct) delivery = 'direct';
    const then = o.mode === 'allow' ? ` Then: ${runHint(configDir, target.name, target.uuid, shell, hintCommand, o.say)}` : '';
    if (formatted.failed) out += formatted.err;
    else if (direct) out += `[ok] policy version ${body.version} is in force on "${target.name}" now.${then}\n`;
    else out += `[ok] policy version ${body.version} is in the relay inbox of "${target.name}": its daemon installs it at its next inbox poll (within 60 s, or 5 s while it holds a request; the daemon must run there: \`machine startup enable\`).${then}\n`;
  }
  o.say(out);
  return { kind: 'signed', uuid: target.uuid, name: target.name, version: body.version, delivery, failed, out };
}
