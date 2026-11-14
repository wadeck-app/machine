import { existsSync } from 'node:fs';
import { keyId, resolveMachineRef, signRevocation } from '@wadeck-app/machine-core';
import { adminKeyFile, readAdminPin, unlockAdminKey, type Prompt } from './admin.js';
import { adminMachineUuid, adminRelayAccess, distributeRevocation, formatDistribution, type DistributionReport, type FormattedDistribution } from './distribute.js';
import { PromptTimeoutError } from './prompt.js';
import { installRevocation, loadNetwork, registeredSerial } from './network.js';
import type { RelayClient } from './relayClient.js';
import { readAliases } from './state.js';

// `machine admin revoke` (decision 50): the way out when the final code differs on the new machine. It signs a
// revocation with the admin key, installs it on THIS machine, and (distribution.md) sends it to every other machine through the
// relay, then removes the revoked machine from the relay. Without an admin relay token the others are NOT told, and the
// output says so in one line with the way to do it.

/** The reference names no trusted machine: the CLI maps it to the reference exit code. */
export class UnresolvedReferenceError extends Error {}

export interface RevokeOptions {
  reference: string;
  prompt: Prompt;
  /** Visible question; rejects without a terminal. */
  ask: (label: string) => Promise<string>;
  say: (text: string) => void;
  /** Epoch seconds. */
  now: () => number;
  /** Tests inject a client; the default uses the admin token of this machine. */
  client?: RelayClient;
}

export interface RevokeResult {
  uuid: string;
  name: string;
  serial: number;
  /** Absent when this machine has no admin relay token (the others were not told). */
  distribution: { report: DistributionReport; formatted: FormattedDistribution } | undefined;
}

export const retryDistribution = (uuid: string): string => `machine admin distribute ${uuid}`;

export async function runRevoke(configDir: string, o: RevokeOptions): Promise<RevokeResult> {
  if (!existsSync(adminKeyFile(configDir))) {
    throw new Error(`this machine has no admin key (${adminKeyFile(configDir)} does not exist): run \`machine admin init\` here, or run this command on the machine that holds the admin key`);
  }
  const pin = readAdminPin(configDir);
  const network = loadNetwork(configDir, o.now());
  const resolved = resolveMachineRef(o.reference, network.directory.machines(), readAliases(configDir));
  if (!resolved.ok) throw new UnresolvedReferenceError(`${resolved.message} (only machines this machine currently trusts can be revoked)`);
  const peer = network.directory.find(resolved.uuid);
  const serial = registeredSerial(configDir, resolved.uuid);
  if (peer === undefined || serial === undefined) throw new Error(`cannot find the registration of ${resolved.uuid} in this machine's peer list: nothing was revoked`);

  o.say(
    [
      `Revoking "${peer.name}"`,
      `  uuid          ${peer.peerId}`,
      `  identity key  ${keyId(peer.identityPublicKey)}`,
      `  serial        ${serial} (this registration and every older one stop being trusted here)`,
      '',
      '',
    ].join('\n'),
  );

  let answer: string;
  try {
    answer = await o.ask(`Revoke "${peer.name}" (${peer.peerId})? [y/N] `);
  } catch (e) {
    if (e instanceof PromptTimeoutError) throw e;
    throw new Error(`no terminal to confirm the revocation of "${peer.name}": run \`machine admin revoke ${o.reference}\` in a terminal window. Nothing was signed`);
  }
  if (!/^\s*(y|yes)\s*$/i.test(answer)) throw new Error('not revoked: the revocation was not confirmed. Nothing was signed');

  o.say('Enter the admin passphrase to sign the revocation, Ctrl-C to cancel.\n');
  const pair = await unlockAdminKey(configDir, o.prompt);
  const signed = signRevocation({ v: 1, adminKeyId: pin.adminKeyId, issuedAt: o.now(), entries: [{ uuid: peer.peerId, serial }] }, pair.privateKeyPkcs8);
  installRevocation(configDir, signed);
  o.say(`[ok] "${peer.name}" revoked on this machine: it no longer appears in the peers and \`machine run\` refuses it\n`);

  // The revocation stands whatever happens next: distribution failures are reported, never undone.
  const access = adminRelayAccess(configDir, o.client);
  if (access === undefined) {
    o.say(
      `[warn] the revocation was NOT distributed: this machine has no admin relay token, so the other peers keep trusting "${peer.name}" until they receive it. ` +
        `Run \`machine admin login <code>\`, then \`${retryDistribution(peer.peerId)}\`\n`,
    );
    return { uuid: peer.peerId, name: peer.name, serial, distribution: undefined };
  }
  let report: DistributionReport;
  let formatted: FormattedDistribution;
  try {
    report = await distributeRevocation(configDir, peer.peerId, peer.name, { client: access.client, adminPrivateKeyPkcs8: pair.privateKeyPkcs8, adminUuid: adminMachineUuid(configDir), now: o.now });
    formatted = formatDistribution(report, 'the revocation', retryDistribution(peer.peerId));
  } catch (e) {
    report = { delivered: 0, alreadyThere: 0, failures: [{ toUuid: peer.peerId, toName: peer.name, kind: 'machine', id: undefined, message: (e as Error).message }], aborted: false, machines: 0 };
    formatted = formatDistribution(report, 'the revocation', retryDistribution(peer.peerId));
  }
  if (formatted.out) o.say(formatted.out);
  return { uuid: peer.peerId, name: peer.name, serial, distribution: { report, formatted } };
}
