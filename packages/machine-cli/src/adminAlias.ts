import { aliasConflicts, planAliasChange, resolveMachineRef, type AliasEntry, type SignedAliases } from '@wadeck-app/machine-core';
import { readAdminPin, unlockAdminKey, type Prompt } from './admin.js';
import { UnresolvedReferenceError } from './adminRevoke.js';
import { aliasesFile, readAliasesList, signAliasesFor } from './aliasesStore.js';
import { conflictWarning } from './aliasView.js';
import {
  RETRY_ALIASES,
  adminMachineIdentity,
  adminMachineUuid,
  adminRelayAccess,
  distributeAliases,
  formatDistribution,
  requireAdminKeyFile,
  type DistributionReport,
  type FormattedDistribution,
} from './distribute.js';
import { directDeliveryFor } from './directDelivery.js';
import { loadNetwork, resolveRevokedMachine } from './network.js';
import { PromptTimeoutError } from './prompt.js';
import type { RelayClient } from './relayClient.js';
import { readAliases } from './state.js';

// `machine admin alias set <alias> <machine>`, `rm <alias>`, `list`, `send` (decision 116): the admin signs the network aliases (a list of alias -> machine uuid),
// keeps it, and sends it to every trusted machine as a sealed `aliases` document. An alias is a label for a human, never a right. A failure of the sending never
// undoes the signature: it is reported with the exact retry (`machine admin alias send`, which sends the stored list again and signs nothing).

export type AliasAdminOptions = (
  | { action: 'set'; alias: string; reference: string }
  | { action: 'rm'; alias: string }
  | { action: 'list' }
  | { action: 'send' }
) & {
  prompt: Prompt;
  /** Visible question; rejects without a terminal. */
  ask: (label: string) => Promise<string>;
  say: (text: string) => void;
  /** Epoch seconds. */
  now: () => number;
  /** Tests inject a client; the default uses the admin token of this machine. */
  client?: RelayClient;
};

export interface AliasAdminOutcome {
  /** What the command prints on the normal output (only `list` has anything beyond what `say` already printed). */
  out: string;
  entries: Array<{ alias: string; uuid: string; name?: string }>;
  serial?: number;
  /** A new list was signed. */
  signed: boolean;
  /** Absent when nothing was sent (a list, a no-op, or no admin relay token). */
  distribution: { report: DistributionReport; formatted: FormattedDistribution } | undefined;
  /** The list stands but nobody was told: this machine has no admin relay token. */
  notDistributed?: boolean;
}

const printable = (text: string): string => text.replace(/[^\x20-\x7e]/g, '?');

function machinesOf(configDir: string, now: number): Array<{ uuid: string; name: string }> {
  const self = adminMachineIdentity(configDir);
  return [...loadNetwork(configDir, now).directory.machines(), ...(self !== null ? [{ uuid: self.uuid, name: self.name }] : [])];
}

function view(entries: readonly AliasEntry[], machines: ReadonlyArray<{ uuid: string; name: string }>): AliasAdminOutcome['entries'] {
  return entries.map((e) => {
    const name = machines.find((m) => m.uuid === e.uuid)?.name;
    return { alias: e.alias, uuid: e.uuid, ...(name === undefined ? {} : { name }) };
  });
}

export async function runAliasAdmin(configDir: string, o: AliasAdminOptions): Promise<AliasAdminOutcome> {
  requireAdminKeyFile(configDir);
  const adminPublicKey = readAdminPin(configDir).adminPublicKey;
  const stored = readAliasesList(configDir, adminPublicKey);
  const machines = machinesOf(configDir, o.now());
  const nameOf = (uuid: string): string => machines.find((m) => m.uuid === uuid)?.name ?? uuid;

  if (o.action === 'list') {
    const entries = view(stored?.body.entries ?? [], machines);
    if (stored === undefined) {
      return { out: `no network alias is signed on this machine (${aliasesFile(configDir)} does not exist): set one with \`machine admin alias set <alias> <machine>\`\n`, entries, signed: false, distribution: undefined };
    }
    const lines = entries.length === 0 ? ['  (none: the list is empty)'] : entries.map((e) => `  ${e.alias} -> ${e.name ?? e.uuid} (${e.uuid})`);
    const head = `Network aliases (list serial ${stored.body.serial}, signed ${new Date(stored.body.issuedAt * 1000).toISOString()}):\n`;
    return { out: `${head}${lines.join('\n')}\n`, entries, serial: stored.body.serial, signed: false, distribution: undefined };
  }

  let signed: SignedAliases;
  let key: Awaited<ReturnType<typeof unlockAdminKey>>;
  let newlySigned = false;

  if (o.action === 'send') {
    if (stored === undefined) {
      throw new Error(`no network alias to send: ${aliasesFile(configDir)} does not exist. Set one with \`machine admin alias set <alias> <machine>\`. Nothing was signed`);
    }
    signed = stored;
    o.say(`Sending the network aliases again (list serial ${stored.body.serial}; nothing is signed again, safe to repeat).\n`);
    o.say('Enter the admin passphrase to sign the documents, Ctrl-C to cancel.\n');
    key = await unlockAdminKey(configDir, o.prompt);
  } else {
    const current = stored?.body.entries ?? [];
    let change: Parameters<typeof planAliasChange>[0]['change'];
    if (o.action === 'set') {
      // The target is resolved WITHOUT aliases: an alias always points to a machine, never to another alias.
      const resolved = resolveMachineRef(o.reference, machines, {}, {});
      if (!resolved.ok) {
        const gone = resolveRevokedMachine(configDir, o.reference, {});
        if (gone.ok) {
          throw new UnresolvedReferenceError(`"${printable(gone.machine.name ?? gone.machine.uuid)}" (${gone.machine.uuid}) is revoked here: an alias never points to a revoked machine. Nothing was signed`);
        }
        throw new UnresolvedReferenceError(`${resolved.message} (an alias points to a machine this one trusts, or to this machine; \`machine list\` shows them)`);
      }
      change = { action: 'set', alias: o.alias, uuid: resolved.uuid };
    } else {
      change = { action: 'rm', alias: o.alias };
    }
    const plan = planAliasChange({ change, current, machines, revoked: [] });
    if (!plan.ok) {
      throw new Error(`${plan.message}. Nothing was signed`);
    }
    if (plan.normalized) {
      o.say(`[info] using the alias "${plan.alias}" (typed: "${printable(o.alias)}"; an alias is lowercase letters, digits and hyphens, and references are case-insensitive)\n`);
    }
    if (!plan.changed) {
      const uuid = (change as { uuid: string }).uuid;
      o.say(`[info] the network alias "${plan.alias}" already points to "${printable(nameOf(uuid))}": nothing to sign. \`${RETRY_ALIASES}\` sends the stored list again\n`);
      return { out: '', entries: view(plan.entries, machines), ...(stored === undefined ? {} : { serial: stored.body.serial }), signed: false, distribution: undefined };
    }
    const target = o.action === 'set' ? (change as { uuid: string }).uuid : (current.find((e) => e.alias === plan.alias) as AliasEntry).uuid;
    o.say(
      [
        o.action === 'set' ? 'Network alias' : 'Removing the network alias',
        `  ${plan.alias} -> ${printable(nameOf(target))}`,
        `  uuid   ${target}`,
        `  after  ${plan.entries.length} network alias(es), sent to every trusted machine as a sealed document`,
        '',
        '',
      ].join('\n'),
    );
    const question = o.action === 'set' ? `Set the network alias "${plan.alias}" -> "${printable(nameOf(target))}"? [y/N] ` : `Remove the network alias "${plan.alias}"? [y/N] `;
    let answer: string;
    try {
      answer = await o.ask(question);
    } catch (e) {
      if (e instanceof PromptTimeoutError) throw e;
      throw new Error(`no terminal to confirm the change: run \`machine admin alias ${o.action} ${o.alias}${o.action === 'set' ? ` ${o.reference}` : ''}\` in a terminal window. Nothing was signed`);
    }
    if (!/^\s*(y|yes)\s*$/i.test(answer)) {
      throw new Error('not changed: the change was not confirmed. Nothing was signed');
    }
    o.say('Enter the admin passphrase to sign the network aliases, Ctrl-C to cancel.\n');
    key = await unlockAdminKey(configDir, o.prompt);
    // Dated AFTER the passphrase was typed: a slow prompt must not backdate the list.
    signed = signAliasesFor(configDir, { adminPrivateKeyPkcs8: key.privateKeyPkcs8, adminPublicKey, now: o.now(), entries: plan.entries });
    newlySigned = true;
    o.say(`[ok] network aliases signed (list serial ${signed.body.serial}, ${plan.entries.length} alias(es)).\n`);
    // A local alias of this machine with the same label points elsewhere: it wins HERE, and the person must know.
    const conflicts = aliasConflicts(readAliases(configDir), Object.fromEntries(plan.entries.map((e) => [e.alias, e.uuid])));
    for (const conflict of conflicts) o.say(`${conflictWarning(conflict, nameOf)}\n`);
  }

  const entries = view(signed.body.entries, machines);
  const outcome = { out: '', entries, serial: signed.body.serial, signed: newlySigned };
  const access = adminRelayAccess(configDir, o.client);
  if (access === undefined) {
    o.say(
      `[warn] the network aliases were NOT distributed: this machine has no admin relay token, so the other machines do not know them yet. ` +
        `Run \`machine admin login\` (confirm the request in the relay console), then \`${RETRY_ALIASES}\`\n`,
    );
    return { ...outcome, distribution: undefined, notDistributed: true };
  }
  let report: DistributionReport;
  try {
    report = await distributeAliases(configDir, signed, { client: access.client, adminPrivateKeyPkcs8: key.privateKeyPkcs8, adminUuid: adminMachineUuid(configDir), now: o.now, configDir, direct: directDeliveryFor(configDir, { now: o.now }) });
  } catch (e) {
    report = { delivered: 0, alreadyThere: 0, failures: [{ toUuid: adminMachineUuid(configDir) ?? '-', toName: 'the network aliases', kind: 'machine', id: undefined, message: (e as Error).message }], aborted: false, machines: 0 };
  }
  const formatted = formatDistribution(report, 'the network aliases', RETRY_ALIASES);
  if (formatted.out) o.say(formatted.out);
  return { ...outcome, distribution: { report, formatted } };
}
