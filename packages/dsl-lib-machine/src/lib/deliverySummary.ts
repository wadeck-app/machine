import { deliveryNotice, type AllowResult } from './allowFlow.js';

// How the delivery of a policy reads on the request card: ONE short line per fact, the cause in a smaller line only when the short line cannot carry it,
// the long wording of the CLI only for the details disclosure (never next to the short line).

export interface DeliverySummary {
  tone: 'success' | 'warning';
  /** One line: the path taken, and in brackets why the direct delivery was not used. */
  text: string;
  /** The cause on a line of its own (smaller), only when `text` could not name it. */
  cause?: string;
  /** The long sentence of the CLI (with the fix), for the Details disclosure only. Absent when `text` says everything. */
  explanation?: string;
}

/** `3 min 16 s`, `45 s`, `3 h 2 min`: the formats of machine-core's formatDuration. */
const SKEW = /clock is ((?:\d+ (?:h|min|s))(?: \d+ (?:min|s))?) (behind|ahead of) this machine/;

/** `clock 3 min behind`: the essence of a refusal for the date of the document (the sentence is the one of machine-core's describeClockSkew). */
export function skewEssence(cause: string): string | undefined {
  const m = SKEW.exec(cause);
  return m === null ? undefined : `clock ${m[1]} ${m[2] === 'behind' ? 'behind' : 'ahead'}`;
}

const REASON: Record<string, string> = {
  unreachable: 'not reachable directly',
  'unknown-peer': 'not reachable directly',
  'no-answer': 'not reachable directly',
  refused: 'direct delivery refused',
  'peer-too-old': 'peer too old for direct delivery',
};

/** The delivery of one Allow result as the card words it. */
export function deliverySummary(result: AllowResult): DeliverySummary {
  const notice = deliveryNotice(result);
  if (result.delivery !== 'inbox') {
    return { tone: notice.tone, text: notice.text };
  }
  // The structured cause when the daemon sends it, else the one at the end of its sentence (an older daemon): never dropped.
  const cause = result.fallback?.cause ?? /Cause: (.*)$/s.exec(notice.text)?.[1];
  if (cause === undefined) {
    return { tone: 'warning', text: 'Stored on the relay', explanation: notice.text };
  }
  const reason = (result.fallback !== undefined ? REASON[result.fallback.code] : undefined) ?? 'direct delivery failed';
  const skew = skewEssence(cause);
  if (skew !== undefined) {
    return { tone: 'warning', text: `Stored on the relay (${reason}: ${skew})`, explanation: notice.text };
  }
  // The cause is shown on its own line: the long sentence does not say it a second time.
  return { tone: 'warning', text: `Stored on the relay (${reason})`, cause, explanation: notice.text.replace(/\s*Cause: .*$/s, '') };
}
