import { existsSync } from 'node:fs';
import { keyId, resolveMachineRef, signRevocation } from '@wadeck-app/machine-core';
import { adminKeyFile, readAdminPin, unlockAdminKey, type Prompt } from './admin.js';
import { installRevocation, loadNetwork, registeredSerial } from './network.js';
import { readAliases } from './state.js';

// `machine admin revoke` (decision 50): the way out when the final code differs on the new machine. It signs a
// revocation with the admin key and installs it on THIS machine only: distributing it to the other peers is a separate
// contract that does not exist yet.

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
}

export interface RevokeResult {
  uuid: string;
  name: string;
  serial: number;
}

export const REVOKE_LIMIT =
  '[warn] KNOWN LIMIT: this revocation is installed on THIS machine only. Every other peer keeps trusting the revoked machine until a signed revocation reaches it, and the distribution of revocations is a separate contract that does not exist yet. Until then, treat the machine as still trusted by the others';

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
  } catch {
    throw new Error(`no terminal to confirm the revocation of "${peer.name}": run \`machine admin revoke ${o.reference}\` in a terminal window. Nothing was signed`);
  }
  if (!/^\s*(y|yes)\s*$/i.test(answer)) throw new Error('not revoked: the revocation was not confirmed. Nothing was signed');

  o.say('Enter the admin passphrase to sign the revocation, Ctrl-C to cancel.\n');
  const pair = await unlockAdminKey(configDir, o.prompt);
  const signed = signRevocation({ v: 1, adminKeyId: pin.adminKeyId, issuedAt: o.now(), entries: [{ uuid: peer.peerId, serial }] }, pair.privateKeyPkcs8);
  installRevocation(configDir, signed);
  o.say(`[ok] "${peer.name}" revoked on this machine: it no longer appears in the peers and \`machine run\` refuses it\n${REVOKE_LIMIT}\n`);
  return { uuid: peer.peerId, name: peer.name, serial };
}
