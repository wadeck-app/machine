import { isUuid, resolveMachineRef } from '@wadeck-app/machine-core';
import { UnresolvedReferenceError } from './adminRevoke.js';
import { viaAdminToken } from './adminRelay.js';
import { adminRelayAccess, noAdminRelayTokenMessage } from './distribute.js';
import { loadNetwork, resolveRevokedMachine } from './network.js';
import { PromptTimeoutError } from './prompt.js';
import type { RelayClient } from './relayClient.js';
import { networkAliasMap } from './aliasesStore.js';
import { readAliases } from './state.js';

// `machine admin forget-relay-record <machine>`: DELETE /api/machines/{uuid} with the admin relay token. It removes the address record, the
// inbox AND the binding of the uuid to a token (relay-api.md, "Ownership bound at approval"): the way to free the room taken by machines that
// are gone (`429 too_many_machines` at approval). A machine that comes back must post a new candidacy and be approved again. It is no longer
// needed after a token rotation: a new candidacy plus the approval rebinds.

export interface ForgetOptions {
  reference: string;
  /** Visible question; rejects without a terminal. */
  ask: (label: string) => Promise<string>;
  say: (text: string) => void;
  /** Epoch seconds. */
  now: () => number;
  /** Tests inject a client; the default uses the admin token of this machine. */
  client?: RelayClient;
}

export interface ForgetResult {
  uuid: string;
  name: string | undefined;
}

export async function runForgetRelayRecord(configDir: string, o: ForgetOptions): Promise<ForgetResult> {
  const access = adminRelayAccess(configDir, o.client);
  if (access === undefined) throw new Error(noAdminRelayTokenMessage(configDir));

  // A machine this one trusts by name, alias or uuid; a machine revoked here by name, alias, uuid or uuid prefix (its registration is still stored,
  // so the name survives the revoke); or any full uuid (a machine removed some other way, whose record is still on the relay).
  const network = loadNetwork(configDir, o.now());
  const aliases = readAliases(configDir);
  const resolved = resolveMachineRef(o.reference, network.directory.machines(), aliases, networkAliasMap(configDir));
  let uuid: string;
  let name: string | undefined;
  let revoked = false;
  if (resolved.ok) {
    uuid = resolved.uuid;
    name = network.directory.find(uuid)?.name;
  } else {
    const gone = resolveRevokedMachine(configDir, o.reference, aliases);
    if (gone.ok) {
      uuid = gone.machine.uuid;
      name = gone.machine.name;
      revoked = true;
    } else if (gone.reason === 'ambiguous') {
      throw new UnresolvedReferenceError(gone.message);
    } else if (isUuid(o.reference)) {
      uuid = o.reference.toLowerCase();
    } else {
      throw new UnresolvedReferenceError(
        `"${o.reference}" matches no trusted machine (\`machine list\`) and no revoked machine (\`machine status\` lists them): give a name or uuid from one of those, or the full uuid of a machine this one never knew`,
      );
    }
  }
  const label = name !== undefined ? `"${name}" (${revoked ? 'revoked machine ' : ''}${uuid})` : revoked ? `${uuid} (revoked machine)` : uuid;

  o.say(
    [
      `Forgetting ${label} on the relay ${access.relayUrl}`,
      '  removes its address record, the binding of its uuid to a relay token, and every document waiting in its inbox',
      '  the machine itself is not touched, but it is not registered on the relay any more: it must post a new candidacy and be approved again',
      '',
      '',
    ].join('\n'),
  );
  let answer: string;
  try {
    answer = await o.ask(`Forget ${label} on the relay? [y/N] `);
  } catch (e) {
    if (e instanceof PromptTimeoutError) throw e;
    throw new Error(`no terminal to confirm: run \`machine admin forget-relay-record ${o.reference}\` in a terminal window. Nothing was deleted`);
  }
  if (!/^\s*(y|yes)\s*$/i.test(answer)) throw new Error('not removed: the deletion was not confirmed. Nothing was deleted');

  await viaAdminToken(() => access.client.deleteMachine(uuid));
  if (revoked) {
    // Nothing to re-send to a revoked machine: it stays refused here, and the admin approves it again only if that is wanted.
    o.say(
      `[ok] the relay forgot ${label}: record, owner binding and inbox removed.\n` +
        `The machine stays revoked on this machine (it is refused here). To let it back: it runs \`machine join --resume\`, then \`machine admin approve\` here enrolls it again with a new registration.\n`,
    );
    return { uuid, name };
  }
  o.say(
    `[ok] the relay forgot ${label}: record, owner binding and inbox removed.\n` +
      `If this machine is still in use: it is not registered on the relay any more (not_registered). Run \`machine join --resume\` on it, then \`machine admin approve\` here to approve the new candidacy: only then does it publish its record and read its inbox again. ` +
      `What waited in its inbox is gone: run \`machine admin distribute ${name ?? uuid}\` to send the peer documents again, and \`machine admin distribute --policy <signed.json>\` for its policy\n`,
  );
  return { uuid, name };
}
