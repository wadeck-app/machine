import { DOCUMENT_SKEW_SECONDS, NOT_YET_VALID_LEEWAY_SECONDS, machineNameProblem, registrationReplaces, verifyRegistration, type SignedRegistration } from '@wadeck-app/machine-core';
import { readAdminPin } from './admin.js';
import { readNameSerial, setMachineName, type MachineIdentity } from './identity.js';

// The machine side of a rename (decision 114): the admin re-issued the registration of THIS machine with a new name, same uuid, same identity key, a higher serial.
// The one place a machine keeps its own name is its identity file, so that is what changes. Every refusal message starts with "registration refused (" or
// "this machine does not trust that registration": documentApply.ts reads both as a verdict on the document, never as trouble of this machine.

/** Apply the registration of this machine. Returns `changed: false` when that very registration is already in force. Throws, changing nothing, when it must be refused. */
export function installSelfRegistration(configDir: string, self: MachineIdentity, signed: SignedRegistration, options: { now: number }): { changed: boolean } {
  const pin = readAdminPin(configDir);
  const verified = verifyRegistration(signed, { adminPublicKey: pin.adminPublicKey, now: options.now, skewSeconds: DOCUMENT_SKEW_SECONDS, notBeforeLeewaySeconds: NOT_YET_VALID_LEEWAY_SECONDS });
  if (!verified.ok) {
    throw new Error(`this machine does not trust that registration: it was not accepted by this network's admin key (${verified.reason}: ${verified.message})`);
  }
  const { body } = verified;
  if (body.uuid !== self.uuid) {
    throw new Error(`registration refused (wrong-machine): it is the registration of machine ${body.uuid}, this machine is ${self.uuid} ("${self.name}")`);
  }
  // A name that this build would later refuse to read back as its own identity must never be written: the machine would stop starting.
  const problem = machineNameProblem(body.name);
  if (problem !== undefined) {
    throw new Error(`registration refused (invalid-name): the name ${JSON.stringify(body.name)} is not a valid machine name here (${problem}). The identity file was not changed; ask the admin to rename this machine again with a valid name`);
  }
  const held = readNameSerial(configDir);
  if (body.serial === held && body.name === self.name) {
    return { changed: false };
  }
  const verdict = registrationReplaces({ uuid: self.uuid, identityPublicKey: self.identity.publicKey, serial: held }, body);
  if (!verdict.ok) {
    throw new Error(`registration refused (${verdict.reason}): ${verdict.message}`);
  }
  setMachineName(configDir, body.name, body.serial);
  // The daemon keeps this object for its refusals and notices: it speaks with the new name from now on.
  self.name = body.name;
  return { changed: true };
}
