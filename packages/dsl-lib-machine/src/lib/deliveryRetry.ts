import type { AllowApi } from './allowFlow.js';
import { isDeliveryMachine, type DeliveryMachine } from './approvalResult.js';

// "Retry delivery" of an approval or a revocation (admin-ui.md, "Result and progress UX"): the daemon of the admin machine still holds the signed and sealed documents
// the page gave it (in memory only) and sends again what was not stored. No passphrase and no key: nothing is signed here. The route is `POST /delivery-retry`, body
// exactly `{ uuid }` (the approved or revoked machine), the answer has the shape of the first delivery.

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** What the daemon answers for a delivery (`approveDistribute`, `revokeApply`, `retryDelivery`): the structure the dialog shows, and the report in the words of the CLI. */
export interface DeliveryAnswer {
  failed: boolean;
  text: { out: string; err: string };
  machines: DeliveryMachine[];
  retry: string;
}

/** The answer of the module for a delivery, checked; `undefined` when it has another shape (an older module or daemon). */
export function readDeliveryAnswer(answer: unknown): DeliveryAnswer | undefined {
  if (!isObject(answer) || !isObject(answer['text']) || typeof answer['text']['out'] !== 'string' || typeof answer['text']['err'] !== 'string' || typeof answer['failed'] !== 'boolean' || typeof answer['retry'] !== 'string') {
    return undefined;
  }
  const machines = answer['machines'];
  if (!Array.isArray(machines) || !machines.every(isDeliveryMachine)) {
    return undefined;
  }
  return { failed: answer['failed'], text: { out: answer['text']['out'], err: answer['text']['err'] }, machines, retry: answer['retry'] };
}

/**
 * Asks the daemon to send again what was not delivered for the machine `uuid`. Rejects with the sentence of whoever refused (nothing held any more because the daemon
 * restarted, no admin relay token, an expired document: each names the fix and the terminal command), or when the answer is of another shape.
 */
export async function postDeliveryRetry(api: AllowApi, uuid: string): Promise<DeliveryAnswer> {
  const answer = readDeliveryAnswer(await api.post('/delivery-retry', { uuid }));
  if (answer === undefined) {
    throw new Error('the module backend sent an unexpected answer for the new delivery: the page and the module are not the same version: update the machine module (`app-core-cli update`), reload the page, or run the command of "Run it in a terminal instead"');
  }
  return answer;
}
