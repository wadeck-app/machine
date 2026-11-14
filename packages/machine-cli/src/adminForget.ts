import { isUuid, resolveMachineRef } from '@wadeck-app/machine-core';
import { UnresolvedReferenceError } from './adminRevoke.js';
import { viaAdminToken } from './adminRelay.js';
import { adminRelayAccess, noAdminRelayTokenMessage } from './distribute.js';
import { loadNetwork } from './network.js';
import { PromptTimeoutError } from './prompt.js';
import type { RelayClient } from './relayClient.js';
import { readAliases } from './state.js';

// `machine admin forget-relay-record <machine>`: DELETE /api/machines/{uuid} with the admin relay token. It is the fix of the `not_owner`
// that a machine gets when it publishes its address record after a token rotation: the relay binds a record (and the inbox) to the first
// token that wrote it, and only a full-access token can free it (relay-api.md "Deployed limits", distribution.md "Ownership").

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

  // A machine this one trusts by name, alias or uuid; or any uuid (a machine that was revoked or removed, whose record is still on the relay).
  const network = loadNetwork(configDir, o.now());
  const resolved = resolveMachineRef(o.reference, network.directory.machines(), readAliases(configDir));
  let uuid: string;
  let name: string | undefined;
  if (resolved.ok) {
    uuid = resolved.uuid;
    name = network.directory.find(uuid)?.name;
  } else if (isUuid(o.reference)) {
    uuid = o.reference.toLowerCase();
  } else {
    throw new UnresolvedReferenceError(`${resolved.message} (forget-relay-record takes a machine this one trusts, or a full machine uuid)`);
  }
  const label = name !== undefined ? `"${name}" (${uuid})` : uuid;

  o.say(
    [
      `Forgetting ${label} on the relay ${access.relayUrl}`,
      '  removes its address record, the binding of the record to a relay token, and every document waiting in its inbox',
      '  the machine itself is not touched: its daemon publishes its address record again by itself at its next heartbeat (60 s) with its CURRENT token',
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
  o.say(
    `[ok] the relay forgot ${label}: record, owner binding and inbox removed.\n` +
      `The daemon of that machine publishes again by itself (within about 60 s) and owns its record again. ` +
      `What waited in its inbox is gone: run \`machine admin distribute ${name ?? uuid}\` to send the peer documents again, and \`machine admin distribute --policy <signed.json>\` for its policy\n`,
  );
  return { uuid, name };
}
