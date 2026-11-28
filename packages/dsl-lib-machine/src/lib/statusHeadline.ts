// A table cell that must not wrap (a word is never cut mid-way) holds a SHORT headline; the rest of a long status moves to the row expansion. The texts come
// from the module backend and the daemon (a headline, a colon, the cause and the fix): they are cut at their own separator, never at a width.

/** Longest text kept whole in a cell: the headline of a status is shorter than this, and a column of this width does not scroll the table at 1000 px. */
const WHOLE_UP_TO = 40;

/**
 * `headline`: what the cell shows; `detail`: what the row expansion adds ('' when the text is short or has no place to cut: nothing is ever dropped).
 * The cut is at the first ": " or at the first " (" (the parentheses are removed from the detail), whichever comes first.
 */
export function splitHeadline(text: string, max: number = WHOLE_UP_TO): { headline: string; detail: string } {
  if (text.length <= max) {
    return { headline: text, detail: '' };
  }
  const colon = text.indexOf(': ');
  const paren = text.indexOf(' (');
  const cuts = [colon, paren].filter((i) => i > 0);
  if (cuts.length === 0) {
    return { headline: text, detail: '' };
  }
  const at = Math.min(...cuts);
  if (at === colon) {
    return { headline: text.slice(0, at), detail: text.slice(at + 2) };
  }
  const rest = text.slice(at + 2);
  return { headline: text.slice(0, at), detail: text.endsWith(')') ? rest.slice(0, -1) : `(${rest}` };
}
