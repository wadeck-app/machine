import { randomUUID } from 'node:crypto';
import { buildRunLogLine, outcomeOfAnswer, outcomeOfFailure, waitModeOf, type RunLogMachine, type RunLogOutcome, type RunWait } from '@wadeck-app/machine-core';
import { appendRunLog } from './runLogStore.js';

// `machine run` writes one line of the outgoing run log (run-log.md) when it ends, whatever the end: an answer, a refusal, a connection that
// failed. It is a wrapper around the run so that no exit path of the run can forget it. A run refused before anything was sent (bad flag, unknown
// machine, unreadable setting) is not recorded: nothing was asked of a peer. A log that cannot be written is said once on stderr and never stops
// the run.

/** What the run reports to the recorder while it goes. */
export interface RunRecorder {
  /** The peer is known and the connection is about to be tried: from here the run is recorded. */
  target: (t: { self: RunLogMachine; peer: RunLogMachine; shell: string; command: string; wait: RunWait }) => void;
  /** The request is about to be sent. */
  sending: () => void;
  /** The peer answered (a result or a refusal). */
  answered: (answer: { type: 'result'; id: string; exitCode: number | null; timedOut: boolean; durationMs: number } | { type: 'refused'; id?: string; reason: string; held?: unknown }) => void;
}

export interface RunRecordEnv {
  configDir: string;
  stderr: (text: string) => void;
  nowMs?: () => number;
}

type Answer = Parameters<RunRecorder['answered']>[0];

export async function recordRun(env: RunRecordEnv, body: (recorder: RunRecorder) => Promise<number>): Promise<number> {
  const now = env.nowMs ?? Date.now;
  const startedAt = now();
  let target: Parameters<RunRecorder['target']>[0] | undefined;
  let sentAt: number | undefined;
  let answer: { value: Answer; at: number } | undefined;
  const recorder: RunRecorder = {
    target: (t) => {
      target = t;
    },
    sending: () => {
      sentAt = now();
    },
    answered: (value) => {
      answer = { value, at: now() };
    },
  };

  const write = (failure: Error | undefined): void => {
    try {
      writeOrThrow(failure);
    } catch (e) {
      env.stderr(`[warn] this run is NOT recorded in the run log: ${(e as Error).message}. The run itself is not affected\n`);
    }
  };
  const writeOrThrow = (failure: Error | undefined): void => {
    if (target === undefined) {
      return;
    }
    let outcome: RunLogOutcome;
    if (answer !== undefined) {
      outcome = outcomeOfAnswer(answer.value);
    } else if (failure !== undefined) {
      outcome = outcomeOfFailure(failure.message);
    } else {
      outcome = { outcome: 'error', cause: 'the run ended without an answer from the peer' };
    }
    const asked = target.wait.onRefusal === 'wait';
    // Time before the answer, minus what the command itself ran: what the caller spent waiting for the owner (and the network).
    const elapsedMs = answer !== undefined && sentAt !== undefined ? answer.at - sentAt : 0;
    const ranMs = answer?.value.type === 'result' ? answer.value.durationMs : 0;
    const finishedAt = now();
    const line = buildRunLogLine({
      now: sentAt ?? startedAt,
      runId: answer?.value.id ?? randomUUID(),
      from: target.self,
      to: target.peer,
      shell: target.shell,
      command: target.command,
      waitMode: waitModeOf(target.wait),
      onRefusal: target.wait.onRefusal,
      ...(target.wait.onRefusal === 'wait' ? { waitSeconds: target.wait.seconds } : {}),
      waitedSeconds: asked ? Math.max(0, Math.round((elapsedMs - ranMs) / 1000)) : 0,
      outcome,
      durationMs: Math.max(0, finishedAt - startedAt),
      // The run time of the command as the target measured it, apart from the wait: the Activity page shows both.
      ...(answer?.value.type === 'result' ? { execMs: answer.value.durationMs } : {}),
    });
    const result = appendRunLog(env.configDir, line);
    for (const warning of result.warnings) {
      env.stderr(`[warn] ${warning}\n`);
    }
  };

  let code: number;
  try {
    code = await body(recorder);
  } catch (e) {
    write(e instanceof Error ? e : new Error(String(e)));
    throw e;
  }
  write(undefined);
  return code;
}
