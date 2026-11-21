import { relativeText } from './humanTime.js';

// The `no-policy` situation (decision 70): a machine that has no policy YET is usually a machine whose policy is still in the relay inbox.
// Pure functions: the words of the refusal on both sides, and the cadence at which the daemon reads its inbox while it waits for a policy.

/** Normal cadence of the daemon (heartbeat, and the inbox read when the relay says documents wait). */
export const NORMAL_POLL_MS = 60_000;
/**
 * Cadence while this machine has NO policy: one heartbeat (+ one inbox read when documents wait) every 10 s, i.e. at most 6 heartbeats per
 * minute per machine. The relay documents no limit on the machines routes (the per-token mutation limit of routes.js does not cover them).
 */
export const FAST_POLL_MS = 10_000;
/** The fast cadence is bounded: from the start of the daemon, at most this long. After it, the normal cadence (a machine left without policy does not poll fast for ever). */
export const FAST_POLL_WINDOW_MS = 300_000;
/** Cadence while this machine HOLDS a request for approval (hold-for-approval.md): an Allow sent by the admin is installed within about 5 s. No time window: it lasts as long as a hold does (a hold has its own deadline). */
export const HOLD_POLL_MS = 5_000;
export const MAX_BACKOFF_MS = 600_000;
/** A policy signed here more recently than this and not installed yet is "in transit"; an older one is not explained by the relay delay. */
export const PENDING_NOTE_MAX_AGE_SECONDS = 900;

/** The refusal sent by the TARGET when it has no policy. It knows its own name and its mode (decision 68). */
export function noPolicyMessage(mode: 'admin' | 'local', selfName: string): string {
  if (mode === 'local') {
    return 'no policy is installed on this machine yet: it manages its own allow list (policy mode local) and every command is refused until its owner allows one. Run `machine policy allow -- <command>` on this machine';
  }
  return `no policy is installed on this machine yet. If the admin just ran \`machine admin allow ${selfName}\`, the policy arrives directly when this machine is reachable, or through the relay inbox (next poll within 60 s, or 5 s while it holds a request): retry shortly. Otherwise run \`machine admin allow ${selfName} -- <command>\` on the admin machine`;
}

export interface PendingPolicyInput {
  /** The reason of the refusal received from the target. */
  reason: string;
  machine: string;
  /** The policy recorded here for that machine (written by `admin allow` / `admin sign-policy`). */
  version: number;
  issuedAt: number;
  now: number;
  /** For `not-listed`: does the recorded policy allow this command? */
  recordAllowsCommand?: boolean;
}

/**
 * The line the CALLER adds to a refusal when its own record shows a policy signed recently that the target may not have received yet.
 * The target does not say which version it holds, so the line is only shown where it explains the refusal: `no-policy`, or `not-listed`
 * for a command the recorded policy does allow.
 */
export function pendingPolicyNote(i: PendingPolicyInput): string | undefined {
  const explains = i.reason === 'no-policy' || (i.reason === 'not-listed' && i.recordAllowsCommand === true);
  if (!explains) return undefined;
  const age = i.now - i.issuedAt;
  if (age < 0 || age > PENDING_NOTE_MAX_AGE_SECONDS) return undefined;
  const when = relativeText(i.issuedAt, i.now);
  const retry = Math.max(10, Math.round(NORMAL_POLL_MS / 1000) - age);
  return `a policy (version ${i.version}) for ${i.machine} was signed here ${when === 'now' ? 'just now' : when} and sent through the relay: it is not installed yet; retry in about ${retry} s`;
}

export interface PollDelayInput {
  /** The normal cadence (the heartbeat). */
  normalMs: number;
  failures: number;
  /** This machine has no policy (or a pending one it cannot install yet). */
  needsPolicy: boolean;
  /** Time since the daemon started (the window of the fast cadence). */
  elapsedMs: number;
  /** At least one request is held on this machine, waiting for an Allow. */
  holdActive?: boolean;
}

/** Delay before the next round. A failing relay always backs off (doubling, capped), whatever is needed. */
export function pollDelayMs(i: PollDelayInput): number {
  if (i.failures > 0) return Math.min(i.normalMs * 2 ** i.failures, MAX_BACKOFF_MS);
  if (i.holdActive === true) {
    return Math.min(HOLD_POLL_MS, i.normalMs);
  }
  if (i.needsPolicy && i.elapsedMs < FAST_POLL_WINDOW_MS) return Math.min(FAST_POLL_MS, i.normalMs);
  return i.normalMs;
}
