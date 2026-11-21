import { resolveMachineRef } from '@wadeck-app/machine-core';
import { readAdminPin, unlockAdminKey, type Prompt } from './admin.js';
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
  return { out: `Request notices go to (list serial ${signed.body.serial}, signed ${new Date(signed.body.issuedAt * 1000).toISOString()}):\n${lines.join('\n')}\n`, recipients };
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
