import type { AllowApi } from './allowFlow.js';

// The relay login started from the page (admin-ui.md, "A failed source: three cases"). The daemon runs `machine admin login` in the background (machine-cli
// adminLoginFromPage.ts); the module routes carry its state: GET /admin-login (read), POST /admin-login (start) and POST /admin-login/cancel (both sensitive: the app-core PIN).
// An answer that is not what the daemon promises is an error that names it, never an empty state.

/** The state of the login (machine-cli `AdminLoginAnswer`, `ok: true`; `routeContracts.test.ts` keeps them equal). */
export type AdminLoginState =
  | { ok: true; state: 'idle' }
  | { ok: true; state: 'waiting'; userCode: string; verificationUrl: string; label: string; relayUrl: string; /** Epoch seconds. */ expiresAt: number; consoleHint: string }
  | { ok: true; state: 'approved'; label: string; scopes: string[] | null }
  | { ok: true; state: 'failed'; message: string };

const bad = (answer: unknown): Error => new Error(`the daemon answered the relay login with something this page does not understand (${JSON.stringify(answer)?.slice(0, 200) ?? 'nothing'}): the module and the daemon are not the same version, update both`);

const isText = (v: unknown): v is string => typeof v === 'string' && v.length > 0;

/** Reads one answer of the login routes; throws when it is not a state. */
export function parseAdminLogin(answer: unknown): AdminLoginState {
  if (typeof answer !== 'object' || answer === null) throw bad(answer);
  const o = answer as Record<string, unknown>;
  if (o['ok'] !== true) throw bad(answer);
  switch (o['state']) {
    case 'idle':
      return { ok: true, state: 'idle' };
    case 'waiting':
      if (!isText(o['userCode']) || !isText(o['verificationUrl']) || !isText(o['label']) || !isText(o['relayUrl']) || typeof o['expiresAt'] !== 'number' || !isText(o['consoleHint'])) throw bad(answer);
      return { ok: true, state: 'waiting', userCode: o['userCode'], verificationUrl: o['verificationUrl'], label: o['label'], relayUrl: o['relayUrl'], expiresAt: o['expiresAt'], consoleHint: o['consoleHint'] };
    case 'approved':
      if (!isText(o['label'])) throw bad(answer);
      return { ok: true, state: 'approved', label: o['label'], scopes: Array.isArray(o['scopes']) ? o['scopes'].map(String) : null };
    case 'failed':
      if (!isText(o['message'])) throw bad(answer);
      return { ok: true, state: 'failed', message: o['message'] };
    default:
      throw bad(answer);
  }
}

/** The state of the login the daemon holds (no PIN: it is a read). */
export async function readAdminLogin(api: AllowApi): Promise<AdminLoginState> {
  return parseAdminLogin(await api.get('/admin-login'));
}

/** Starts the login: the PIN of app-core first (the route makes the machine contact the relay), then the daemon answers the code to compare. Rejects with the daemon sentence when it refuses. */
export async function startAdminLogin(api: AllowApi): Promise<AdminLoginState> {
  await api.elevate();
  return parseAdminLogin(await api.post('/admin-login', undefined));
}

/** Stops the wait: nothing is stored. */
export async function cancelAdminLogin(api: AllowApi): Promise<AdminLoginState> {
  await api.elevate();
  return parseAdminLogin(await api.post('/admin-login/cancel', undefined));
}
