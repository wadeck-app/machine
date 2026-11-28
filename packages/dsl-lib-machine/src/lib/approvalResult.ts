// What the approval dialog shows of the delivery of the documents (admin-ui.md, "Approve from the page"): ONE headline, a tone, one short line per machine, and the raw
// text of the CLI in a collapsed "Details". The structure comes from the daemon (`approveDistribute` answers `machines`, built from the same report as the text), never
// from parsing the text.

/** The state of one machine after the delivery: it took the documents, the relay holds them for it, or they were not stored. */
export type DeliveryState = 'delivered' | 'inbox' | 'failed';

export interface DeliveryMachine {
  uuid: string;
  name: string;
  state: DeliveryState;
  /** Why (`direct`, `inbox`, `unreachable`, `not-stored`, ...): see machine-cli `deliveryMachines.ts`. */
  code: string;
  /** ONE short reason. */
  reason: string;
  /** ONE next action, commands in backticks; `nothing to do` when there is none. */
  next: string;
}

export type DeliveryTone = 'success' | 'warning' | 'danger';

export interface DeliverySummary {
  headline: string;
  tone: DeliveryTone;
  /** The machines whose documents wait in the relay inbox. */
  waiting: number;
}

/** A machine in the inbox whose own fix is needed (not just "it is offline"). */
const NEEDS_ACTION = new Set(['peer-too-old', 'refused', 'unexpected-answer']);

const machines = (n: number): string => `${n} ${n === 1 ? 'machine' : 'machines'}`;

/**
 * The one-line outcome. `status` is the one of the delivery (`failed`: the daemon could not even be asked, so there is no machine list); `retry` is the exact command
 * that finishes the job.
 */
export function describeDelivery(status: 'delivered' | 'partial' | 'failed' | 'none', list: DeliveryMachine[], retry: string): DeliverySummary {
  if (status === 'none') {
    return { headline: 'No other machine to tell: this is the first machine of the network.', tone: 'success', waiting: 0 };
  }
  if (status === 'failed') {
    return { headline: `The other machines were NOT told. Run \`${retry}\` on this machine; it is safe to run again.`, tone: 'danger', waiting: 0 };
  }
  const delivered = list.filter((m) => m.state === 'delivered').length;
  const waiting = list.filter((m) => m.state === 'inbox').length;
  const lost = list.filter((m) => m.state === 'failed').length;
  if (lost === 0 && list.length === 0) {
    return status === 'partial' ? { headline: `Some machines were NOT told. Run \`${retry}\`.`, tone: 'warning', waiting: 0 } : { headline: 'Documents delivered.', tone: 'success', waiting: 0 };
  }
  if (lost > 0 && delivered + waiting === 0) {
    return { headline: `Documents NOT delivered to ${machines(lost)}. Run \`${retry}\`.`, tone: 'danger', waiting: 0 };
  }
  const parts: string[] = [];
  if (delivered > 0) {
    parts.push(`Documents delivered to ${machines(delivered)}`);
  }
  if (waiting > 0) {
    parts.push(delivered > 0 ? `${waiting} ${waiting === 1 ? 'waits' : 'wait'} in the relay inbox` : `Documents wait in the relay inbox of ${machines(waiting)}`);
  }
  if (lost > 0) {
    parts.push(`${lost} NOT told`);
  }
  const headline = `${parts.join(', ')}.${lost > 0 ? ` Run \`${retry}\`.` : ''}`;
  const needsAction = list.some((m) => m.state === 'inbox' && NEEDS_ACTION.has(m.code));
  return { headline, tone: lost > 0 || needsAction ? 'warning' : 'success', waiting };
}

/** The raw report for the collapsed "Details": every line once, in order (the CLI repeats a sentence for each machine). */
export function dedupeReport(text: string): string {
  const seen = new Set<string>();
  const kept: string[] = [];
  for (const line of text.split('\n')) {
    const key = line.trim();
    if (key === '' || seen.has(key)) {
      continue;
    }
    seen.add(key);
    kept.push(line);
  }
  return kept.join('\n');
}
