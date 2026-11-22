import React from 'react';
import { askRisk, askSummary, type CallerAsk } from '../lib/callerAsk.js';
import { NOTICE_NEUTRAL, NOTICE_WARNING } from '../lib/styleTokens.js';

export interface CallerAskNoteProps {
  ask: CallerAsk;
  /** `card`: under the command of a held request; `dialog`: in the Allow dialog, where the lifetime selector starts from it. */
  where: 'card' | 'dialog';
  /** Show the warning line for a risky ask. The card flags it by a badge BEFORE the click and leaves it out of its Details. Default true. */
  warning?: boolean;
}

/**
 * What the CALLER of `machine run` asked the owner for (decision 96), apart from anything the owner decides. UNTRUSTED text: only text nodes, never markup
 * (T-42). A permanent or large ask gets a warning with one line saying it was the caller's wish: the pre-filled lifetime must not be rubber-stamped.
 * Nothing here is applied: the owner edits the lifetime and signs.
 */
export function CallerAskNote({ ask, where, warning = true }: CallerAskNoteProps) {
  const risk = askRisk(ask);
  return (
    <div className="flex flex-col gap-1">
      <div data-testid="caller-ask" className={NOTICE_NEUTRAL}>
        <span className="font-semibold">{where === 'dialog' ? 'Requested by the caller' : 'Requested by the caller (not your decision)'}</span>: {askSummary(ask)}.{' '}
        {where === 'card' ? 'Allow starts from it and you can change it; nothing is applied until you sign.' : 'The lifetime below starts from it: change it if you want another.'}
      </div>
      {warning && risk !== undefined && (
        <div data-testid="caller-ask-warning" role="note" className={NOTICE_WARNING}>
          Warning: {risk} was asked by the caller, not decided by you. Check it before you sign.
        </div>
      )}
    </div>
  );
}
