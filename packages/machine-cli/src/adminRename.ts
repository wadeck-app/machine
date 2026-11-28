import { buildRenamedRegistration, normalizeMachineName, registrationReplaces, resolveMachineRef, signRegistration, type RegistrationBody } from '@wadeck-app/machine-core';
import { unlockAdminKey, type Prompt } from './admin.js';
import { UnresolvedReferenceError } from './adminRevoke.js';
import { adminMachineIdentity, adminMachineUuid, adminRelayAccess, distributeRename, formatDistribution, requireAdminKeyFile, type DistributionReport, type FormattedDistribution } from './distribute.js';
import { directDeliveryFor } from './directDelivery.js';
import { expiryText } from './humanTime.js';
import { importPeer, installedRevocations, loadNetwork, resolveRevokedMachine, trustedRegistrations } from './network.js';
import { PromptTimeoutError } from './prompt.js';
import type { RelayClient } from './relayClient.js';
import { readAliases } from './state.js';

// `machine admin rename <machine> <new-name>` (decision 114): the admin re-issues the registration of a machine with the SAME uuid and identity key, the new
// name, serial + 1 and the SAME expiry, signs it (passphrase asked here, never kept), trusts it on this machine, then sends it through the same distribution as an
// approval (peer documents to the others, the registration of the others to the machine) plus a `self-registration` document so the machine takes its new name.
// A failure of the sending never undoes the rename: it is reported with the exact retry, which is the same command with the new name twice.

export interface RenameOptions {
  reference: string;
  newName: string;
  prompt: Prompt;
  /** Visible question; rejects without a terminal. */
  ask: (label: string) => Promise<string>;
  say: (text: string) => void;
  /** Epoch seconds. */
  now: () => number;
  /** Tests inject a client; the default uses the admin token of this machine. */
  client?: RelayClient;
}

export interface RenameOutcome {
  uuid: string;
  oldName: string;
  newName: string;
  serial: number;
  /** The documents of an earlier rename were sent again: nothing was signed. */
  resent: boolean;
  /** Absent when this machine has no admin relay token (nobody was told). */
  distribution: { report: DistributionReport; formatted: FormattedDistribution } | undefined;
}

/** The command that sends the documents of a rename again (same name twice: nothing to change, only to send). */
export const retryRename = (name: string): string => `machine admin rename ${name} ${name}`;

const printable = (text: string): string => text.replace(/[^\x20-\x7e]/g, '?');

export async function runRename(configDir: string, o: RenameOptions): Promise<RenameOutcome> {
  requireAdminKeyFile(configDir);
  const network = loadNetwork(configDir, o.now());
  const aliases = readAliases(configDir);
  const self = adminMachineIdentity(configDir);
  const wanted = o.reference.toLowerCase();
  if (self !== null && (wanted === self.uuid || wanted === self.name.toLowerCase())) {
    throw new Error(
      `"${self.name}" is the admin machine itself: renaming it is not supported by this command yet (its peers would need a renewed registration of the admin machine, which \`machine admin rename\` does not issue). Rename the other machines, or enroll this one again under another name`,
    );
  }
  const resolved = resolveMachineRef(o.reference, network.directory.machines(), aliases);
  if (!resolved.ok) {
    const gone = resolveRevokedMachine(configDir, o.reference, aliases);
    if (gone.ok) {
      throw new Error(
        `"${printable(gone.machine.name ?? gone.machine.uuid)}" (${gone.machine.uuid}) is revoked here: a revoked machine cannot be renamed. Enroll it again (\`machine join\` there, then \`machine admin approve\` here) and it takes the name it joins with. Nothing was signed`,
      );
    }
    throw new UnresolvedReferenceError(`${resolved.message} (only machines this machine currently trusts can be renamed; \`machine list\` shows them)`);
  }
  const current = trustedRegistrations(configDir, o.now()).find((r) => r.body.uuid === resolved.uuid);
  const peer = network.directory.find(resolved.uuid);
  if (current === undefined || peer === undefined) {
    throw new Error(`cannot find the registration of ${resolved.uuid} in this machine's peer list: nothing was renamed`);
  }

  const normalized = normalizeMachineName(o.newName);
  if (!normalized.ok) {
    throw new Error(`invalid new name ${JSON.stringify(o.newName)}: it has no letter or digit to build a machine name from. Use letters, digits and hyphens, for example: machine admin rename ${o.reference} mac-m2. Nothing was signed`);
  }
  const newName = normalized.name;
  if (normalized.changed) {
    o.say(`[info] using the name "${newName}" (typed: "${printable(o.newName)}"; a name is lowercase letters, digits and hyphens, and references are case-insensitive)\n`);
  }

  const outcome = (serial: number, resent: boolean): Omit<RenameOutcome, 'distribution'> => ({ uuid: current.body.uuid, oldName: current.body.name, newName, serial, resent });
  const revokedUpTo = installedRevocations(configDir)
    .filter((entry) => entry.uuid === current.body.uuid)
    .reduce<number | undefined>((best, entry) => (best === undefined || entry.serial > best ? entry.serial : best), undefined);
  const machines = [...network.directory.machines(), ...(self !== null ? [{ uuid: self.uuid, name: self.name }] : [])];

  let signed = current;
  let resent = false;
  let key: Awaited<ReturnType<typeof unlockAdminKey>>;
  if (newName === current.body.name) {
    // The machine already has that name: this is the retry of a rename whose sending failed. Nothing is signed or changed, the documents are sent again.
    resent = true;
    o.say(`"${printable(current.body.name)}" is already named "${printable(newName)}": sending the documents of the rename again (nothing is signed again, safe to repeat).\n`);
    o.say('Enter the admin passphrase to sign the documents, Ctrl-C to cancel.\n');
    key = await unlockAdminKey(configDir, o.prompt);
  } else {
    const planned = buildRenamedRegistration({ uuid: current.body.uuid, current: current.body, newName, machines, aliases, revokedUpTo, now: o.now() });
    if (!planned.ok) throw new Error(`${planned.message}. Nothing was signed`);
    o.say(
      [
        `Renaming "${printable(current.body.name)}"`,
        `  name          ${printable(current.body.name)} -> ${newName}`,
        `  uuid          ${current.body.uuid}`,
        `  serial        ${current.body.serial} -> ${planned.body.serial}`,
        `  registration  ${expiryText(current.body.validTo, o.now())} (unchanged: a rename never extends it)`,
        '',
        '',
      ].join('\n'),
    );
    let answer: string;
    try {
      answer = await o.ask(`Rename "${printable(current.body.name)}" to "${newName}"? [y/N] `);
    } catch (e) {
      if (e instanceof PromptTimeoutError) throw e;
      throw new Error(`no terminal to confirm the rename of "${printable(current.body.name)}": run \`machine admin rename ${o.reference} ${newName}\` in a terminal window. Nothing was signed`);
    }
    if (!/^\s*(y|yes)\s*$/i.test(answer)) throw new Error('not renamed: the rename was not confirmed. Nothing was signed');

    o.say('Enter the admin passphrase to sign the new registration, Ctrl-C to cancel.\n');
    key = await unlockAdminKey(configDir, o.prompt);
    // Dated AFTER the passphrase was typed: a slow prompt must not backdate the registration.
    const body = buildRenamedRegistration({ uuid: current.body.uuid, current: current.body, newName, machines, aliases, revokedUpTo, now: o.now() });
    if (!body.ok) throw new Error(`${body.message}. Nothing was signed`);
    const replaces: RegistrationBody = body.body;
    const verdict = registrationReplaces(current.body, replaces);
    if (!verdict.ok) throw new Error(`internal: the renamed registration would not replace the held one (${verdict.message}). Nothing was signed`);
    signed = signRegistration(replaces, key.privateKeyPkcs8);
    // Trust it here first, keeping the pair secret this machine already shares with the renamed machine (a rename changes no key and no secret of this pair).
    importPeer(configDir, { registration: signed, pairSecret: peer.pairSecret.toString('base64url') }, { now: o.now() });
    o.say(`[ok] "${printable(current.body.name)}" is now "${newName}" on this machine (registration serial ${signed.body.serial}).\n`);
    o.say(
      [
        'What changes and what does not:',
        `  - policies, local aliases, connection settings and notice recipients refer to the machine by its uuid: they keep working`,
        `  - \`machine run ${printable(current.body.name)}\` and every other reference by the old name stop working: use "${newName}", the uuid or an alias`,
        '  - lines already written in the run log keep the old name; the audit log shows the current name',
        '  - the other machines and the renamed one learn the new name from the documents sent now',
        '',
        '',
      ].join('\n'),
    );
  }

  const access = adminRelayAccess(configDir, o.client);
  if (access === undefined) {
    o.say(
      `[warn] the rename was NOT distributed: this machine has no admin relay token, so "${printable(newName)}" and its peers do not know the new name yet. ` +
        `Run \`machine admin login\` (confirm the request in the relay console), then \`${retryRename(newName)}\`\n`,
    );
    return { ...outcome(signed.body.serial, resent), distribution: undefined };
  }
  let report: DistributionReport;
  try {
    report = await distributeRename(configDir, current.body.uuid, { client: access.client, adminPrivateKeyPkcs8: key.privateKeyPkcs8, adminUuid: adminMachineUuid(configDir), now: o.now, configDir, direct: directDeliveryFor(configDir, { now: o.now }) });
  } catch (e) {
    report = { delivered: 0, alreadyThere: 0, failures: [{ toUuid: current.body.uuid, toName: newName, kind: 'machine', id: undefined, message: (e as Error).message }], aborted: false, machines: 0 };
  }
  const formatted = formatDistribution(report, 'the rename', retryRename(newName));
  if (formatted.out) o.say(formatted.out);
  return { ...outcome(signed.body.serial, resent), distribution: { report, formatted } };
}
