import { isUuid, resolveMachineRef } from '@wadeck-app/machine-core';
import { UnresolvedReferenceError } from './adminRevoke.js';
import { loadNetwork } from './network.js';
import { forgetPeerRecord, readPeerRecords } from './peerAddresses.js';
import { PromptTimeoutError } from './prompt.js';
import { readAliases } from './state.js';

// `machine peer forget-record <peer>`: forgets the highest address record seq seen for ONE peer (peer-records.json). It is the only way
// out when a peer was really reinstalled and its counter went back; it removes the rollback protection for that peer once, so it asks.

export interface ForgetRecordOptions {
  reference: string;
  /** Visible question; rejects without a terminal. */
  ask: (label: string) => Promise<string>;
  say: (text: string) => void;
  now: () => number;
}

export interface ForgetRecordResult {
  uuid: string;
  name: string | undefined;
  hadRecord: boolean;
}

export async function runForgetPeerRecord(configDir: string, o: ForgetRecordOptions): Promise<ForgetRecordResult> {
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
    throw new UnresolvedReferenceError(`${resolved.message} (forget-record takes a peer this machine trusts, or a full machine uuid)`);
  }
  const label = name !== undefined ? `"${name}" (${uuid})` : uuid;
  const known = readPeerRecords(configDir)[uuid];
  if (known === undefined) {
    o.say(`[ok] no address record is remembered for ${label}: nothing to forget\n`);
    return { uuid, name, hadRecord: false };
  }
  o.say(
    [
      `Forgetting the address records seen for ${label}: the highest is seq ${known.seq} (issued ${new Date(known.issuedAt * 1000).toISOString()}).`,
      'Afterwards the next record the relay gives for this machine is accepted WITHOUT any rollback check: the relay (or anybody holding a token) could then',
      'serve an old but validly signed record, up to 30 days old, and this machine would use its addresses.',
      `Use it ONLY after confirming out of band (phone call, in person, ssh) that ${name !== undefined ? `"${name}"` : 'that machine'} was reinstalled or lost its state.`,
      '',
      '',
    ].join('\n'),
  );
  let answer: string;
  try {
    answer = await o.ask(`Forget the address records of ${label}? [y/N] `);
  } catch (e) {
    if (e instanceof PromptTimeoutError) throw e;
    throw new Error(`no terminal to confirm: run \`machine peer forget-record ${o.reference}\` in a terminal window. Nothing was forgotten`);
  }
  if (!/^\s*(y|yes)\s*$/i.test(answer)) throw new Error('not forgotten: the question was not confirmed. Nothing was forgotten');
  forgetPeerRecord(configDir, uuid);
  o.say(`[ok] forgot the address records of ${label}: the next one is accepted without any rollback check\n`);
  return { uuid, name, hadRecord: true };
}
