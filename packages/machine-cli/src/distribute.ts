import { capitalized, FULL_ACCESS_CLICK_PATH, FULL_ACCESS_WHY } from './fullAccess.js';
import { existsSync } from 'node:fs';
import {
  DOCUMENT_RETENTION_SECONDS,
  buildDocument,
  decodeBase64urlStrict,
  derivePairSecretV2,
  documentId,
  mergeRevocations,
  pairSecretDocumentContext,
  revocationDigest,
  sealTo,
  signRevocation,
  type DocumentKind,
  type Json,
  type SignedDocument,
  type SignedPolicy,
  type SignedRegistration,
} from '@wadeck-app/machine-core';
import { adminKeyFile, readAdminPin } from './admin.js';
import { adminRelayError } from './adminRelay.js';
import { NotInitializedError } from './errors.js';
import { exportMachineInfo, loadNetwork, revocationState, signAndInstallRevocation, trustedRegistrations } from './network.js';
import { createRelayClient, RelayError, type RelayClient } from './relayClient.js';
import { readRelayAdminConfig, relayAdminFile } from './relayStore.js';

// Admin side of distribution.md: after an approval, a revocation or a policy, the admin PUTs signed documents into the inbox
// of each machine concerned. Everything is derived from stored facts (registrations, serials, signatures), never from the
// clock, so that running it again produces the same ids and the same documents: it is safe to retry.
// A failure here never undoes the decision that came before it: it is reported, with the exact command that finishes the job.

export interface DistributionFailure {
  toUuid: string;
  toName: string;
  kind: DocumentKind | 'machine';
  id: string | undefined;
  message: string;
}

export interface DistributionReport {
  delivered: number;
  /** The relay already held a document under that id (`id_conflict`, or the same bytes): nothing to do. */
  alreadyThere: number;
  failures: DistributionFailure[];
  /** The relay or the token cannot be used at all: the remaining documents were not attempted. */
  aborted: boolean;
  /** Machines that were considered (each may have received several documents). */
  machines: number;
}

export interface Sender {
  client: RelayClient;
  adminPrivateKeyPkcs8: Uint8Array;
  /** The admin machine, bound into the seal context; null when it has no identity. */
  adminUuid: string | null;
  /** Epoch seconds. Only used to refuse an already expired document and to date a freshly signed revocation. */
  now: () => number;
}

interface Recipient {
  uuid: string;
  name: string;
}

const emptyReport = (): DistributionReport => ({ delivered: 0, alreadyThere: 0, failures: [], aborted: false, machines: 0 });

/** The identity of the admin machine, or null when it has none (`machine init` was never run here). */
export function adminMachineIdentity(configDir: string): { uuid: string; name: string } | null {
  try {
    const info = exportMachineInfo(configDir);
    return { uuid: info.uuid, name: info.name };
  } catch (e) {
    if (e instanceof NotInitializedError) return null;
    throw e;
  }
}

export function adminMachineUuid(configDir: string): string | null {
  return adminMachineIdentity(configDir)?.uuid ?? null;
}

/** Build and send one document. Returns false when the rest must not be attempted (the relay cannot be used at all). */
async function put(sender: Sender, report: DistributionReport, to: Recipient, kind: DocumentKind, build: () => SignedDocument): Promise<boolean> {
  let document: SignedDocument;
  try {
    document = build();
  } catch (e) {
    report.failures.push({ toUuid: to.uuid, toName: to.name, kind, id: undefined, message: (e as Error).message });
    return true;
  }
  try {
    await sender.client.putInboxDocument(to.uuid, document);
    report.delivered++;
    return true;
  } catch (raw) {
    if (raw instanceof RelayError && raw.code === 'id_conflict') {
      report.alreadyThere++;
      return true;
    }
    const message = (adminRelayError(raw) as Error).message;
    report.failures.push({ toUuid: to.uuid, toName: to.name, kind, id: document.body.id, message });
    // An unusable token or an unreachable relay fails every document the same way: say it once.
    if (raw instanceof RelayError && (raw.status === 401 || raw.status === 0)) {
      report.aborted = true;
      return false;
    }
    return true;
  }
}

function peerDocument(sender: Sender, to: SignedRegistration, about: SignedRegistration, secret: string): SignedDocument {
  // From the two registrations only: a retry builds the same dates.
  const issuedAt = Math.max(to.body.validFrom, about.body.validFrom);
  const expiresAt = Math.min(issuedAt + DOCUMENT_RETENTION_SECONDS, to.body.validTo, about.body.validTo);
  if (expiresAt <= sender.now()) {
    throw new Error(`the registration of "${to.body.name}" or of "${about.body.name}" is older than the 30 days the relay keeps a document, or has expired: approve the machine again (or \`machine admin register\`) instead of distributing it`);
  }
  const sealedPairSecret = sealTo(to.body.identityPublicKey, decodeBase64urlStrict(secret, 32, 'pair secret'), pairSecretDocumentContext(sender.adminUuid, to.body.uuid, about.body.uuid));
  return buildDocument(
    {
      kind: 'peer',
      to: to.body.uuid,
      id: documentId(`peer:${to.body.uuid}:${to.body.serial}:${about.body.uuid}:${about.body.serial}`),
      issuedAt,
      expiresAt,
      payload: { registration: about, sealedPairSecret, adminUuid: sender.adminUuid } as unknown as Json,
    },
    sender.adminPrivateKeyPkcs8,
  );
}

/**
 * Tell every other trusted peer of this admin about `subjectUuid`, and tell the subject about each of them, with ONE fresh pair
 * secret per pair (derived from the admin key, so a retry seals the same secret). The admin's own pair secrets are never handed on.
 */
export async function distributeMachine(configDir: string, subjectUuid: string, sender: Sender): Promise<DistributionReport> {
  const report = emptyReport();
  const registrations = trustedRegistrations(configDir, sender.now());
  const subject = registrations.find((r) => r.body.uuid === subjectUuid);
  if (!subject) {
    throw new Error(`machine ${subjectUuid} is not a trusted peer of this machine: only a machine this one trusts can be distributed (see \`machine status\`)`);
  }
  const others = registrations.filter((r) => r.body.uuid !== subjectUuid);
  report.machines = others.length;
  for (const other of others) {
    const secret = derivePairSecretV2(sender.adminPrivateKeyPkcs8, { uuid: subject.body.uuid, serial: subject.body.serial }, { uuid: other.body.uuid, serial: other.body.serial });
    // About the new machine, to the old one; then about the old one, to the new machine.
    if (!(await put(sender, report, { uuid: other.body.uuid, name: other.body.name }, 'peer', () => peerDocument(sender, other, subject, secret)))) break;
    if (!(await put(sender, report, { uuid: subject.body.uuid, name: subject.body.name }, 'peer', () => peerDocument(sender, subject, other, secret)))) break;
  }
  return report;
}

/**
 * The admin machine renewed its own registration: tell every trusted peer about the new one (a higher serial replaces the old one there).
 * The pair secret each peer already shares with this machine is sealed again, unchanged: a new one would leave this machine and that peer
 * disagreeing, since this machine keeps the secret it already has.
 */
export async function distributeAdminRenewal(configDir: string, renewed: SignedRegistration, sender: Sender): Promise<DistributionReport> {
  const report = emptyReport();
  const directory = loadNetwork(configDir, sender.now()).directory;
  const peers = trustedRegistrations(configDir, sender.now());
  report.machines = peers.length;
  for (const peer of peers) {
    const known = directory.find(peer.body.uuid);
    if (!known) continue;
    const secret = known.pairSecret.toString('base64url');
    if (!(await put(sender, report, { uuid: peer.body.uuid, name: peer.body.name }, 'peer', () => peerDocument(sender, peer, renewed, secret)))) break;
  }
  return report;
}

/**
 * Sign the revocation list of this machine (every machine revoked here) and PUT it to every machine this one still trusts, then remove the
 * revoked machine from the relay (address record, owner binding, inbox). Peers learn of the revocation through the document, not through the relay.
 */
export async function distributeRevocation(configDir: string, revokedUuid: string, revokedName: string, sender: Sender): Promise<DistributionReport> {
  const report = emptyReport();
  const pin = readAdminPin(configDir);
  const network = loadNetwork(configDir, sender.now());
  if (!network.revocations.some((r) => r.uuid === revokedUuid)) {
    throw new Error(`machine ${revokedUuid} is not revoked on this machine: nothing to distribute (\`machine admin revoke <machine>\` revokes it)`);
  }
  // A list this machine already signed for exactly these revocations is sent again as it is (a retry is idempotent, peers and admin agree on its
  // version). Only when none covers them exactly is a new union signed, with a version above the held ones, and installed here in the same locked step.
  const wanted = revocationDigest(network.revocations);
  let signed = revocationState(configDir).lists.find((l) => revocationDigest(l.body.entries) === wanted);
  if (signed === undefined) {
    signed = signAndInstallRevocation(configDir, ({ entries, version }) =>
      signRevocation({ v: 1, adminKeyId: pin.adminKeyId, issuedAt: Math.max(sender.now(), version + 1), entries: mergeRevocations(entries, network.revocations) }, sender.adminPrivateKeyPkcs8),
    ).signed;
  }
  const recipients = trustedRegistrations(configDir, sender.now()).filter((r) => r.body.uuid !== revokedUuid);
  report.machines = recipients.length;
  for (const r of recipients) {
    const to = { uuid: r.body.uuid, name: r.body.name };
    const next = await put(sender, report, to, 'revocation', () =>
      buildDocument(
        {
          kind: 'revocation',
          to: to.uuid,
          id: documentId(`revocation:${to.uuid}:${signed.signature}`),
          issuedAt: signed.body.issuedAt,
          expiresAt: signed.body.issuedAt + DOCUMENT_RETENTION_SECONDS,
          payload: signed as unknown as Json,
        },
        sender.adminPrivateKeyPkcs8,
      ),
    );
    if (!next) return report;
  }
  try {
    await sender.client.deleteMachine(revokedUuid);
  } catch (raw) {
    const e = adminRelayError(raw) as Error;
    report.failures.push({ toUuid: revokedUuid, toName: revokedName, kind: 'machine', id: undefined, message: `could not remove "${revokedName}" from the relay: ${e.message}` });
    if (raw instanceof RelayError && (raw.status === 401 || raw.status === 0)) report.aborted = true;
  }
  return report;
}

/** PUT a policy signed by this admin to its target. */
export async function distributePolicy(signed: SignedPolicy, sender: Sender): Promise<DistributionReport> {
  const report = emptyReport();
  report.machines = 1;
  const to = { uuid: signed.body.target, name: signed.body.target };
  await put(sender, report, to, 'policy', () => {
    const issuedAt = signed.body.issuedAt;
    const expiresAt = Math.min(issuedAt + DOCUMENT_RETENTION_SECONDS, signed.body.notAfter);
    if (expiresAt <= sender.now()) throw new Error(`the policy could be applied until ${new Date(signed.body.notAfter * 1000).toISOString()}, which has passed: sign it again`);
    return buildDocument(
      { kind: 'policy', to: to.uuid, id: documentId(`policy:${to.uuid}:${signed.body.version}:${signed.signature}`), issuedAt, expiresAt, payload: signed as unknown as Json },
      sender.adminPrivateKeyPkcs8,
    );
  });
  return report;
}

export interface AdminRelayAccess {
  client: RelayClient;
  relayUrl: string;
}

/** The admin token of this machine as a client, or undefined when `machine admin login` was never run. */
export function adminRelayAccess(configDir: string, injected?: RelayClient): AdminRelayAccess | undefined {
  const config = readRelayAdminConfig(configDir);
  if (config === undefined) return undefined;
  return { client: injected ?? createRelayClient({ baseUrl: config.relayUrl, token: config.token }), relayUrl: config.relayUrl };
}

export const noAdminRelayTokenMessage = (configDir: string): string =>
  `no admin relay token on this machine (${relayAdminFile(configDir)} does not exist): ${FULL_ACCESS_WHY}. ${capitalized(FULL_ACCESS_CLICK_PATH)}, then run \`machine admin login <code>\``;

export function requireAdminKeyFile(configDir: string): void {
  if (!existsSync(adminKeyFile(configDir))) {
    throw new Error(`this machine has no admin key (${adminKeyFile(configDir)} does not exist): run \`machine admin init\` here, or run this command on the machine that holds the admin key`);
  }
}

export interface FormattedDistribution {
  /** Goes to the normal output. */
  out: string;
  /** Goes to the error output; empty when everything is stored. */
  err: string;
  failed: boolean;
}

/** `what` names what was decided ("the approval", "the revocation", "the policy"); `retry` is the exact command that finishes the job. */
export function formatDistribution(report: DistributionReport, what: string, retry: string): FormattedDistribution {
  const failed = report.failures.length > 0;
  const already = report.alreadyThere > 0 ? `, ${report.alreadyThere} already there` : '';
  let out = '';
  if (report.machines === 0 && !failed) out = '[ok] no other peer to inform\n';
  else if (report.delivered > 0 || report.alreadyThere > 0) {
    out = `[ok] ${report.delivered} document(s) stored by the relay for ${report.machines} machine(s)${already}${failed ? ', but some failed (see below)' : ''}\n`;
  }
  if (!failed) return { out, err: '', failed: false };
  const lines = report.failures.map((f) => `[error] ${f.toName} (${f.toUuid}): ${f.kind === 'machine' ? '' : `${f.kind} document${f.id ? ` ${f.id}` : ''} not stored: `}${f.message}`);
  if (report.aborted) lines.push('[error] the relay or the admin token cannot be used: the remaining documents were not attempted');
  lines.push(`[warn] ${what} stands: nothing was undone. The machines above do not know it yet (they learn it when the document reaches them). Run \`${retry}\` to send what is missing; it is safe to run again`);
  return { out, err: `${lines.join('\n')}\n`, failed: true };
}
