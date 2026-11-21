import { existsSync } from 'node:fs';
import { resolveMachineRef } from '@wadeck-app/machine-core';
import { adminKeyFile, readAdminPin, unlockAdminKey, type Prompt } from './admin.js';
import { UnresolvedReferenceError } from './adminRevoke.js';
import {
  adminMachineIdentity,
  adminRelayAccess,
  formatDistribution,
  noAdminRelayTokenMessage,
  putNoticeRecipients,
  requireAdminKeyFile,
  type DistributionReport,
  type FormattedDistribution,
  type Sender,
} from './distribute.js';
import { loadNetwork, trustedRegistrations } from './network.js';
import { holdingOf, readNoticeSent, type Holding, type NoticeSentRecord } from './noticeRecipientsSent.js';
import { noticeRecipientsFile, readNoticeRecipients, signNoticeRecipientsFor } from './noticeRecipientsStore.js';
import type { RelayClient } from './relayClient.js';
import { readAliases } from './state.js';

// `machine admin notify-to <machine>...` and `--list` (request-notices.md, decision 84). The list only decides who receives information about the
// requests other peers made on a machine; it is not a right (hard rule 4).

export interface NotifyToOptions {
  /** Machines (name, alias, uuid or prefix; this machine by its name) that receive request notices. Absent: read, do not sign. */
  references?: string[];
  prompt: Prompt;
  say: (text: string) => void;
  /** Epoch seconds. */
  now: () => number;
  client?: RelayClient;
}

export interface NotifyToResult {
  out: string;
  report?: DistributionReport;
  formatted?: FormattedDistribution;
  recipients: Array<{ uuid: string; name: string }>;
  /** `--list` on the admin machine: what each trusted machine holds (from the local record). */
  holders?: HolderView[];
}

/** The name this machine knows a uuid by: a trusted peer, this machine itself, or the bare uuid. */
function nameOf(configDir: string, uuid: string, now: number): string {
  const self = adminMachineIdentity(configDir);
  if (self !== null && self.uuid === uuid) {
    return `${self.name} (this machine)`;
  }
  return loadNetwork(configDir, now).directory.find(uuid)?.name ?? `${uuid} (not a trusted peer of this machine)`;
}

/** `--list`: what this machine holds, from its own file. No passphrase, no relay. */
export function listNoticeRecipients(configDir: string, now: number): NotifyToResult {
  const signed = readNoticeRecipients(configDir, readAdminPin(configDir).adminPublicKey);
  if (signed === undefined) {
    return {
      out: `no notice recipients are known on this machine (${noticeRecipientsFile(configDir)} does not exist): peers that hold a request do not notify anybody. Run \`machine admin distribute <machine>\` on the admin machine, or \`machine admin notify-to <machine>...\`\n`,
      recipients: [],
    };
  }
  const recipients = signed.body.recipients.map((uuid) => ({ uuid, name: nameOf(configDir, uuid, now) }));
  const lines = recipients.length === 0 ? ['  (nobody: the list is empty)'] : recipients.map((r) => `  ${r.name}  ${r.uuid}`);
  const head = `Request notices go to (list serial ${signed.body.serial}, signed ${new Date(signed.body.issuedAt * 1000).toISOString()}):\n${lines.join('\n')}\n`;
  // Only the admin machine signs and sends the list: it alone has a record of who holds it.
  if (!existsSync(adminKeyFile(configDir))) {
    return { out: head, recipients };
  }
  const holders = holdersOf(configDir, signed.body.serial, recipients.map((r) => r.name), now);
  return { out: `${head}${holders.text}`, recipients, holders: holders.machines };
}

export interface HolderView {
  uuid: string;
  name: string;
  holding: Holding;
}

const dateText = (at: number): string => new Date(at * 1000).toISOString();

/** What each Holding says in the terminal. */
export function holdingText(h: Holding): string {
  switch (h.state) {
    case 'current':
      return `has the current list (serial ${h.serial}, confirmed ${dateText(h.at)})`;
    case 'newer':
      return `has a newer list (serial ${h.serial}, confirmed ${dateText(h.at)}): another admin machine signed it`;
    case 'sent':
      return `sent ${dateText(h.at)}, not confirmed`;
    case 'send-failed':
      return `the last send FAILED (${dateText(h.at)}): nothing reached its inbox`;
    case 'older':
      return `has an older list (serial ${h.serial}, confirmed ${dateText(h.at)})`;
    case 'none':
      return `has no list (confirmed ${dateText(h.at)})`;
    case 'unknown':
      return 'unknown (older build or never asked)';
  }
}

/** One line per trusted machine, from the record of this admin machine (no network, no passphrase), and the command that fixes what is missing. */
function holdersOf(configDir: string, currentSerial: number, recipientNames: string[], now: number): { text: string; machines: HolderView[] } {
  let record: NoticeSentRecord;
  try {
    record = readNoticeSent(configDir);
  } catch (e) {
    return { text: `[warn] ${(e as Error).message}\n`, machines: [] };
  }
  const machines = trustedRegistrations(configDir, now).map((r) => ({ uuid: r.body.uuid, name: r.body.name, holding: holdingOf(currentSerial, record[r.body.uuid]) }));
  if (machines.length === 0) {
    return { text: '', machines };
  }
  const width = Math.max(...machines.map((m) => m.name.length));
  const lines = machines.map((m) => `  ${m.name.padEnd(width)}  ${holdingText(m.holding)}`);
  const missing = machines.filter((m) => m.holding.state !== 'current' && m.holding.state !== 'newer');
  const fix =
    missing.length === 0
      ? 'every trusted machine holds the current list\n'
      : `To send the list to the machines that do not hold it: machine admin notify-to ${recipientNames.length > 0 ? recipientNames.join(' ') : '<machine>...'} (signs a new list with the same recipients and sends it to every trusted machine; any \`machine admin allow\` also carries the current one). To confirm what a machine holds: machine requests <machine>. \`machine admin distribute <machine>\` tells the OTHER machines about it, it is not the way to send the list to that machine alone\n`;
  return { text: `\nWho holds the list (recorded on this machine; a machine is confirmed only when it answered \`machine requests\` or the Requests page):\n${lines.join('\n')}\n${fix}`, machines };
}

export async function runNotifyTo(configDir: string, o: NotifyToOptions): Promise<NotifyToResult> {
  if (o.references === undefined) {
    return listNoticeRecipients(configDir, o.now());
  }
  requireAdminKeyFile(configDir);
  const self = adminMachineIdentity(configDir);
  if (self === null) {
    throw new Error('this machine has no identity (run `machine init`): it cannot be a notice recipient or send the list');
  }
  const access = adminRelayAccess(configDir, o.client);
  if (access === undefined) {
    throw new Error(noAdminRelayTokenMessage(configDir));
  }
  const network = loadNetwork(configDir, o.now());
  const aliases = readAliases(configDir);
  const chosen = new Map<string, string>();
  for (const reference of o.references) {
    const wanted = reference.toLowerCase();
    if (wanted === self.uuid || wanted === self.name.toLowerCase()) {
      chosen.set(self.uuid, self.name);
      continue;
    }
    const resolved = resolveMachineRef(reference, network.directory.machines(), aliases);
    if (!resolved.ok) {
      throw new UnresolvedReferenceError(`${resolved.message} (notify-to takes machines this one trusts, or this machine; \`machine status\` lists them)`);
    }
    chosen.set(resolved.uuid, nameOf(configDir, resolved.uuid, o.now()));
  }
  o.say('Enter the admin passphrase to sign the list of notice recipients, Ctrl-C to cancel.\n');
  const key = await unlockAdminKey(configDir, o.prompt);
  const signed = signNoticeRecipientsFor(configDir, {
    adminPrivateKeyPkcs8: key.privateKeyPkcs8,
    adminPublicKey: readAdminPin(configDir).adminPublicKey,
    selfUuid: self.uuid,
    now: o.now(),
    recipients: [...chosen.keys()],
  });
  const sender: Sender = { client: access.client, adminPrivateKeyPkcs8: key.privateKeyPkcs8, adminUuid: self.uuid, now: o.now, configDir };
  const targets = trustedRegistrations(configDir, o.now()).map((r) => ({ uuid: r.body.uuid, name: r.body.name }));
  const report: DistributionReport = { delivered: 0, alreadyThere: 0, failures: [], aborted: false, machines: targets.length };
  await putNoticeRecipients(sender, report, signed, targets);
  const formatted = formatDistribution(report, 'the list of notice recipients', `machine admin notify-to ${o.references.join(' ')}`);
  const names = [...chosen.values()].map((n) => `"${n}"`).join(', ');
  return { out: `${formatted.out}[ok] request notices now go to ${names || 'nobody'} (list serial ${signed.body.serial}); the other machines learn it when they read their inbox\n`, report, formatted, recipients: [...chosen.entries()].map(([uuid, name]) => ({ uuid, name })) };
}
