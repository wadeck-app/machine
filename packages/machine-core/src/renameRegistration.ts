import { keyId } from './keys.js';
import { machineNameProblem, type MachineEntry } from './reference.js';
import type { RegistrationBody } from './registration.js';

// Rename of a machine (decision 114): the admin re-issues its registration with the SAME uuid and identity key, the new name and serial + 1.
// Pure: no I/O, no signature (the caller signs the body with `signRegistration`).

export type RenameFailure = 'unknown-machine' | 'revoked' | 'expired' | 'invalid-name' | 'same-name' | 'name-taken' | 'alias-conflict' | 'lookalike';

export type RenameResult = { ok: true; body: RegistrationBody } | { ok: false; reason: RenameFailure; message: string };

export interface RenameRegistrationInput {
  uuid: string;
  /** The newest registration this machine holds for `uuid` (the one currently trusted), or undefined when there is none. */
  current: RegistrationBody | undefined;
  newName: string;
  /** Every machine whose name is taken: the trusted peers AND this admin machine, the renamed machine included. */
  machines: readonly MachineEntry[];
  /** Local aliases: alias (lowercase) to uuid. */
  aliases: Readonly<Record<string, string>>;
  /** The highest serial of `uuid` covered by an installed revocation, or undefined. */
  revokedUpTo: number | undefined;
  /** Epoch seconds. */
  now: number;
}

const short = (uuid: string): string => uuid.slice(0, 8);
const skeleton = (name: string): string => name.toLowerCase().replace(/-/g, '');

function fail(reason: RenameFailure, message: string): RenameResult {
  return { ok: false, reason, message };
}

/**
 * The registration body of a renamed machine. Validity: `validFrom` is now, `validTo` stays what it was (a rename never extends the trust of a
 * machine; renewing is `machine admin approve`). Refuses, naming the cause and the fix: unknown machine, revoked, expired, invalid name,
 * same name, a name used by another machine, a name that only differs from another by hyphens, a name that is a local alias of another machine.
 */
export function buildRenamedRegistration(input: RenameRegistrationInput): RenameResult {
  const { current, uuid, newName } = input;
  if (current === undefined || current.uuid !== uuid) {
    return fail('unknown-machine', `no trusted registration is held here for machine ${uuid}: only a machine this one trusts can be renamed (\`machine status\` and \`machine list\` show them)`);
  }
  if (input.revokedUpTo !== undefined && input.revokedUpTo >= current.serial) {
    return fail('revoked', `"${current.name}" (${uuid}) is revoked here (serial ${input.revokedUpTo}): a revoked machine cannot be renamed. Enroll it again with \`machine join\` then \`machine admin approve\`, and name it there`);
  }
  if (input.now > current.validTo) {
    return fail('expired', `the registration of "${current.name}" expired at ${new Date(current.validTo * 1000).toISOString()}: a rename does not renew it. Run \`machine admin approve\` for this machine (it renews the registration), then rename it`);
  }
  const problem = machineNameProblem(newName);
  if (problem !== undefined) {
    return fail('invalid-name', `invalid name ${JSON.stringify(newName)}: ${problem}. Nothing was signed`);
  }
  if (newName === current.name) {
    return fail('same-name', `"${current.name}" already has the name "${newName}": nothing to change`);
  }
  const others = input.machines.filter((m) => m.uuid !== uuid);
  const taken = others.find((m) => m.name.toLowerCase() === newName);
  if (taken !== undefined) {
    return fail('name-taken', `the name "${newName}" is already used by machine "${taken.name}" (${short(taken.uuid)}): pick another name, or rename that machine first`);
  }
  const lookalike = others.find((m) => skeleton(m.name) === skeleton(newName));
  if (lookalike !== undefined) {
    return fail('lookalike', `the name "${newName}" differs from "${lookalike.name}" (${short(lookalike.uuid)}) only by hyphens: two machines whose names look alike are easy to mistake for each other. Pick a clearly different name`);
  }
  const aliased = Object.prototype.hasOwnProperty.call(input.aliases, newName) ? input.aliases[newName] : undefined;
  if (aliased !== undefined && aliased.toLowerCase() !== uuid.toLowerCase()) {
    return fail('alias-conflict', `"${newName}" is a local alias of another machine (${short(aliased)}), and an alias wins over a name: after the rename, "${newName}" would still mean that other machine here. Remove the alias first (\`machine alias remove ${newName}\`) or pick another name`);
  }
  return { ok: true, body: { ...current, name: newName, serial: current.serial + 1, validFrom: input.now } };
}

export type ReplaceVerdict = { ok: true; action: 'add' | 'replace' } | { ok: false; reason: 'other-machine' | 'key-changed' | 'not-newer'; message: string };

/**
 * The rule for a re-issued registration of a machine already known: the SAME uuid, the SAME identity key and a HIGHER serial replace the stored
 * one; a different identity key for the same uuid is refused (that is a new machine taking a uuid, not a rename: it goes through `machine admin approve`).
 */
export function registrationReplaces(stored: Pick<RegistrationBody, 'uuid' | 'identityPublicKey' | 'serial'> | undefined, incoming: RegistrationBody): ReplaceVerdict {
  if (stored === undefined) return { ok: true, action: 'add' };
  if (stored.uuid !== incoming.uuid) {
    return { ok: false, reason: 'other-machine', message: `the registration is for machine ${incoming.uuid}, not for ${stored.uuid}` };
  }
  if (stored.identityPublicKey !== incoming.identityPublicKey) {
    return {
      ok: false,
      reason: 'key-changed',
      message: `the registration of machine ${incoming.uuid} carries identity key ${keyId(incoming.identityPublicKey)}, but the one held is ${keyId(stored.identityPublicKey)}: a rename never changes the key. A new key is a new enrollment (\`machine admin approve\` after \`machine join\`)`,
    };
  }
  if (incoming.serial <= stored.serial) {
    return { ok: false, reason: 'not-newer', message: `the registration has serial ${incoming.serial}, not above the held serial ${stored.serial}: only a higher serial replaces it` };
  }
  return { ok: true, action: 'replace' };
}
