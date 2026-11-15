// The one place that explains why the admin needs a full-access relay token and how to get one (decision 58). The primary way is
// `machine admin login` (a request the admin confirms in the relay console by typing the code the CLI shows); the pairing code
// (a pairing opened WITHOUT "Limited to scopes") stays the alternative for scripts and for relays that predate the confirm-only login.
// Every message that sends the admin to the relay console uses these sentences, so that the text and the click path never drift apart.

export const FULL_ACCESS_WHY = 'approving a machine needs a full-access relay token (the machines themselves only get a limited one)';

/** The pairing alternative: the click path in the relay console. */
export const FULL_ACCESS_CLICK_PATH = 'in the relay console open Tokens, Add token, WITHOUT "Limited to scopes"';

/** The paragraph shown by the pairing code fallback (a relay that predates the full-access login) before it asks for the code. */
export const FULL_ACCESS_PARAGRAPH = `Next, the relay: ${FULL_ACCESS_WHY}.\nIn the relay console open Tokens, Add token, WITHOUT "Limited to scopes": it shows an 8-digit pairing code.`;

/** The click path at the start of a sentence. */
export const capitalized = (text: string): string => `${text.charAt(0).toUpperCase()}${text.slice(1)}`;

export interface AdminLoginFixOptions {
  /** The relay to name in the commands (`--relay <it>`); absent: the stored one is used. */
  relay?: string;
  /** The fix replaces an existing admin token. */
  force?: boolean;
}

/**
 * What to do when the admin token is missing or refused: the confirm-only login first, the pairing code as the alternative. Lower case,
 * made to follow a colon or a full stop (use `capitalized` after a full stop).
 */
export function adminLoginFix(o: AdminLoginFixOptions = {}): string {
  const tail = `${o.relay !== undefined ? ` --relay ${o.relay}` : ''}${o.force === true ? ' --force' : ''}`;
  return (
    `run \`machine admin login${tail}\` and type the code it shows in the relay console (Tokens page, the request marked FULL ACCESS); ` +
    `or with a pairing code: ${FULL_ACCESS_CLICK_PATH}, then run \`machine admin login <code>${tail}\``
  );
}

/** The pairing code way only (a relay that does not support the confirm-only login: advising it again would send the admin in circles). */
export function pairingLoginFix(o: AdminLoginFixOptions = {}): string {
  const tail = `${o.relay !== undefined ? ` --relay ${o.relay}` : ''}${o.force === true ? ' --force' : ''}`;
  return `${FULL_ACCESS_CLICK_PATH}, then run \`machine admin login <code>${tail}\``;
}
