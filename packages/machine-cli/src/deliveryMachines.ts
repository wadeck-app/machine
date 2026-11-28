import type { DirectCode } from './directDelivery.js';
import type { DistributionReport, Recipient } from './distribute.js';

// The per-machine view of a distribution report, for the Candidacies page (admin-ui.md, "Approve from the page"): the page shows one short line per machine and keeps
// the raw CLI text (`formatDistribution`, untouched) in a collapsed "Details". Same report, so the two cannot disagree.

/** `delivered`: the machine took every document straight over the peer channel. `inbox`: the relay holds them, the machine installs them at its next check. `failed`: not stored anywhere. */
export type DeliveryState = 'delivered' | 'inbox' | 'failed';

/** Why: `direct` (peer channel), `inbox` (no peer channel in use), a `DirectCode` (the peer channel failed, the inbox took over), `not-stored` (a document failed) or `not-attempted` (the run stopped before it). */
export type DeliveryCode = 'direct' | 'inbox' | DirectCode | 'not-stored' | 'not-attempted';

export interface DeliveryMachine {
  uuid: string;
  name: string;
  state: DeliveryState;
  code: DeliveryCode;
  /** ONE short reason, never the cause text of an error (that stays in the raw report). */
  reason: string;
  /** ONE next action; `nothing to do` when there is none. Commands are in backticks. */
  next: string;
}

const NOTHING = 'nothing to do';
const BY_ITSELF = `installs by itself when it is back, ${NOTHING}`;

/**
 * One entry per recipient, in the order given. A machine is `failed` when any of its documents was not stored, `inbox` when at least one document went through the
 * relay (or when no peer channel was used at all), `delivered` when every document it received was taken directly. After an aborted run, a machine without any trace
 * of delivery was never attempted: it is reported as failed (the retry is safe), never as delivered.
 */
export function deliveryMachines(report: DistributionReport, recipients: Recipient[], retry: string): DeliveryMachine[] {
  return recipients.map((to): DeliveryMachine => {
    const base = { uuid: to.uuid, name: to.name };
    if (report.failures.some((f) => f.toUuid === to.uuid)) {
      return { ...base, state: 'failed', code: 'not-stored', reason: 'documents not stored', next: `run \`${retry}\`` };
    }
    const fallback = (report.fallbacks ?? []).find((f) => f.toUuid === to.uuid);
    if (fallback !== undefined) {
      return { ...base, state: 'inbox', ...inboxAfterDirect(fallback.code, to.name, retry) };
    }
    const tookDirectly = (report.direct ?? []).some((d) => d.toUuid === to.uuid) || (report.noticeDirectNames ?? []).includes(to.name);
    if (tookDirectly) {
      return { ...base, state: 'delivered', code: 'direct', reason: 'took the documents directly', next: NOTHING };
    }
    if (report.aborted) {
      return { ...base, state: 'failed', code: 'not-attempted', reason: 'not attempted', next: `fix the relay access (see Details), then run \`${retry}\`` };
    }
    return { ...base, state: 'inbox', code: 'inbox', reason: 'waiting in the relay inbox', next: `installs by itself at its next check, ${NOTHING}` };
  });
}

function inboxAfterDirect(code: DirectCode, name: string, retry: string): Pick<DeliveryMachine, 'code' | 'reason' | 'next'> {
  switch (code) {
    case 'unreachable':
    case 'no-answer':
      return { code, reason: 'offline', next: BY_ITSELF };
    case 'unknown-peer':
      return { code, reason: 'no direct address known', next: BY_ITSELF };
    case 'peer-too-old':
      return { code, reason: 'runs an older build', next: `run \`machine cli update\` on ${name}, then \`${retry}\`` };
    case 'refused':
      return { code, reason: 'refused the documents', next: `fix the cause (see Details), then run \`${retry}\`` };
    case 'unexpected-answer':
      return { code, reason: 'runs an incompatible version', next: `run \`machine cli update\` on ${name} and on this machine, then \`${retry}\`` };
  }
}
