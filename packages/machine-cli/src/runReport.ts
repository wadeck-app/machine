import { classifyRunFailure, failureDocument, refusalDocument, resultDocument, type RefusedAnswer, type ResultAnswer, type RunCode, type RunDocument } from '@wadeck-app/machine-core';
import { PeerAddressError } from './peerAddresses.js';
import { WakeError } from './wakeConnect.js';
import { ConnectError } from '@wadeck-app/machine-transport';

// `machine run --json` prints exactly ONE document for every outcome (decision 114, D5). The reporter is created per run: the first outcome is the document, the
// later calls (the human failure line that follows a refusal, for instance) print nothing more. Without --json it does nothing.

export interface RunReporter {
  /** The code of the NEXT failure() (the failure sites say what kind of failure they are). */
  as: (code: RunCode) => void;
  /** A failure of machine with its human sentence; code from `as`, else `failed`. */
  failure: (message: string) => void;
  result: (answer: ResultAnswer) => void;
  refusal: (answer: RefusedAnswer, message: string, context: { sentInput: boolean }) => void;
  /** A thrown error: classified by its type and its text. */
  thrown: (error: unknown) => void;
  /** Safety net at the end of a run: a run must never end without a document. */
  ensure: () => void;
  printed: () => boolean;
}

export function createRunReporter(json: boolean, stdout: (text: string) => void): RunReporter {
  let done = false;
  let next: RunCode | undefined;
  const print = (document: RunDocument): void => {
    if (!json || done) {
      return;
    }
    done = true;
    stdout(`${JSON.stringify(document, null, 2)}\n`);
  };
  return {
    as: (code) => {
      next = code;
    },
    failure: (message) => {
      print(failureDocument(next ?? 'failed', message));
      next = undefined;
    },
    result: (answer) => print(resultDocument(answer)),
    refusal: (answer, message, context) => print(refusalDocument(answer, message, context)),
    thrown: (error) => {
      const message = error instanceof Error ? error.message : String(error);
      // The type says "no way to reach it": no address, every address failed, the wake could not help, a connection that did not open.
      const unreachable = error instanceof PeerAddressError || error instanceof WakeError || error instanceof ConnectError;
      print(failureDocument(classifyRunFailure({ message, unreachable }), message));
    },
    ensure: () => print(failureDocument('failed', 'the run ended without a result or a refusal: this is a bug of machine, please report it with `machine cli logs`')),
    printed: () => done,
  };
}
