import type { AllowResult } from './allowFlow.js';

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
  state: StepState;
  /** What the person needs to read next to the step (the path and its cause, the wait, the failure). */
  detail?: string;
}

export type HoldPollAnswer = { state: 'held' } | { state: 'unknown' } | { state: 'ended'; outcome: 'allowed' | 'denied' | 'deadline' | 'disconnected' | 'refused' | 'revoked' };

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
  denied: 'the request was denied (nothing ran)',
  deadline: 'the wait ended before the command was released: the deadline of the caller passed (nothing ran)',
  disconnected: 'the caller disconnected before the command was released (nothing ran)',
  refused: 'the target refused the request after all (nothing ran)',
  revoked: 'the caller was revoked on the target (nothing ran)',
};

/** The steps as they stand now. */
export function stepsOf(record: ProgressRecord, _now: number): ProgressStep[] {
  const name = record.machineName;
  const { result, failed } = record;
  const ended = record.hold?.state === 'ended' ? record.hold : undefined;
  const steps: ProgressStep[] = [];

  steps.push({ id: 'signed', label: record.signed ? 'Signed' : 'Signing', state: record.signed ? 'done' : failed !== undefined ? 'failed' : 'active' });

  // Step 2: the delivery.
  if (result !== undefined) {
    const label = result.delivery === 'direct' ? `Delivered directly to ${name}` : result.delivery === 'inbox' ? 'Stored on the relay' : (result.deliveryText?.text ?? `Installed on ${name}`);
    steps.push({ id: 'delivered', label, state: 'done', ...(result.deliveryText !== undefined ? { detail: result.deliveryText.text } : {}) });
  } else if (failed !== undefined && record.signed) {
    steps.push({ id: 'delivered', label: 'Delivering', state: 'failed', detail: failed });
  } else {
    steps.push({ id: 'delivered', label: 'Delivering', state: record.signed ? 'active' : 'pending' });
  }

  // Step 3: the target installs the policy.
  const acknowledged = result !== undefined && (result.delivery === 'direct' || result.delivery === 'installed');
  const impliedByEnd = ended?.outcome === 'allowed';
  if (acknowledged || impliedByEnd) {
    steps.push({ id: 'installs', label: `${name} installed the policy`, state: 'done' });
  } else if (result !== undefined && result.delivery === 'inbox') {
    if (ended !== undefined) {
      steps.push({ id: 'installs', label: `${name} installs the policy`, state: 'skipped', detail: 'not confirmed: the request ended first' });
    } else if (record.timedOut) {
      steps.push({ id: 'installs', label: `${name} installs the policy`, state: 'failed', detail: 'not confirmed' });
    } else {
      steps.push({ id: 'installs', label: `${name} installs the policy`, state: 'active', detail: 'it installs it at its next inbox poll (within 60 s, or 5 s while it holds a request)' });
    }
  } else {
    steps.push({ id: 'installs', label: `${name} installs the policy`, state: 'pending' });
  }

  // Step 4: the end of the hold, only for a request somebody waits for.
  if (record.held) {
    if (ended?.outcome === 'allowed') {
      steps.push({ id: 'released', label: 'The held command was released', state: 'done' });
    } else if (ended !== undefined) {
      steps.push({ id: 'released', label: 'The held command was not released', state: 'failed', detail: OUTCOME_TEXT[ended.outcome] ?? `the request ended: ${ended.outcome}` });
    } else if (record.timedOut) {
      steps.push({ id: 'released', label: 'The held command was not confirmed', state: 'failed', detail: noConfirmationMessage(name) });
    } else if (steps[2]?.state === 'done') {
      steps.push({ id: 'released', label: 'Waiting for the held command to be released', state: 'active' });
    } else {
      steps.push({ id: 'released', label: 'The held command is released', state: 'pending' });
    }
  }
  return steps;
}

/** Determinate progress: the share of the steps that are done. */
export function percentOf(record: ProgressRecord): number {
  const steps = stepsOf(record, 0);
  return Math.round((steps.filter((s) => s.state === 'done').length / steps.length) * 100);
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
    return { state: 'ended', outcome: o.outcome as 'allowed' };
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
