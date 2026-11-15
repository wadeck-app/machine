import { adminLoginFix, capitalized, FULL_ACCESS_WHY } from './fullAccess.js';
import { RelayError } from './relayClient.js';

// Calls made with the full-access token of `machine admin login` (relay-admin.json): a refusal of that token has its own advice.

/** The token of relay-admin.json is refused: say how to replace it instead of the generic machine-token advice. */
export function adminRelayError(e: unknown): unknown {
  if (!(e instanceof RelayError)) return e;
  if (e.status === 401) {
    return new Error(`the relay refused the admin token (invalid or revoked)${e.humanText ? `: ${e.humanText}` : ''}: ${adminLoginFix({ force: true })}`);
  }
  if (e.code === 'full_access_required') {
    return new Error(`the token saved by \`machine admin login\` is not a full-access token, so it cannot list or decide candidacies (${FULL_ACCESS_WHY}). ${capitalized(adminLoginFix({ force: true }))}`);
  }
  return e;
}

export async function viaAdminToken<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (e) {
    throw adminRelayError(e);
  }
}
