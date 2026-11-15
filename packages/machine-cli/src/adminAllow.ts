import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { assertPolicyBody, nextPolicyBody, POLICY_DOMAIN, resolveMachineRef, signPolicy, verifyDocument, type PolicyBody, type PolicyEntry, type Shell, type SignedPolicy } from '@wadeck-app/machine-core';
import type { Json } from '@wadeck-app/machine-core';
import { adminKeyFile, readAdminPin, unlockAdminKey, type Prompt } from './admin.js';
import { missingAdminTokenMessage } from './adminApprove.js';
import { adminMachineUuid, adminRelayAccess, distributePolicy, formatDistribution } from './distribute.js';
import { writeFileAtomic } from './fsutil.js';
import { exportMachineInfo, installPolicy, loadNetwork } from './network.js';
import { PromptTimeoutError } from './prompt.js';
import type { RelayClient } from './relayClient.js';
import { UnresolvedReferenceError } from './adminRevoke.js';
import { readRelayConfig } from './relayStore.js';
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
  /** The command line, for `allow` and `remove`. */
  command?: string;
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
  | { kind: 'unchanged'; reason: 'already-allowed' | 'not-allowed' }
  | { kind: 'signed'; uuid: string; name: string; version: number; delivery: 'inbox' | 'installed' | 'file'; failed: boolean; out: string };

const line = (e: PolicyEntry): string => `${e.shell}  ${JSON.stringify(e.command)}${e.limits ? `  limits ${JSON.stringify(e.limits)}` : ''}`;

export async function runAllow(configDir: string, o: AllowOptions): Promise<AllowResult> {
  if (!existsSync(adminKeyFile(configDir))) {
    throw new Error(`this machine has no admin key (${adminKeyFile(configDir)} does not exist): run this command on the machine that holds the admin key (\`machine setup <relay>\` creates it)`);
  }
  const pin = readAdminPin(configDir);
  const self = exportMachineInfo(configDir);
  const network = loadNetwork(configDir, o.now());
  const everyone = [{ uuid: self.uuid, name: self.name }, ...network.directory.machines()];
  const resolved = resolveMachineRef(o.reference, everyone, readAliases(configDir));
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
    o.say(current.defaults.length === 0 ? '  (nothing by default)\n' : `${current.defaults.map((e) => `  ${line(e)}`).join('\n')}\n`);
    for (const [peer, entries] of Object.entries(current.peers)) o.say(`  only for ${nameOf(peer)} (own list, it replaces the default):\n${entries.map((e) => `    ${line(e)}`).join('\n')}\n`);
    return { kind: 'listed', uuid: target.uuid, version: current.version };
  }

  const command = o.command as string;
  const defaultShell: Shell = process.platform === 'win32' ? 'cmd' : 'sh';
  const shell = o.shell ?? defaultShell;
  if (o.mode === 'allow' && o.shell === undefined) {
    o.say(`[info] shell "${shell}" chosen from this machine's platform (the platform of "${target.name}" is not known here): pass --shell cmd|ps|bash|sh if it differs\n`);
  }
  const edit = nextPolicyBody(current, { target: target.uuid, adminKeyId: pin.adminKeyId, now: o.now() }, o.mode === 'allow' ? { kind: 'allow', entry: { shell, command } } : { kind: 'remove', command, ...(o.shell !== undefined ? { shell: o.shell } : {}) });
  if (!edit.changed) {
    o.say(edit.reason === 'already-allowed' ? `already allowed on "${target.name}": ${shell}  ${JSON.stringify(command)}. Nothing was signed\n` : `${JSON.stringify(command)} is not allowed on "${target.name}": nothing to remove, nothing was signed\n`);
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
      ...edit.added.map((e) => `  + ${line(e)}`),
      ...edit.removed.map((e) => `  - ${line(e)}`),
      `  ${body.defaults.length} entr${body.defaults.length === 1 ? 'y' : 'ies'} allowed to every trusted peer after this change; may be applied until ${new Date(body.notAfter * 1000).toISOString()}`,
      '',
    ].join('\n'),
  );
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

  let delivery: 'inbox' | 'installed' | 'file' = 'file';
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
    const report = await distributePolicy(signed, { client: access.client, adminPrivateKeyPkcs8: pair.privateKeyPkcs8, adminUuid: adminMachineUuid(configDir), now: o.now });
    const retry = `machine admin distribute --policy ${o.out ?? policyRecordFile(configDir, target.uuid)}`;
    const formatted = formatDistribution(report, 'the signed policy', retry);
    failed = formatted.failed;
    out += formatted.out;
    if (formatted.failed) out += formatted.err;
    else out += `[ok] policy version ${body.version} is in the relay inbox of "${target.name}": its daemon installs it within about a minute (the daemon must run there: \`machine startup enable\`). Then: machine run ${target.name} -- <command>\n`;
  }
  o.say(out);
  return { kind: 'signed', uuid: target.uuid, name: target.name, version: body.version, delivery, failed, out };
}
