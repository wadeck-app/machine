import { canonicalize, isRevoked, openPairSecret, verifyInboxDocument, type Json, type VerifiedDocument } from '@wadeck-app/machine-core';
import { readAdminPin } from './admin.js';
import type { MachineIdentity } from './identity.js';
import { importPeer, installPolicy, installRevocation, loadNetwork } from './network.js';
import { installNoticeRecipients } from './noticeRecipientsStore.js';

// The ONE place where a document of the admin is verified and applied on the machine it is addressed to (distribution.md). The relay inbox
// (inboxLoop.ts) and the direct `deliver-document` frame (peerService.ts, decision 86) both call it: the same checks in the same order (pinned admin
// key signature, sealed to me, kind, id, serial and compare-and-set rules of the installers, expiry), so a document is never accepted by one path
// and refused by the other. It decides nothing about WHERE the document came from and never trusts it: the caller maps the result to what is
// right for its channel (acknowledge and delete in the inbox, answer an ack or a refusal on the peer channel).

/** Printable ASCII only and bounded: text that came from a document never reaches a log, the audit log or a peer raw. */
export const safe = (text: string, max = 300): string => text.replace(/[^\x20-\x7e]/g, '?').slice(0, max);

/** Failures of the installation validators that are verdicts on the document (permanent), as opposed to trouble of this machine. */
const REFUSAL = /^(this machine does not trust that registration|the bundle's pair secret is invalid|policy refused \(|notice-recipients list refused \(|revocation refused \()/;

export type ApplyResult =
  /** The document is applied now, or it changed nothing because that very content was already in force. */
  | { status: 'installed' | 'already-installed'; kind: string; id: string }
  /** No admin key is pinned on this machine: nothing can be verified. */
  | { status: 'not-enrolled' }
  /** The pinned admin key itself is unusable: every document is kept, none is judged. */
  | { status: 'blocked'; reason: 'invalid-admin-key'; message: string }
  /** Not a document of the admin (junk, a forgery, another id than announced): nothing is said about it beyond the reason. */
  | { status: 'unverified'; reason: string; kind: string; id: string | undefined }
  /** Valid, but not yet: the clock (of either machine) has not reached it. */
  | { status: 'deferred'; reason: 'not-yet-valid'; kind: string; id: string; message: string }
  /** A policy whose predecessor is not installed here yet. */
  | { status: 'waiting'; reason: 'waiting-predecessor'; kind: string; id: string; message: string; version: number; baseVersion: number }
  /** The sealed pair secret does not open with this identity key: nothing is installed, and the document must not vanish quietly. */
  | { status: 'unopenable'; kind: string; id: string; message: string }
  /** A verified document of the admin that this machine refuses for good. */
  | { status: 'refused'; reason: string; kind: string; id: string; message: string }
  /** Trouble of this machine (disk, unreadable files): neither a verdict on the document nor a success. */
  | { status: 'error'; kind: string; id: string; message: string };

export interface DocumentApplierOptions {
  configDir: string;
  self: MachineIdentity;
  /** Epoch seconds. */
  now: () => number;
  /** Called after a document changed what this machine trusts or may run (a new peer, a policy, a revocation): the daemon drops its network cache. */
  onInstalled?: () => void;
  /** Called after a revocation list was installed (the daemon closes the open sessions of revoked peers). */
  onRevocationInstalled?: () => void;
  log?: (line: string) => void;
}

export type DocumentApplier = (document: unknown, expectedId?: string) => ApplyResult;

function describeKind(document: unknown): string {
  const kind = (document as { body?: { kind?: unknown } } | null)?.body?.kind;
  return typeof kind === 'string' ? safe(kind, 20) : 'unknown';
}

export function createDocumentApplier(o: DocumentApplierOptions): DocumentApplier {
  const selfUuid = o.self.uuid;

  const install = (verified: VerifiedDocument, networkPolicy: unknown): { reason?: string } => {
    const now = o.now();
    if (verified.kind === 'peer') {
      const pairSecret = openPairSecret(verified, o.self.identity.privateKeyPkcs8);
      importPeer(o.configDir, { registration: verified.signedRegistration, pairSecret }, { now });
      o.onInstalled?.();
      return {};
    }
    if (verified.kind === 'policy') {
      try {
        installPolicy(o.configDir, verified.policy, { now });
      } catch (e) {
        // The same policy again (a second document carrying what is already in force) is not an alarm.
        const sameAsInForce = networkPolicy !== undefined && canonicalize(networkPolicy as Json) === canonicalize(verified.policy.body as unknown as Json);
        if (sameAsInForce && /policy refused \((stale-base|rollback)\)/.test((e as Error).message)) {
          return { reason: 'already-installed' };
        }
        throw e;
      }
      o.onInstalled?.();
      return {};
    }
    if (verified.kind === 'notice-recipients') {
      // Information only (request-notices.md): the list decides who receives notices, never a right. The replace-newer rule keeps an older list out.
      const installed = installNoticeRecipients(o.configDir, verified.noticeRecipients, readAdminPin(o.configDir).adminPublicKey);
      return installed.changed ? {} : { reason: 'already-installed' };
    }
    if (verified.revocation.body.entries.some((entry) => entry.uuid === selfUuid)) {
      o.log?.('inbox: THIS machine is on the revocation list of the admin: its peers no longer trust it');
    }
    const installed = installRevocation(o.configDir, verified.revocation, { now });
    if (installed.changed) {
      o.onRevocationInstalled?.();
      o.onInstalled?.();
    }
    return installed.changed ? {} : { reason: 'already-installed' };
  };

  return (document, expectedId) => {
    const kind = describeKind(document);
    const claimed = (document as { body?: { id?: unknown } } | null)?.body?.id;
    const claimedId = expectedId ?? (typeof claimed === 'string' ? safe(claimed, 40) : undefined);
    const network = loadNetwork(o.configDir, o.now());
    if (!network.enrolled) {
      return { status: 'not-enrolled' };
    }
    const verified = verifyInboxDocument(document, {
      adminPublicKey: readAdminPin(o.configDir).adminPublicKey,
      selfUuid,
      now: o.now(),
      isRevoked: (uuid, serial) => isRevoked(network.revocations, uuid, serial),
      // Every document is sealed to this machine (decision 78). A clear (version 1) document, or one that does not open with this key, is refused
      // like any verdict on a document of the admin: never installed.
      identityPrivateKeyPkcs8: o.self.identity.privateKeyPkcs8,
    });
    if (!verified.ok) {
      if (verified.reason === 'invalid-admin-key') {
        return { status: 'blocked', reason: 'invalid-admin-key', message: verified.message };
      }
      if (!verified.signed) {
        return { status: 'unverified', reason: verified.reason, kind, id: claimedId };
      }
      const id = claimedId ?? 'unknown';
      if (verified.reason === 'not-yet-valid') {
        return { status: 'deferred', reason: 'not-yet-valid', kind, id, message: verified.message };
      }
      return { status: 'refused', reason: verified.reason, kind, id, message: verified.message };
    }
    if (expectedId !== undefined && verified.body.id !== expectedId) {
      return { status: 'unverified', reason: 'id-mismatch', kind, id: expectedId };
    }
    const id = verified.body.id;
    let outcome: { reason?: string };
    try {
      outcome = install(verified, network.policy);
    } catch (e) {
      const message = (e as Error).message;
      if (/not-yet-valid/.test(message)) {
        return { status: 'deferred', reason: 'not-yet-valid', kind, id, message };
      }
      if (/^cannot open the sealed pair secret/.test(message)) {
        return { status: 'unopenable', kind, id, message };
      }
      if (verified.kind === 'policy' && /policy refused \(stale-base\)/.test(message) && verified.policy.body.baseVersion > (network.policy?.version ?? 0)) {
        return {
          status: 'waiting',
          reason: 'waiting-predecessor',
          kind,
          id,
          message: `policy version ${verified.policy.body.version} is waiting: version ${verified.policy.body.baseVersion} is not installed here yet`,
          version: verified.policy.body.version,
          baseVersion: verified.policy.body.baseVersion,
        };
      }
      if (REFUSAL.test(message)) {
        return { status: 'refused', reason: 'install-refused', kind, id, message };
      }
      return { status: 'error', kind, id, message };
    }
    return { status: outcome.reason === 'already-installed' ? 'already-installed' : 'installed', kind, id };
  };
}
