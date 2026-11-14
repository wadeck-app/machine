import { readFileSync } from 'node:fs';
import { isUuid, resolveMachineRef, type SignedPolicy } from '@wadeck-app/machine-core';
import { unlockAdminKey, type Prompt } from './admin.js';
import { UnresolvedReferenceError, retryDistribution } from './adminRevoke.js';
import {
  adminMachineUuid,
  adminRelayAccess,
  distributeMachine,
  distributePolicy,
  distributeRevocation,
  formatDistribution,
  noAdminRelayTokenMessage,
  requireAdminKeyFile,
  type DistributionReport,
  type FormattedDistribution,
  type Sender,
} from './distribute.js';
import { loadNetwork } from './network.js';
import type { RelayClient } from './relayClient.js';
import { readAliases } from './state.js';

// `machine admin distribute <machine>` and `machine admin distribute --policy <signed-policy.json>` (distribution.md): send again what an
// approval, a revocation or a policy signature sends the first time. Ids and dates come from stored facts, so it is safe to run again.

export interface DistributeOptions {
  /** A machine reference (trusted peer), or the uuid of a machine revoked here. Absent when `policyFile` is given. */
  reference?: string;
  /** A signed policy file written by `machine admin sign-policy --out`. */
  policyFile?: string;
  prompt: Prompt;
  say: (text: string) => void;
  /** Epoch seconds. */
  now: () => number;
  client?: RelayClient;
}

export interface DistributeResult {
  what: string;
  report: DistributionReport;
  formatted: FormattedDistribution;
}

function readSignedPolicy(file: string): SignedPolicy {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') throw new Error(`the signed policy ${file} does not exist: pass the file written by \`machine admin sign-policy --out\``);
    throw new Error(`the signed policy ${file} cannot be read as JSON (${(e as Error).message})`);
  }
  const o = parsed as { body?: { target?: unknown }; signature?: unknown } | null;
  if (typeof o !== 'object' || o === null || typeof o.body !== 'object' || o.body === null || typeof o.signature !== 'string' || typeof o.body.target !== 'string') {
    throw new Error(`${file} is not a signed policy ({ body, signature }): pass the file written by \`machine admin sign-policy --out\``);
  }
  return o as SignedPolicy;
}

export async function runDistribute(configDir: string, o: DistributeOptions): Promise<DistributeResult> {
  requireAdminKeyFile(configDir);
  const access = adminRelayAccess(configDir, o.client);
  if (access === undefined) throw new Error(noAdminRelayTokenMessage(configDir));

  if (o.policyFile !== undefined) {
    const signed = readSignedPolicy(o.policyFile);
    o.say('Enter the admin passphrase to sign the policy document, Ctrl-C to cancel.\n');
    const key = await unlockAdminKey(configDir, o.prompt);
    const sender: Sender = { client: access.client, adminPrivateKeyPkcs8: key.privateKeyPkcs8, adminUuid: adminMachineUuid(configDir), now: o.now };
    const report = await distributePolicy(signed, sender);
    const formatted = formatDistribution(report, 'the policy', `machine admin distribute --policy ${o.policyFile}`);
    return { what: `policy version ${signed.body.version} for ${signed.body.target}`, report, formatted };
  }

  const reference = o.reference as string;
  const network = loadNetwork(configDir, o.now());
  const resolved = resolveMachineRef(reference, network.directory.machines(), readAliases(configDir));
  // A machine revoked here is no longer in the directory: it is named by its uuid.
  const revoked = !resolved.ok && isUuid(reference) ? network.revocations.find((r) => r.uuid === reference.toLowerCase()) : undefined;
  if (!resolved.ok && revoked === undefined) {
    throw new UnresolvedReferenceError(`${resolved.message} (distribute takes a machine this one trusts, or the uuid of a machine revoked here)`);
  }
  o.say('Enter the admin passphrase to sign the documents, Ctrl-C to cancel.\n');
  const key = await unlockAdminKey(configDir, o.prompt);
  const sender: Sender = { client: access.client, adminPrivateKeyPkcs8: key.privateKeyPkcs8, adminUuid: adminMachineUuid(configDir), now: o.now };
  if (revoked !== undefined) {
    const report = await distributeRevocation(configDir, revoked.uuid, revoked.uuid, sender);
    return { what: `the revocation of ${revoked.uuid}`, report, formatted: formatDistribution(report, 'the revocation', retryDistribution(revoked.uuid)) };
  }
  const uuid = (resolved as { ok: true; uuid: string }).uuid;
  const report = await distributeMachine(configDir, uuid, sender);
  return { what: `machine ${uuid}`, report, formatted: formatDistribution(report, 'the approval', retryDistribution(uuid)) };
}
