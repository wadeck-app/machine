import type { AllowResult } from './allowFlow.js';
import { deliverySummary, type DeliverySummary } from './deliverySummary.js';

// The progress after "Allow and sign" (decision 86), without React. Every step is driven by a REAL event, never by the clock:
//   1. Signed                 the signature is made in this page.
//   2. Delivered directly / Stored on the relay / Installed here     the answer of the daemon about the delivery (what path was used and why).
//   3. <machine> installs the policy     done at once when the target acknowledged the installation (direct delivery), else waiting.
//   4. The held command is released     only when the target reports the end of the hold (`request-notice-end`, or the local hold of this machine).
// Nothing here shows a success without the end of the hold of a request somebody waits for: after 3 minutes without it the page says so honestly.

/** The daemon is asked every 2 s while a step is pending, and no more than this long. */
export const HOLD_POLL_MS = 2000;
export const HOLD_TIMEOUT_MS = 3 * 60_000;

export type StepState = 'done' | 'active' | 'pending' | 'failed' | 'skipped';

export interface ProgressStep {
  id: 'signed' | 'delivered' | 'installs' | 'released';
  label: string;
  /** One word for the thin stepper under the card: Signed, Delivered (Stored in the relay), Installed, Released. */
  short: string;
  state: StepState;
  /** What the person needs to read next to the step (the path and its cause, the wait, the failure). */
  detail?: string;
}

export type HoldPollAnswer =
  | { state: 'held' }
  | { state: 'unknown' }
  | {
      state: 'ended';
      outcome: 'allowed' | 'denied' | 'deadline' | 'disconnected' | 'refused' | 'revoked';
      /** The target released the request but its daemon refused to run it (`cannot-run`): the refusal and its fix. Known for a hold of this machine only. */
      reason?: string;
      message?: string;
    };

export interface ProgressRecord {
  machineName: string;
  /** A caller waits for the request (steps 3 and 4 follow the hold); false: the request was only listed as refused, nobody waits. */
  held: boolean;
  /** Epoch milliseconds of the click on "Allow and sign". */
  startedAt: number;
  signed: boolean;
  result?: AllowResult;
  /** The post failed: the message of whoever refused. */
  failed?: string;
  hold?: HoldPollAnswer;
  timedOut: boolean;
  /** The last problem asking the daemon; the polling goes on. */
  pollError?: string;
  /** Epoch milliseconds at which nothing more can happen (the hold ended, the post failed, the wait timed out): the elapsed time stops here. */
  finishedAt?: number;
}

export type ProgressEvent =
  | { type: 'signed' }
  | { type: 'result'; result: AllowResult }
  | { type: 'failed'; message: string }
  | { type: 'hold'; answer: HoldPollAnswer }
  | { type: 'timeout' }
  | { type: 'poll-error'; message: string };

export function initialProgress(input: { machineName: string; held: boolean; now: number }): ProgressRecord {
  return { machineName: input.machineName, held: input.held, startedAt: input.now, signed: false, timedOut: false };
}

export const noConfirmationMessage = (machine: string): string => `no confirmation from ${machine}: it may be offline, or it runs an older build: check machine requests ${machine}`;

export function reduceProgress(record: ProgressRecord, event: ProgressEvent, now: number): ProgressRecord {
  switch (event.type) {
    case 'signed':
      return { ...record, signed: true };
    case 'result':
      // Nobody waits for the request: nothing more can be observed from here.
      return { ...record, result: event.result, ...(record.held ? {} : { finishedAt: now }) };
    case 'failed':
      return { ...record, failed: event.message, finishedAt: now };
    case 'hold':
      return { ...record, hold: event.answer, ...(event.answer.state === 'ended' ? { finishedAt: now } : {}) };
    case 'timeout':
      return { ...record, timedOut: true, finishedAt: now };
    case 'poll-error':
      return { ...record, pollError: event.message };
  }
}

const OUTCOME_TEXT: Record<string, string> = {
  denied: 'denied: nothing ran',
  deadline: 'the deadline of the caller passed: nothing ran',
  disconnected: 'the caller disconnected: nothing ran',
  refused: 'the target refused it after all: nothing ran',
  revoked: 'the caller was revoked on the target: nothing ran',
};

/** The steps as they stand now. */
export function stepsOf(record: ProgressRecord, _now: number): ProgressStep[] {
  const name = record.machineName;
  const { result, failed } = record;
  const ended = record.hold?.state === 'ended' ? record.hold : undefined;
  const steps: ProgressStep[] = [];

  steps.push({ id: 'signed', short: 'Signed', label: record.signed ? 'Signed' : 'Signing', state: record.signed ? 'done' : failed !== undefined ? 'failed' : 'active', ...(!record.signed && failed !== undefined ? { detail: failed } : {}) });

  // Step 2: the delivery.
  if (result !== undefined) {
    const label = result.delivery === 'direct' ? `Delivered directly to ${name}` : result.delivery === 'inbox' ? 'Stored on the relay' : (result.deliveryText?.text ?? `Installed on ${name}`);
    // The cause of a fallback is NOT copied here: the card says it once (deliverySummary), the long sentence is in the details.
    steps.push({ id: 'delivered', short: result.delivery === 'inbox' ? 'Stored' : 'Delivered', label, state: 'done' });
  } else if (failed !== undefined && record.signed) {
    steps.push({ id: 'delivered', short: 'Delivered', label: 'Delivering', state: 'failed', detail: failed });
  } else {
    steps.push({ id: 'delivered', short: 'Delivered', label: 'Delivering', state: record.signed ? 'active' : 'pending' });
  }

  // Step 3: the target installs the policy.
  const acknowledged = result !== undefined && (result.delivery === 'direct' || result.delivery === 'installed');
  const impliedByEnd = ended?.outcome === 'allowed';
  if (acknowledged || impliedByEnd) {
    steps.push({ id: 'installs', short: 'Installed', label: `${name} installed the policy`, state: 'done' });
  } else if (result !== undefined && result.delivery === 'inbox') {
    if (ended !== undefined) {
      steps.push({ id: 'installs', short: 'Installed', label: `${name} installs the policy`, state: 'skipped', detail: 'not confirmed: the request ended first' });
    } else if (record.timedOut) {
      steps.push({ id: 'installs', short: 'Installed', label: `${name} installs the policy`, state: 'failed', detail: 'not confirmed' });
    } else {
      steps.push({ id: 'installs', short: 'Installed', label: `${name} installs the policy`, state: 'active', detail: 'at its next inbox poll (within 60 s, or 5 s while it holds a request)' });
    }
  } else {
    steps.push({ id: 'installs', short: 'Installed', label: `${name} installs the policy`, state: 'pending' });
  }

  // Step 4: the end of the hold, only for a request somebody waits for.
  if (record.held) {
    if (ended?.outcome === 'allowed') {
      steps.push({ id: 'released', short: 'Released', label: 'The held command was released', state: 'done' });
    } else if (ended !== undefined) {
      const cause = ended.reason !== undefined && ended.message !== undefined ? `the target allowed it but could not run it, ${ended.reason}: ${ended.message}` : undefined;
      steps.push({ id: 'released', short: 'Released', label: 'The held command was not released', state: 'failed', detail: cause ?? OUTCOME_TEXT[ended.outcome] ?? `the request ended: ${ended.outcome}` });
    } else if (record.timedOut) {
      steps.push({ id: 'released', short: 'Released', label: 'The held command was not confirmed', state: 'failed', detail: noConfirmationMessage(name) });
    } else if (steps[2]?.state === 'done') {
      steps.push({ id: 'released', short: 'Released', label: 'Waiting for the held command to be released', state: 'active' });
    } else {
      steps.push({ id: 'released', short: 'Released', label: 'The held command is released', state: 'pending' });
    }
  }
  return steps;
}

/** Determinate progress: the share of the steps that are done. */
export function percentOf(record: ProgressRecord): number {
  const steps = stepsOf(record, 0);
  return Math.round((steps.filter((s) => s.state === 'done').length / steps.length) * 100);
}

export interface ProgressSummary {
  /** active: it goes on; success: released (or installed when nobody waits); danger: it ended without the result the person wanted. */
  tone: 'active' | 'success' | 'danger';
  /** The outcome in one short line: it goes next to the command and the machine. */
  text: string;
  /** Why, in a smaller line (the failure message, the actionable message of a timeout). Never repeated in the details. */
  cause?: string;
  /** How the delivery went, once the daemon answered. */
  delivery?: DeliverySummary;
  finished: boolean;
  succeeded: boolean;
  /** The signature or the post failed: nothing was installed and the request is still held, so Allow can be tried again. */
  retryable: boolean;
}

const ACTIVE_TEXT: Record<ProgressStep['id'], string> = {
  signed: 'Signing',
  delivered: 'Delivering',
  installs: 'Waiting for the install',
  released: 'Waiting for the release',
};

/** What the one-line row of a request says, from the same steps as the stepper. */
export function summaryOf(record: ProgressRecord, now: number): ProgressSummary {
  const steps = stepsOf(record, now);
  const delivery = record.result !== undefined ? deliverySummary(record.result) : undefined;
  const base = { ...(delivery !== undefined ? { delivery } : {}), finished: record.finishedAt !== undefined };
  if (record.timedOut) {
    return { ...base, tone: 'danger', text: 'Not confirmed', cause: noConfirmationMessage(record.machineName), succeeded: false, retryable: false };
  }
  const failed = steps.find((s) => s.state === 'failed');
  if (failed !== undefined) {
    if (failed.id === 'signed' || failed.id === 'delivered') {
      return { ...base, tone: 'danger', text: failed.id === 'signed' ? 'Signing failed' : 'Delivery failed', ...(failed.detail !== undefined ? { cause: failed.detail } : {}), succeeded: false, retryable: record.failed !== undefined };
    }
    return { ...base, tone: 'danger', text: 'Not released', ...(failed.detail !== undefined ? { cause: failed.detail } : {}), succeeded: false, retryable: false };
  }
  const active = steps.find((s) => s.state === 'active');
  if (active !== undefined) {
    return { ...base, tone: 'active', text: ACTIVE_TEXT[active.id], succeeded: false, retryable: false };
  }
  // Nothing active and nothing failed: a step still pending only before the first event, else everything is done.
  if (steps.every((s) => s.state === 'done' || s.state === 'skipped')) {
    return { ...base, tone: 'success', text: record.held ? 'Released' : 'Installed', succeeded: true, retryable: false };
  }
  return { ...base, tone: 'active', text: 'Signing', succeeded: false, retryable: false };
}

/** `9 s`, `2 min 5 s`: from the click, frozen when nothing more can happen. */
export function elapsedText(record: ProgressRecord, now: number): string {
  const seconds = Math.max(0, Math.floor(((record.finishedAt ?? now) - record.startedAt) / 1000));
  return seconds < 120 ? `${seconds} s` : `${Math.floor(seconds / 60)} min ${seconds % 60} s`;
}

export interface HoldPolling {
  get(path: string): Promise<unknown>;
  /** `self`, or the uuid (or name) of the machine that holds the request. */
  machine: string;
  id: string;
  /** Epoch milliseconds. */
  now: () => number;
  onEvent: (event: ProgressEvent) => void;
  intervalMs?: number;
  timeoutMs?: number;
}

const OUTCOMES = ['allowed', 'denied', 'deadline', 'disconnected', 'refused', 'revoked'];

function asAnswer(raw: unknown): HoldPollAnswer {
  const o = typeof raw === 'object' && raw !== null ? (raw as { state?: unknown; outcome?: unknown }) : {};
  if (o.state === 'held') {
    return { state: 'held' };
  }
  if (o.state === 'ended' && typeof o.outcome === 'string' && OUTCOMES.includes(o.outcome)) {
    const r = raw as { reason?: unknown; message?: unknown };
    return { state: 'ended', outcome: o.outcome as 'allowed', ...(typeof r.reason === 'string' && typeof r.message === 'string' ? { reason: r.reason, message: r.message } : {}) };
  }
  return { state: 'unknown' };
}

/** Asks the daemon at once and then every 2 s until the hold ended, 3 minutes passed, or `stop()` is called. A failed question is reported and does not stop it. */
export function startHoldPolling(p: HoldPolling): () => void {
  const interval = p.intervalMs ?? HOLD_POLL_MS;
  const timeout = p.timeoutMs ?? HOLD_TIMEOUT_MS;
  const startedAt = p.now();
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let lastError: string | undefined;

  const tick = async (): Promise<void> => {
    if (stopped) {
      return;
    }
    try {
      const answer = asAnswer(await p.get(`/hold-progress/${encodeURIComponent(p.machine)}/${encodeURIComponent(p.id)}`));
      if (stopped) {
        return;
      }
      lastError = undefined;
      p.onEvent({ type: 'hold', answer });
      if (answer.state === 'ended') {
        stopped = true;
        return;
      }
    } catch (e) {
      if (stopped) {
        return;
      }
      const message = (e as Error).message;
      if (message !== lastError) {
        lastError = message;
        p.onEvent({ type: 'poll-error', message });
      }
    }
    if (p.now() - startedAt >= timeout) {
      stopped = true;
      p.onEvent({ type: 'timeout' });
      return;
    }
    timer = setTimeout(() => void tick(), interval);
  };
  void tick();
  return () => {
    stopped = true;
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  };
}
