// The one place that explains what the admin relay token is and how to get it (decision 59, which replaces the full-access story of decision 58).
// The admin token is a token of the `machine-admin` scope: everything a machine token may do, plus approving machines (list and decide candidacies,
// write inbox documents, delete a machine). It can NOT manage tokens. The admin confirms the request once in the relay console; nothing is copied.
// A full-access token stays possible as an explicit opt-in (`machine admin login --full-access`), never by itself.
// Every message that sends the admin to the relay console uses these sentences, so that the text and the click path never drift apart.

/** The relay commit that introduced the scope: named in the errors of a relay that predates it. */
export const MACHINE_ADMIN_RELAY_COMMIT = 'poc-node 78fe5b2';

/** Why the admin needs its own token and what that token is. */
export const ADMIN_TOKEN_WHY = 'approving a machine needs the admin relay token (limited to machine rights, it cannot manage tokens)';

/** What the relay console shows next to the request: the sentence to compare with. */
export const MACHINE_ADMIN_CHIP = 'MACHINE ADMIN: can approve machines, cannot manage tokens';

/** The pairing alternative for the admin: the click path in the relay console (a token limited to the machine-admin scope). */
export const PAIRING_CLICK_PATH = 'in the relay console open Tokens, Add token, "Limited to scopes", machine-admin';

/** The pairing code of a FULL-ACCESS token (an older relay, or an explicit choice): the click path in the relay console. */
export const FULL_PAIRING_CLICK_PATH = 'in the relay console open Tokens, Add token, WITHOUT "Limited to scopes"';

/** The paragraph shown by the pairing code fallback of `machine admin login --full-access` (a relay that predates the full-access login). */
export const FULL_PAIRING_PARAGRAPH = `Next, the relay: you asked for a FULL-ACCESS token, which can also manage tokens.\nIn the relay console open Tokens, Add token, WITHOUT "Limited to scopes": it shows an 8-digit pairing code.`;

/** The warning printed whenever a full-access token is stored as the admin token. */
export const FULL_ACCESS_WARNING = '[warn] this admin token has FULL ACCESS: it can also manage tokens, which approving machines does not need. Prefer `machine admin login --force` (a MACHINE ADMIN token, it cannot manage tokens) and revoke this one in the relay console';

/** The click path at the start of a sentence. */
export const capitalized = (text: string): string => `${text.charAt(0).toUpperCase()}${text.slice(1)}`;

export interface AdminLoginFixOptions {
  /** The relay to name in the commands (`--relay <it>`); absent: the stored one is used. */
  relay?: string;
  /** The fix replaces an existing admin token. */
  force?: boolean;
}

const tailOf = (o: AdminLoginFixOptions): string => `${o.relay !== undefined ? ` --relay ${o.relay}` : ''}${o.force === true ? ' --force' : ''}`;

/**
 * What to do when the admin token is missing or refused: the confirm-once login first, the pairing code as the alternative. Lower case,
 * made to follow a colon or a full stop (use `capitalized` after a full stop).
 */
export function adminLoginFix(o: AdminLoginFixOptions = {}): string {
  const tail = tailOf(o);
  return (
    `run \`machine admin login${tail}\` and confirm the request in the relay console (Tokens page, the request marked MACHINE ADMIN: it can approve machines and cannot manage tokens); ` +
    `or with a pairing code: ${PAIRING_CLICK_PATH}, then run \`machine admin login <code>${tail}\``
  );
}

/** The pairing code of a full-access token only (a relay that does not support the full-access login: advising the login again would send the admin in circles). */
export function fullPairingFix(o: AdminLoginFixOptions = {}): string {
  return `${FULL_PAIRING_CLICK_PATH}, then run \`machine admin login <code>${tailOf(o)}\``;
}

/**
 * The explicit choices offered by a relay that predates the `machine-admin` scope. Nothing is done by itself: a full-access token is never requested
 * without the person typing `--full-access`. `setup` explains how its first machine continues after the admin login.
 */
export function machineAdminUnsupportedAdvice(o: AdminLoginFixOptions & { setup?: boolean } = {}): string {
  const tail = tailOf(o);
  const choices =
    `explicit choices (nothing is done by itself): \`machine admin login --full-access${tail}\` requests a FULL-ACCESS token (a token that can also manage tokens; a [warn] says so), ` +
    `or \`machine admin login <code>${tail}\` claims a pairing code of the relay console (${FULL_PAIRING_CLICK_PATH}: on this relay it is a full-access token)`;
  return o.setup === true
    ? `${choices}. Then run \`machine setup${o.relay !== undefined ? ` ${o.relay}` : ''}\` again: it keeps the admin token and asks for the machine login separately`
    : choices;
}
