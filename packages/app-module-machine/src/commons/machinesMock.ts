import { aliasesApply, aliasesContext, renameApply, renameContext, type AliasesRequest, type RenameRequest } from './machinesActionsState.js';
import { listMachines, machinesAdminKey, retryDelivery, revokeApply, revokeContext, type MachinesState, type MachinesStep, type RevokeRequest } from './machinesState.js';
import { MODULE_PREFIX, type MockRoutes } from './mockRoutes.js';

// The nine routes of the Machines page on mock data (the dev-only scenarios of the module): the pure state machine (machinesState.ts) with its state kept in a closure,
// so that a Revoke changes what the next GET /machines returns. BROWSER-SAFE: no import of another package, no Node API.

const READ_MS = 120;
// Revoke signs, installs, then delivers: a visible wait for the busy state of the dialog.
const WRITE_MS = 600;

/** The routes of one scenario, `seed` being its initial state. Every call builds a new state: the closure of `create()`, so Reset starts again. */
export function machinesRoutes(seed: MachinesState): MockRoutes {
  let state = seed;
  const run = <T>(step: (current: MachinesState) => MachinesStep<T>, delayMs: number): { status: number; body: unknown; delayMs: number } => {
    const out = step(state);
    state = out.state;
    return { status: out.answer.status, body: out.answer.body, delayMs };
  };
  const key = (route: string): string => `${route.slice(0, route.indexOf(' '))} ${MODULE_PREFIX}${route.slice(route.indexOf(' ') + 1)}`;
  return {
    [key('GET /machines')]: () => run((s) => listMachines(s), READ_MS),
    [key('GET /admin-key')]: () => run((s) => machinesAdminKey(s), READ_MS),
    [key('GET /revoke-context/:uuid')]: (req) => run((s) => revokeContext(s, req.params['uuid'] ?? ''), READ_MS),
    [key('POST /revoke')]: (req) => run((s) => revokeApply(s, req.body as RevokeRequest), WRITE_MS),
    [key('GET /rename-context/:uuid')]: (req) => run((s) => renameContext(s, req.params['uuid'] ?? ''), READ_MS),
    [key('POST /rename')]: (req) => run((s) => renameApply(s, req.body as RenameRequest), WRITE_MS),
    [key('GET /aliases-context')]: () => run((s) => aliasesContext(s), READ_MS),
    [key('POST /aliases')]: (req) => run((s) => aliasesApply(s, req.body as AliasesRequest), WRITE_MS),
    [key('POST /delivery-retry')]: (req) => run((s) => retryDelivery(s, req.body), WRITE_MS),
  };
}
