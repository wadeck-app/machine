import { dedupeReport, describeDelivery, isDeliveryMachine, type DeliveryMachine, type DeliverySummary } from './approvalResult.js';
import type { DeliveryAnswer } from './deliveryRetry.js';

// What the dialogs of the actions that send documents after a signature (rename, network aliases) show of the delivery: one headline, one line per machine, the raw report
// folded, the terminal command folded. Same words and same structure as the revocation (lib/revokeFlow.ts); only the sentence in front of the headline differs.

export interface PageDistribution extends DeliverySummary {
  /** `delivered`: every machine took its document or the relay inbox holds it. `partial`: the daemon delivered what it could and names the rest. `none`: nobody to tell. */
  status: 'delivered' | 'partial' | 'none';
  /** The raw report in the words of the CLI (the "Details"), without the lines it repeats; for `partial` it names the exact retry command. */
  text: string;
  machines: DeliveryMachine[];
  /** The terminal command that finishes the job (it asks the admin passphrase). Said once, folded, never in the headline. */
  retryCommand: string;
}

export const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** True when the answer of the module has the structure of a delivery (the list of machines included): an older module or daemon has not. */
export function hasDeliveryShape(answer: unknown): answer is Record<string, unknown> & { text: { out: string; err: string }; failed: boolean; machines: DeliveryMachine[] } {
  return isObject(answer) && isObject(answer['text']) && typeof answer['text']['out'] === 'string' && typeof answer['text']['err'] === 'string' && typeof answer['failed'] === 'boolean' && Array.isArray(answer['machines']) && answer['machines'].every(isDeliveryMachine);
}

/**
 * The report of the daemon as a dialog shows it. `said` is the sentence in front of the headline (what was done), `buildNotes` the documents the page could not build
 * (they stay failures: only a signature can make them).
 */
export function distributionOf(answer: DeliveryAnswer, said: string, retry: string, buildNotes: string[], standsNote: string): PageDistribution {
  const { machines } = answer;
  const stands = buildNotes.length > 0 && !answer.failed ? [standsNote] : [];
  const lines = [answer.text.out.trimEnd(), ...buildNotes, answer.text.err.trimEnd(), ...stands].filter((l) => l !== '');
  const text = dedupeReport(lines.join('\n'));
  const failed = answer.failed || buildNotes.length > 0;
  if (machines.length === 0 && !failed) {
    return { status: 'none', text, machines, headline: said, tone: 'success', waiting: 0, retryCommand: retry };
  }
  const status = failed ? 'partial' : 'delivered';
  const summary = describeDelivery(status, machines);
  return { status, text, machines, headline: `${said} ${summary.headline}`, tone: summary.tone, waiting: summary.waiting, retryCommand: retry };
}
