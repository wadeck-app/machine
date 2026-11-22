import { classifyReadOnly, type ReadOnlyVerdict } from '@wadeck-app/machine-webcrypto';
import { askRisk, askSummary, choiceFromAsk, type CallerAsk } from './callerAsk.js';
import { choiceFromLimits, lifetimeInput, type LifetimeChoice } from './lifetimeChoice.js';

// What the card of a held request decides BEFORE the click of the one-click Allow: the lifetime it starts from, what is flagged (a flagged lifetime never
// signs in one click), and the ONE status line. No React, no I/O.

/** The risk of a lifetime the OWNER chose, in the words of `askRisk` (same thresholds: permanent, 50 calls or more, more than 7 days). */
function choiceRisk(choice: LifetimeChoice): string | undefined {
  if (choice.kind === 'permanent') {
    return askRisk({ for: 'permanent' });
  }
  if (choice.kind !== 'custom' || !lifetimeInput(choice).ok) {
    return undefined;
  }
  const text = choice.customText.trim();
  return askRisk(choice.customKind === 'calls' ? { times: Number(text) } : { for: text });
}

/**
 * Why this card must NOT sign in one click, one short reason each: the lifetime chosen in the select, and what the caller asked for (even when the owner picked
 * something smaller: the ask stays flagged). Empty: one click signs.
 */
export function cardFlags(choice: LifetimeChoice, ask: CallerAsk | undefined): string[] {
  const own = choiceRisk(choice);
  const theirs = ask !== undefined ? askRisk(ask) : undefined;
  return [...(own !== undefined ? [own] : []), ...(theirs !== undefined ? [`the caller asked for ${theirs}`] : [])];
}

/** The last lifetime the owner picked in this page, kept in memory only (never stored). A flagged one is never kept: the next card starts safe again. */
let remembered: LifetimeChoice | undefined;
export const lifetimeMemory = {
  get: (): LifetimeChoice | undefined => remembered,
  remember(choice: LifetimeChoice): void {
    // A flagged choice, or one that is not a lifetime yet (an empty custom field being typed), is never kept.
    if (lifetimeInput(choice).ok && choiceRisk(choice) === undefined) {
      remembered = choice;
    }
  },
  reset(): void {
    remembered = undefined;
  },
};

/**
 * Is this request's command RECOGNISED as read-only (machine-core `classifyReadOnly`, copied into machine-webcrypto: a whitelist of commands, forms and
 * characters, shell by shell)? The verdict only decides what the lifetime select starts from and shows a chip; it never allows anything. A row without a
 * shell or a command (a caller that has none) is not recognised.
 */
export function readOnlyVerdict(row: { shell?: string; command?: string }): ReadOnlyVerdict {
  return row.shell !== undefined && row.command !== undefined ? classifyReadOnly(row.shell, row.command) : { readOnly: false };
}

const PERMANENT_CHOICE: LifetimeChoice = { kind: 'permanent', customKind: 'duration', customText: '' };

/**
 * The lifetime the select of a card starts from: what the caller asked, else the limits of the entry a renewal replaces, else Permanent for a command
 * recognised as read-only (user rule 2026-11-22), else the last unflagged choice of the session, else Once.
 */
export function startChoiceOf(row: { shell?: string; command?: string; ask?: CallerAsk; renewal?: { maxCalls?: number; expiresAt?: number } }): LifetimeChoice {
  return (
    (row.ask !== undefined ? choiceFromAsk(row.ask) : undefined) ??
    (row.renewal !== undefined ? choiceFromLimits({ ...(row.renewal.maxCalls !== undefined ? { maxCalls: row.renewal.maxCalls } : {}), ...(row.renewal.expiresAt !== undefined ? { expiresAt: row.renewal.expiresAt } : {}) }) : undefined) ??
    (readOnlyVerdict(row).readOnly ? PERMANENT_CHOICE : undefined) ??
    remembered ?? { kind: 'once', customKind: 'duration', customText: '' }
  );
}

/**
 * The kind the dialog and the batch bar (ONE lifetime for every request they sign) start from: Permanent only when EVERY request is recognised as
 * read-only, else Once. One request that is not recognised makes the whole default the cautious one.
 */
export function readOnlyDefaultKind(rows: ReadonlyArray<{ shell?: string; command?: string }>): 'permanent' | 'once' {
  return rows.length > 0 && rows.every((r) => readOnlyVerdict(r).readOnly) ? 'permanent' : 'once';
}

/** The ONE grey line of a card (the long explanations are in its Details): the renewal, the caller's ask, a reported notice, a cut command. */
export function cardStatus(row: { shell: string; renewal?: { note: string }; ask?: CallerAsk; isNotice?: boolean; commandTruncated?: boolean }): string {
  const parts: string[] = [];
  if (row.renewal !== undefined) {
    parts.push(`Renewal: ${row.renewal.note}.`);
  }
  if (row.ask !== undefined && askSummary(row.ask) !== '') {
    parts.push(`Caller asked: ${askSummary(row.ask)}.`);
  }
  if (row.isNotice === true) {
    parts.push('Reported, not verified live.');
  }
  if (row.commandTruncated === true) {
    parts.push('Command truncated.');
  }
  return parts.join(' ');
}
