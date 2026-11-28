import { splitHeadline } from './statusHeadline.js';

// The status of a candidacy that cannot be approved says WHY in a few words (UX review 4): "Cannot be approved" alone hid the reason until the row was expanded. The module
// backend words each problem as a whole sentence (a cause, a fix); the cell takes its first words, the sentences stay in the row expansion.

const PREFIX = 'Cannot be approved';
/** Longest reason shown in the cell. */
const MAX_REASON = 32;

// The problems the module backend (candidacies.ts) and the scenario state (commons/candidaciesState.ts) produce, in a few words. The order matters: first match wins.
const KNOWN: Array<[RegExp, string]> = [
  [/is expired/, 'expired'],
  [/carries no uuid/, 'no uuid'],
  [/does not match the key and random|verification code cannot be computed/, 'code mismatch'],
  [/uuid sent by the relay is not/, 'invalid uuid'],
  [/machine name is invalid/, 'invalid name'],
  [/not an Ed25519 public key/, 'invalid key'],
  [/the relay sent (no|an unusable|an invalid)/, 'incomplete data from the relay'],
];

/** The first words of an unknown problem: cut at its first colon or parenthesis, then at a word, with an ellipsis when it was cut. */
function firstWords(problem: string): string {
  const cut = splitHeadline(problem.trim(), 0).headline.trim();
  if (cut === '') {
    return 'see the details';
  }
  if (cut.length <= MAX_REASON) {
    return cut;
  }
  const words = cut.slice(0, MAX_REASON + 1).split(' ');
  words.pop();
  return `${words.join(' ')}...`;
}

function reasonOf(problem: string): string {
  if (problem.trim() === '') {
    return 'see the details';
  }
  return KNOWN.find(([re]) => re.test(problem))?.[1] ?? firstWords(problem);
}

/**
 * What the Status cell shows: for a candidacy with a problem, "Cannot be approved: <reason>" (+N more when there are several); otherwise the headline of the status text
 * (the part before its first colon or parenthesis when it is long).
 */
export function statusHeadlineOf(row: { statusText: string; problems: readonly string[] }): string {
  const first = row.problems[0];
  if (first === undefined) {
    return splitHeadline(row.statusText).headline;
  }
  const more = row.problems.length - 1;
  return `${PREFIX}: ${reasonOf(first)}${more > 0 ? ` (+${more} more)` : ''}`;
}
