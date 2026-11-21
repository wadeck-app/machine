import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { authorize, isUuid, resolveMachineRef, summarizeRequests, type HistoryKind, type PolicyBody, type PolicyMode, type RequestsSummary } from '@wadeck-app/machine-core';
import { adminKeyFile, readAdminPin } from './admin.js';
import type { RequestsListDeps } from './peerService.js';
import { NotInitializedError } from './errors.js';
import { readMachine } from './identity.js';
import { loadNetwork } from './network.js';
import { readAliases } from './state.js';

// `machine requests` and the Requests page of the module: the audit log of THIS machine, read and summarized (the reader is
// machine-core's summarizeRequests). Read-only: nothing is written, no daemon is needed, nothing is sent to a peer.

export const auditLogFile = (configDir: string): string => join(configDir, 'audit.log');

export interface RequestsQuery {
  /** Machine reference (name, alias, uuid or unique prefix) whose history is wanted. */
  peer?: string;
  /** Epoch seconds. */
  since?: number;
  kinds?: HistoryKind[];
  limit?: number;
  pendingLimit?: number;
}

export interface RequestsView {
  initialized: true;
  ok: true;
  self: { uuid: string; name: string };
  policyMode: PolicyMode;
  /** The admin key of this network is on this machine (its file exists): `machine admin allow` can be run here. */
  adminKeyHere: boolean;
  logFile: string;
  /** False: no request ever reached this machine (the log is created by the first one). */
  logPresent: boolean;
  /** Epoch seconds of the answer, so that a reader humanizes ages against the same clock. */
  now: number;
  summary: RequestsSummary;
  /** What was left out of the network and why (as `machine status`): a missing policy or name here explains a surprise. */
  problems: string[];
}

export type RequestsAnswer = { initialized: false; message: string } | { initialized: true; ok: false; message: string } | RequestsView;

/**
 * Is the command on the list that applies to this peer (its own list, else the defaults)? A listed command that is expired or exhausted
 * counts as listed: renewing it is not a new request. No policy: nothing is listed.
 */
export function isListed(policy: PolicyBody | undefined, peer: string, shell: string, command: string, now: number, mode: PolicyMode): boolean {
  if (policy === undefined) return false;
  // Runs on the target: the platform decides the reserved device names, exactly as when the command arrives.
  const decision = authorize(policy, peer, { shell: shell as never, command }, now, () => 0, mode, undefined, process.platform === 'win32' ? 'windows' : 'posix');
  return decision.allowed || (decision.reason !== 'not-listed' && decision.reason !== 'invalid-request');
}

export function requestsAnswer(configDir: string, query: RequestsQuery, now: number): RequestsAnswer {
  let self;
  try {
    self = readMachine(configDir);
  } catch (e) {
    if (e instanceof NotInitializedError) return { initialized: false, message: e.message };
    throw e;
  }
  const network = loadNetwork(configDir, now);
  const machines = network.directory.machines();
  const names = new Map(machines.map((m) => [m.uuid, m.name]));

  let peer: string | undefined;
  if (query.peer !== undefined) {
    const resolved = resolveMachineRef(query.peer, [{ uuid: self.uuid, name: self.name }, ...machines], readAliases(configDir));
    if (resolved.ok) peer = resolved.uuid;
    // A machine that is not trusted any more (revoked, removed) still has entries in the log: its full uuid is accepted.
    else if (isUuid(query.peer.toLowerCase())) peer = query.peer.toLowerCase();
    else return { initialized: true, ok: false, message: `${resolved.message}; \`machine list\` shows the machines this machine knows (a machine that is no longer trusted can be given by its full uuid)` };
  }

  const file = auditLogFile(configDir);
  const logPresent = existsSync(file);
  let lines: string[] = [];
  if (logPresent) {
    const text = readFileSync(file, 'utf8');
    lines = text.length === 0 ? [] : text.replace(/\n$/, '').split('\n');
  }

  const summary = summarizeRequests(lines, {
    isAllowed: (source, shell, command) => isListed(network.policy, source, shell, command, now, network.policyMode),
    nameOf: (uuid) => names.get(uuid),
    ...(query.pendingLimit !== undefined ? { pendingLimit: query.pendingLimit } : {}),
    history: {
      ...(peer !== undefined ? { peer } : {}),
      ...(query.since !== undefined ? { since: query.since } : {}),
      ...(query.kinds !== undefined ? { kinds: query.kinds } : {}),
      ...(query.limit !== undefined ? { limit: query.limit } : {}),
    },
  });
  return {
    initialized: true,
    ok: true,
    self: { uuid: self.uuid, name: self.name },
    policyMode: network.policyMode,
    adminKeyHere: existsSync(adminKeyFile(configDir)),
    logFile: file,
    logPresent,
    now,
    summary,
    problems: network.problems,
  };
}

/** The two readers the peer service needs for `requests-list` (decision 74): the pinned admin key and the pending groups of this machine's log. */
export function makeRequestsListDeps(configDir: string, now: () => number, log: (line: string) => void): RequestsListDeps {
  return {
    adminPublicKey: () => {
      try {
        return readAdminPin(configDir).adminPublicKey;
      } catch (e) {
        // Nobody may list the requests of a machine that does not know its admin: said in the daemon log, answered as `no-admin`.
        log(`requests-list: ${(e as Error).message}`);
        return undefined;
      }
    },
    list: (limit) => {
      const answer = requestsAnswer(configDir, { pendingLimit: limit }, now());
      if (!answer.initialized || !answer.ok) throw new Error(`cannot list the requests: ${answer.message}`);
      const { summary } = answer;
      return {
        machine: answer.self,
        policyMode: answer.policyMode,
        chain: summary.chain.ok ? { ok: true } : { ok: false, line: summary.chain.line },
        pendingTotal: summary.pendingTotal,
        allowedNow: summary.allowedNow,
        pending: summary.pending,
      };
    },
  };
}
