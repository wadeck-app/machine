// The one place that explains why the admin needs a full-access relay token and how to get one (the mechanism is the relay's: a
// pairing opened WITHOUT "Limited to scopes"; a confirm-only login with full access is not available yet). Every message that
// sends the admin to the relay console uses these two sentences, so that the text and the click path never drift apart.

export const FULL_ACCESS_WHY = 'approving a machine needs a full-access relay token (the machines themselves only get a limited one)';

export const FULL_ACCESS_CLICK_PATH = 'in the relay console open Tokens, Add token, WITHOUT "Limited to scopes"';

/** The paragraph shown by `machine setup` before it asks for the pairing code. */
export const FULL_ACCESS_PARAGRAPH = `Next, the relay: ${FULL_ACCESS_WHY}.\nIn the relay console open Tokens, Add token, WITHOUT "Limited to scopes": it shows an 8-digit pairing code.`;

/** The click path at the start of a sentence. */
export const capitalized = (text: string): string => `${text.charAt(0).toUpperCase()}${text.slice(1)}`;
