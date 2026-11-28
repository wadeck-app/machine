import type { DeliveryMachineWire, DistributeAnswer, ErrorBody, RouteAnswer } from './routeContracts.js';

// `POST /delivery-retry` on mock data (the dev-only scenarios): what the daemon (machine-cli `deliveryRetry.ts`) and the module backend (`deliveryRetry.ts`) answer, shared by
// the Candidacies and the Machines mocks. The daemon keeps the documents of a run that did not store them all, in memory, and the first retry delivers them: the mock does
// the same, from the delivery the scenario planned. BROWSER-SAFE: no import of another package, no Node API.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** Same text as the module backend (`RETRY_RULE`). */
export const RETRY_RULE = 'expected exactly {"uuid": "<uuid of the machine the approval or the revocation was about>"}, nothing else: reload the page and try again';

const refuse = (status: number, kind: string, error: string): RouteAnswer<never> => ({ status, body: { status, kind, error, message: error } as ErrorBody });

/** The uuid of the body when it is exactly `{ uuid }`, else the 400 answer of the backend. */
export function retryUuid(body: unknown): { uuid: string } | RouteAnswer<never> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return refuse(400, 'bad_request', RETRY_RULE);
  const keys = Object.keys(body);
  const uuid = (body as { uuid?: unknown }).uuid;
  if (keys.length !== 1 || typeof uuid !== 'string' || !UUID.test(uuid)) return refuse(400, 'bad_request', RETRY_RULE);
  return { uuid };
}

/** The refusal of the daemon when it keeps nothing (409, reason `nothing-retained`): the same words. */
export const nothingRetained = (uuid: string): RouteAnswer<never> =>
  refuse(
    409,
    'nothing-retained',
    `this machine keeps no documents to send again for ${uuid}: the daemon keeps them only in memory, they are lost when the daemon restarts and after a run that delivered everything. Run \`machine admin distribute ${uuid}\` in a terminal (it asks the admin passphrase)`,
  );

/**
 * The answer of the first retry: every machine that failed is now in the relay inbox (the machines that were not failed keep their entry), so nothing failed any more.
 * `exclude` is the revoked machine of a revocation: it has no entry once it is removed from the relay.
 */
export function retriedAnswer(planned: { subject: { uuid: string; name: string }; machines: DeliveryMachineWire[]; retry: string }, exclude?: string): DistributeAnswer {
  const stored = planned.machines.filter((m) => m.state === 'failed' && m.uuid !== exclude);
  const machines = planned.machines
    .filter((m) => m.uuid !== exclude)
    .map((m): DeliveryMachineWire => (m.state === 'failed' ? { ...m, state: 'inbox', code: 'inbox', reason: 'waiting in the relay inbox', next: 'installs by itself at its next check, nothing to do' } : m));
  return {
    ok: true,
    subject: planned.subject,
    failed: false,
    report: {},
    text: { out: `[ok] ${stored.length * 2} document(s) stored by the relay for ${stored.length} machine(s)\n`, err: '' },
    machines,
    retry: planned.retry,
  };
}
