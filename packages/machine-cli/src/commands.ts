import { dismissStoredNotices } from './noticesStore.js';
import { isUuid, resolveMachineRef, type HoldTable, type MachineEntry, type PolicyMode, type Resolution } from '@wadeck-app/machine-core';
import { AliasConflictError, NoSuchAliasError, NotInitializedError } from './errors.js';
import { readMachine, type MachineIdentity } from './identity.js';
import { loadNetwork, readRevocationSeen, revocationState, revokedMachines, type RevokedMachine } from './network.js';
import { readAliases, removeAlias, setAlias } from './state.js';
import { noticeHolders, type NoticeHoldersAnswer } from './adminNotifyTo.js';
import { requestsAnswer, type RequestsAnswer } from './requestsView.js';
import { directDeliveryFor } from './directDelivery.js';
import { holdProgressCommand, type HoldProgressAnswer } from './holdProgress.js';
import { answerOf, reachabilityOnce, type ReachabilityAnswer } from './reachabilityWiring.js';
import type { ReachabilityProbe } from './reachabilityProbe.js';
import { approveContext, importCandidate, type ImportCandidateAnswer } from './candidateImport.js';
import { approveDistribute, type ApproveDistributeAnswer } from './approveDistribute.js';
import { revokeApply, revokeContext, type RevokeApplyAnswer } from './revokeFromPage.js';
import { adminKeyText, allowContext, submitPolicy, type SubmitAnswer } from './policyWeb.js';
import { denyRemoteCommand, type DenyOnPeerResult } from './denyRemote.js';
import { remoteRequestsCommand, type RemoteRequestsAnswer } from './requestsViaDaemon.js';
import { allowedAnswer, type AllowedAnswer } from './allowedAnswer.js';
import { activityFromPayload, type ActivityAnswer } from './activityView.js'; // run-log

// The daemon commands. Each is a plain function of the config directory, so the CLI runs the very same code in-process
// when no daemon is running and the tests need no network. No answer ever carries a secret.

export interface NotInitialized {
  initialized: false;
  message: string;
}

export interface StatusAnswer {
  initialized: true;
  uuid: string;
  name: string;
  version: string;
  enrolled: boolean;
  peers: number;
  /** Version of the policy in force on this machine; absent when there is none (everything is refused). */
  policyVersion?: number;
  /** Who manages the allow list of this machine: the admin (default) or this machine itself (`machine policy local enable`). */
  policyMode: PolicyMode;
  /** Mode local: the id of the pinned local policy key. */
  localPolicyKeyId?: string;
  /** Version (issuedAt of the newest admin-signed list) of the revocations held here; 0 when none. Present when enrolled. */
  revocationVersion?: number;
  /** Peers whose revocations, announced (digest) at their last handshake, differ from ours: they may still trust a revoked machine until they meet a peer that has the lists. The version is informational. */
  peersBehind?: Array<{ uuid: string; name: string; revocationVersionSeen: number }>;
  /** Machines revoked on this machine (not trusted any more), with the uuid and when the revocation was installed here. Absent when there is none. */
  revoked?: RevokedMachine[];
  /** What was left out of the network and why (invalid registration, tampered policy, ...). */
  problems: string[];
  configDir: string;
  note?: string;
}

export interface ListAnswer {
  initialized: true;
  self: MachineEntry & { aliases: string[] };
  /** revocationVersionSeen: the revocation version the peer announced at its last handshake (absent: never seen), revocationSeenAt: when (epoch seconds). */
  peers: Array<MachineEntry & { aliases: string[]; revocationVersionSeen?: number; revocationSeenAt?: number }>;
  /** Why the revocation versions are missing (unreadable state file). */
  revocationWarning?: string;
  enrolled: boolean;
  /** The policy mode of THIS machine; the mode of a peer is not published (it is not in its registration nor in its address record), so it is not known here. */
  policyMode: PolicyMode;
  note?: string;
}

/** The answer of the daemon command `dismissNotice` (decision 100). */
export type DismissAnswer = { ok: true; removed: number } | { ok: false; reason: 'unknown' | 'live' | 'none'; message: string };
export type DenyAnswer ={ ok: true; id: string; peer: string; shell: string; command: string } | { ok: false; reason: 'unknown' | 'ambiguous' | 'too-short' | 'bad-reason' | 'no-daemon'; message: string };
export type ResolveAnswer = (Resolution & { name?: string }) | NotInitialized;
export type AliasAnswer = { ok: true; alias: string; uuid: string; previous?: string } | Exclude<Resolution, { ok: true }> | { ok: false; reason: 'conflict' | 'missing'; message: string } | NotInitialized;

const NOT_ENROLLED_NOTE = 'not enrolled: no admin key is pinned on this machine; pin the admin key (`machine admin pin <admin.json>`) and import peers (`machine peer import <bundle.json>`)';

function selfOf(configDir: string): MachineIdentity | NotInitialized {
  try {
    return readMachine(configDir);
  } catch (e) {
    if (e instanceof NotInitializedError) return { initialized: false, message: e.message };
    throw e;
  }
}

function payloadOf(payload: unknown): Record<string, unknown> {
  return typeof payload === 'object' && payload !== null ? (payload as Record<string, unknown>) : {};
}

function stringField(payload: unknown, field: string): string {
  const value = payloadOf(payload)[field];
  if (typeof value !== 'string') throw new Error(`missing "${field}" in the request`);
  return value;
}

const epochSeconds = () => Math.floor(Date.now() / 1000);

/** `version` is read only by `status`: a failure to determine it must not break the other commands. */
export function makeCommands(configDir: string, version: string | (() => string), now: () => number = epochSeconds, holds?: HoldTable, reachability?: ReachabilityProbe) {
  const everyone = (self: MachineIdentity): MachineEntry[] => [{ uuid: self.uuid, name: self.name }, ...loadNetwork(configDir, now()).directory.machines()];
  return {
    status(): StatusAnswer | NotInitialized {
      const self = selfOf(configDir);
      if ('initialized' in self) return self;
      const network = loadNetwork(configDir, now());
      // A revoked registration is listed in `revoked` (with its uuid and date), not as a problem of the network.
      const problems = network.problems.filter((p) => !/: registration revoked \(/.test(p));
      let revocation: Pick<StatusAnswer, 'revocationVersion' | 'peersBehind'> = {};
      if (network.enrolled) {
        try {
          const own = revocationState(configDir);
          const seen = readRevocationSeen(configDir, (warning) => problems.push(warning));
          const behind = network.directory.machines().flatMap((m) => {
            const s = seen[m.uuid];
            return s !== undefined && s.digest !== own.digest ? [{ uuid: m.uuid, name: m.name, revocationVersionSeen: s.version }] : [];
          });
          revocation = { revocationVersion: own.version, peersBehind: behind };
        } catch (e) {
          problems.push(`revocation catch-up state unavailable: ${(e as Error).message}`);
        }
      }
      let revoked: RevokedMachine[] = [];
      if (network.enrolled) {
        try {
          revoked = revokedMachines(configDir);
        } catch (e) {
          problems.push(`the revoked machines are not listed: ${(e as Error).message}`);
        }
      }
      return {
        initialized: true,
        uuid: self.uuid,
        name: self.name,
        version: typeof version === 'string' ? version : version(),
        enrolled: network.enrolled,
        peers: network.directory.machines().length,
        ...(network.policy ? { policyVersion: network.policy.version } : {}),
        policyMode: network.policyMode,
        ...(network.localPolicyKeyId !== undefined ? { localPolicyKeyId: network.localPolicyKeyId } : {}),
        ...revocation,
        ...(revoked.length > 0 ? { revoked } : {}),
        problems,
        configDir,
        ...(network.enrolled ? {} : { note: NOT_ENROLLED_NOTE }),
      };
    },

    list(): ListAnswer | NotInitialized {
      const self = selfOf(configDir);
      if ('initialized' in self) return self;
      const network = loadNetwork(configDir, now());
      const aliases = readAliases(configDir);
      let revocationWarning: string | undefined;
      const seen = readRevocationSeen(configDir, (warning) => (revocationWarning = `the revocation versions are not shown: ${warning}`));
      return {
        initialized: true,
        self: { uuid: self.uuid, name: self.name, aliases: Object.entries(aliases).filter(([, uuid]) => uuid === self.uuid).map(([alias]) => alias) },
        peers: network.directory.machines().map((p) => ({
          ...p,
          aliases: Object.entries(aliases).filter(([, uuid]) => uuid === p.uuid).map(([alias]) => alias),
          ...(seen[p.uuid] ? { revocationVersionSeen: seen[p.uuid]?.version as number, revocationSeenAt: seen[p.uuid]?.at as number } : {}),
        })),
        ...(revocationWarning ? { revocationWarning } : {}),
        enrolled: network.enrolled,
        policyMode: network.policyMode,
        ...(network.enrolled ? {} : { note: NOT_ENROLLED_NOTE }),
      };
    },

    /** The Machines page: who receives request notices and which machine holds the list (request-notices.md). Local files only, read-only. */
    noticeHolders(): NoticeHoldersAnswer | NotInitialized {
      const self = selfOf(configDir);
      if ('initialized' in self) {
        return self;
      }
      return noticeHolders(configDir, now());
    },

    /**
     * Can this machine reach each trusted peer DIRECTLY now (decision 86)? In the daemon: the answer of the background probe, from memory, at once (asking
     * starts the probing for a while). In-process (no daemon): one probe of every peer, a few seconds at most. Never starts a wake, sends nothing.
     */
    async reachability(): Promise<ReachabilityAnswer | NotInitialized> {
      const self = selfOf(configDir);
      if ('initialized' in self) return self;
      if (reachability !== undefined) return answerOf(reachability.ask(), now());
      return await reachabilityOnce(configDir, now);
    },

    /**
     * After an Allow (decision 86): is the request still held, or how did the hold end? For this machine from the hold table and the outcomes kept here, for
     * another machine from the notices it sent. `unknown` is never a success. Read-only.
     */
    holdProgress(payload?: unknown): HoldProgressAnswer {
      return holdProgressCommand(configDir, payload, now(), holds);
    },

    /** The Requests page of the module (decision 73): the pending list and the last history entries of this machine's audit log. Read-only. */
    requests(): RequestsAnswer {
      return requestsAnswer(configDir, {}, now());
    },

    /** The Activity page (run-log.md): the commands this machine sent and received, filtered and paginated. Read-only. */ // run-log
    activity(payload?: unknown): ActivityAnswer { // run-log
      return activityFromPayload(configDir, payload, now()); // run-log
    }, // run-log

    /** The Allowed page: what every machine allows (the policy installed here, the policies signed here), the data of `machine allowed`. Read-only. */
    allowed(): AllowedAnswer {
      return allowedAnswer(configDir, now());
    },

    /** The Requests page, remote section (decision 74): forwards a request signed in the browser with the admin key to a peer. Read-only; signs nothing. */
    remoteRequests(payload?: unknown): Promise<RemoteRequestsAnswer> {
      return remoteRequestsCommand(configDir, payload, now());
    },

    /**
     * The Deny of a request held on ANOTHER machine (decision 85): sends `request-deny` to that machine over the authenticated channel. Restricting
     * only, no signature; the target accepts it only from a machine of its notice-recipients list.
     */
    denyRemote(payload?: unknown): Promise<DenyOnPeerResult & { peer?: { uuid: string; name: string } }> {
      return denyRemoteCommand(configDir, payload, now());
    },

    /**
     * The Allow button of the Requests page (decision 76). The page unlocks the admin key and signs IN THE BROWSER; the daemon only serves the
     * ENCRYPTED key file, answers what the page needs before it asks the passphrase, and verifies and delivers the signed result. It never
     * receives a passphrase or an unlocked key and signs nothing.
     */
    adminKeyFile(): ReturnType<typeof adminKeyText> {
      return adminKeyText(configDir);
    },

    allowContext(payload?: unknown): ReturnType<typeof allowContext> {
      return allowContext(configDir, payload, now());
    },

    submitPolicy(payload?: unknown): Promise<SubmitAnswer> {
      // Direct delivery first (decision 86): the target takes the signed document over the peer channel; the relay inbox only when it cannot.
      return submitPolicy(configDir, payload, now(), { direct: directDeliveryFor(configDir, { now }) });
    },

    /**
     * Approve from the page (admin-ui.md). The page builds and signs the approval IN THE BROWSER; the daemon of the machine that holds the admin key serves
     * what the page needs before the passphrase (`approveContext`) and, once the page signed, verifies and imports the candidate (`importCandidate`). No
     * passphrase or unlocked key ever reaches it, and it signs nothing.
     */
    approveContext(payload?: unknown): ReturnType<typeof approveContext> {
      return approveContext(configDir, payload, now());
    },

    importCandidate(payload?: unknown): Promise<ImportCandidateAnswer> {
      return importCandidate(configDir, payload, now());
    },

    /**
     * Approve from the page, lot 5: after the approval, delivers the peer documents and the list of notice recipients the page signed, so the other peers learn the
     * new machine. Verified against the pinned admin key and the ids derived here, then sent by the code of `machine admin distribute` (direct first, relay inbox
     * as fallback). Signs nothing; a failure never undoes the approval and names the retry command.
     */
    approveDistribute(payload?: unknown): Promise<ApproveDistributeAnswer> {
      return approveDistribute(configDir, payload, now(), { direct: directDeliveryFor(configDir, { now }) });
    },

    /**
     * Revoke from the page (admin-ui.md). `revokeContext` serves what the page needs before the passphrase; `revokeApply` verifies the revocation list and the documents the
     * page signed IN THE BROWSER against the pinned admin key, installs the list here, then tells the peers like `machine admin revoke` (direct first, relay inbox as
     * fallback) and removes the revoked machine from the relay. No passphrase or unlocked key reaches it, and it signs nothing; a failed delivery never undoes the revocation.
     */
    revokeContext(payload?: unknown): ReturnType<typeof revokeContext> {
      return revokeContext(configDir, payload, now());
    },

    revokeApply(payload?: unknown): Promise<RevokeApplyAnswer> {
      return revokeApply(configDir, payload, now(), { direct: directDeliveryFor(configDir, { now }) });
    },

    /**
     * The Deny of a request that a peer's `run --wait` holds (hold-for-approval.md): restricting, so it needs no signature (hard rule 4, only
     * restricting actions). Only the daemon holds requests: run in-process (no daemon) it says so instead of pretending.
     */
    deny(payload?: unknown): DenyAnswer {
      const id = stringField(payload, 'id');
      const rawReason = payloadOf(payload)['reason'];
      if (rawReason !== undefined && typeof rawReason !== 'string') {
        throw new Error('"reason" in the request must be text');
      }
      if (holds === undefined) {
        return { ok: false, reason: 'no-daemon', message: 'the machine daemon is not running, so no request is held: start it with `machine startup enable` (at login) or `machine daemon`' };
      }
      const denied = holds.deny(id, rawReason);
      if (!denied.ok) {
        return denied;
      }
      const { hold } = denied;
      return { ok: true, id: hold.id, peer: hold.peer, shell: hold.shell, command: hold.command };
    },

    /**
     * The Dismiss and Clear expired buttons of the Requests page (decision 100): a refused notice, or a held one past its deadline, leaves notices.json. Only
     * a display row goes: restricting and local, no signature, nothing is sent to the target, the audit log is never touched. Payload: `{ machine, id }` or `{ expired: true }`.
     */
    dismissNotice(payload?: unknown): DismissAnswer {
      const p = payloadOf(payload);
      const expected = 'expected {"machine": "<uuid of the machine that reported it>", "id": "<request id>"} or {"expired": true}';
      const extra = Object.keys(p).find((k) => k !== 'machine' && k !== 'id' && k !== 'expired');
      if (extra !== undefined) {
        throw new Error(`the field "${extra}" is not accepted by dismissNotice: ${expected}`);
      }
      if (p['expired'] !== undefined) {
        if (p['expired'] !== true || p['machine'] !== undefined || p['id'] !== undefined) {
          throw new Error(`"expired" must be true and alone: ${expected}`);
        }
        return dismissStoredNotices(configDir, { expired: true }, now());
      }
      const machine = p['machine'];
      const id = p['id'];
      if (typeof machine !== 'string' || !isUuid(machine)) {
        throw new Error(`"machine" must be the uuid of the machine that reported the notice: ${expected}`);
      }
      if (typeof id !== 'string' || !isUuid(id)) {
        throw new Error(`"id" must be the request id (a UUID): ${expected}`);
      }
      return dismissStoredNotices(configDir, { machine, id }, now());
    },

    resolve(payload?: unknown): ResolveAnswer {
      const self = selfOf(configDir);
      if ('initialized' in self) return self;
      const machines = everyone(self);
      const result = resolveMachineRef(stringField(payload, 'ref'), machines, readAliases(configDir));
      if (!result.ok) return result;
      const machine = machines.find((m) => m.uuid === result.uuid);
      return { ...result, ...(machine ? { name: machine.name } : {}) };
    },

    aliasList(): Record<string, string> {
      return readAliases(configDir);
    },

    aliasSet(payload?: unknown): AliasAnswer {
      const self = selfOf(configDir);
      if ('initialized' in self) return self;
      const alias = stringField(payload, 'alias');
      const machines = everyone(self);
      // The target is resolved WITHOUT aliases: an alias always points to a machine, never to another alias.
      const target = resolveMachineRef(stringField(payload, 'ref'), machines, {});
      if (!target.ok) return target;
      const shadowed = machines.find((m) => m.name.toLowerCase() === alias.toLowerCase() && m.uuid !== target.uuid);
      if (shadowed) {
        return {
          ok: false,
          reason: 'conflict',
          message: `the machine named "${shadowed.name}" (${shadowed.uuid.slice(0, 8)}) would be shadowed by this alias, which would silently redirect commands meant for it: choose another alias`,
        };
      }
      try {
        const { previous } = setAlias(configDir, alias, target.uuid, { replace: payloadOf(payload).replace === true });
        return { ok: true, alias, uuid: target.uuid, ...(previous ? { previous } : {}) };
      } catch (e) {
        if (e instanceof AliasConflictError) return { ok: false, reason: 'conflict', message: e.message };
        throw e;
      }
    },

    aliasRemove(payload?: unknown): { ok: true } | { ok: false; reason: 'missing'; message: string } {
      try {
        removeAlias(configDir, stringField(payload, 'alias'));
        return { ok: true };
      } catch (e) {
        if (e instanceof NoSuchAliasError) return { ok: false, reason: 'missing', message: e.message };
        throw e;
      }
    },
  };
}

export type MachineCommands = ReturnType<typeof makeCommands>;
