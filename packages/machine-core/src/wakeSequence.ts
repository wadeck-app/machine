import { isWakeableFailure, type ConnectFailureKind, type WakeMethod, type WakeStep } from './wake.js';

// The wait/retry sequence of a wake (decision 62): send a packet at each step, probe the connection in between (about one attempt per
// `attemptIntervalMs`), stop at the answer, at the deadline or at a failure that waking cannot cure. A refused connection (the host is awake, no daemon
// listens yet) stops the packets but not the probes: a daemon can start a few seconds after a resume. Pure: the clock, the socket and the
// connection are injected. The only feedback a magic packet ever gives is the connection becoming possible.

export interface SentStep extends WakeStep {
  /** 1-based number of the packet, over all methods. */
  n: number;
}

export type WakeEvent =
  /** Packet `n` of `total` was just sent, `elapsedMs` after the first failure. */
  { type: 'packet'; n: number; total: number; method: WakeMethod; elapsedMs: number };

export interface WakeSequenceDeps<T> {
  nowMs: () => number;
  sleep: (ms: number) => Promise<void>;
  /** One authenticated connection attempt (it carries its own, short, limit per address). Throws when it fails. */
  connect: () => Promise<T>;
  /** The typed failure kinds of what `connect` threw (one per address tried). Anything unclassified must be `unknown`. */
  kindsOf: (error: unknown) => ConnectFailureKind[];
  /** Sends one packet by the step's method to every allowed route. Throws when nothing could be sent. */
  send: (step: SentStep, total: number) => Promise<void>;
  /** Learns the address again (the relay record: after a resume the address may have changed). It must not throw. */
  refresh?: () => Promise<void>;
  say: (event: WakeEvent) => void;
}

export interface WakeSequenceOptions {
  /** Total budget. */
  waitMs: number;
  /** The packets to send, in order (`planWakeSteps`). Empty during a cooldown: connection retries only. */
  steps: readonly WakeStep[];
  /** A failed attempt is followed by a pause so that attempts start about this far apart. */
  attemptIntervalMs: number;
  refreshEveryMs: number;
  /**
   * Packet 1 (`steps[0]`) was already sent by the caller (hedged first packet, decision 97) at `atMs` on the `nowMs` clock. The sequence counts it,
   * does not send it again, and measures its probe windows and its budget from that instant instead of from the call.
   */
  firstSent?: { atMs: number };
}

export type WakeOutcome<T> =
  /** `awakeAtMs`: when a probe was first refused (the host was awake, no daemon listened yet); absent when no probe was refused. */
  | { outcome: 'answered'; value: T; packets: number; elapsedMs: number; lastStep: SentStep | undefined; awakeAtMs?: number }
  | { outcome: 'no-answer'; packets: number; elapsedMs: number; lastError: unknown }
  /** Probes were refused until the budget was used: the host is awake and no daemon listens. */
  | { outcome: 'refused'; packets: number; elapsedMs: number; awakeAtMs: number; lastError: unknown }
  /** A retry failed for a reason waking cannot cure (authentication, pin, protocol): the peer is up or something else is wrong. */
  | { outcome: 'aborted'; error: unknown; kinds: ConnectFailureKind[]; packets: number; elapsedMs: number }
  | { outcome: 'send-failed'; error: Error; packets: number; elapsedMs: number };

export async function runWakeSequence<T>(deps: WakeSequenceDeps<T>, options: WakeSequenceOptions): Promise<WakeOutcome<T>> {
  const start = options.firstSent?.atMs ?? deps.nowMs();
  const total = options.steps.length;
  if (options.firstSent !== undefined && options.steps.length === 0) throw new Error('firstSent needs at least one planned step: packet 1 cannot have been sent from an empty plan');
  let sent = options.firstSent !== undefined ? 1 : 0;
  let lastStep: SentStep | undefined = options.firstSent !== undefined ? { ...(options.steps[0] as WakeStep), n: 1 } : undefined;
  let lastRefresh = start;
  let lastError: unknown;
  // Set at the first refused probe: from then on no packet is sent (the host is awake), the probes go on.
  let awakeAtMs: number | undefined;
  for (;;) {
    let elapsed = deps.nowMs() - start;
    if (elapsed >= options.waitMs) return awakeAtMs !== undefined ? { outcome: 'refused', packets: sent, elapsedMs: elapsed, awakeAtMs, lastError } : { outcome: 'no-answer', packets: sent, elapsedMs: elapsed, lastError };
    while (awakeAtMs === undefined && sent < total && elapsed >= (options.steps[sent] as WakeStep).atMs) {
      const step: SentStep = { ...(options.steps[sent] as WakeStep), n: sent + 1 };
      try {
        await deps.send(step, total);
      } catch (e) {
        return { outcome: 'send-failed', error: e instanceof Error ? e : new Error(String(e)), packets: sent, elapsedMs: elapsed };
      }
      sent++;
      lastStep = step;
      deps.say({ type: 'packet', n: step.n, total, method: step.method, elapsedMs: elapsed });
      elapsed = deps.nowMs() - start;
    }
    if (deps.refresh !== undefined && deps.nowMs() - lastRefresh >= options.refreshEveryMs) {
      lastRefresh = deps.nowMs();
      await deps.refresh();
    }
    const attemptStart = deps.nowMs();
    try {
      const value = await deps.connect();
      return { outcome: 'answered', value, packets: sent, elapsedMs: deps.nowMs() - start, lastStep, ...(awakeAtMs !== undefined ? { awakeAtMs } : {}) };
    } catch (e) {
      const kinds = deps.kindsOf(e);
      // Refused, with nothing worse next to it (unreachable and timeout are what a sleeping host gives): the host is awake and has no daemon yet.
      const refusedOnly = kinds.includes('refused') && kinds.every((k) => k === 'refused' || k === 'unreachable' || k === 'timeout');
      if (refusedOnly) awakeAtMs ??= deps.nowMs() - start;
      if (!refusedOnly && !isWakeableFailure(kinds)) return { outcome: 'aborted', error: e, kinds, packets: sent, elapsedMs: deps.nowMs() - start };
      lastError = e;
    }
    const now = deps.nowMs();
    elapsed = now - start;
    const nextPacket = awakeAtMs === undefined && sent < total ? (options.steps[sent] as WakeStep).atMs : Number.POSITIVE_INFINITY;
    const pause = Math.min(Math.max(0, options.attemptIntervalMs - (now - attemptStart)), Math.max(0, nextPacket - elapsed), Math.max(0, options.waitMs - elapsed));
    if (pause > 0) await deps.sleep(pause);
    // A pause of 0 means a packet is due or the budget is used: the loop sends it or stops. An attempt that took longer than the interval goes straight on.
  }
}
