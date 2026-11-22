import React from 'react';
import { TEXT_MUTED } from '../lib/styleTokens.js';
import { CallerAskNote } from './CallerAskNote.js';
import type { HeldRequestRow } from './HeldRequests.js';
import { MachineName } from './MachineName.js';

// The Details panel of a held card: every fact and every long sentence the card leaves out of its one status line.

export interface HeldDetailsProps {
  row: HeldRequestRow;
  /** The machine Allow signs for; absent when Allow is not offered. */
  machine: { name: string } | undefined;
  /** The chosen lifetime in words (`lifetimeWords`). */
  words: string;
}

export function HeldDetails({ row, machine, words }: HeldDetailsProps) {
  return (
    <div data-testid="held-details" className={`flex flex-col gap-1 text-xs ${TEXT_MUTED}`}>
      {row.renewal !== undefined && (
        <div data-testid="renewal-note">
          Renewal: {row.renewal.note}. Allowing it replaces {row.shell} {JSON.stringify(row.renewal.entry)} (its counter starts again), it does not add a command.
        </div>
      )}
      {row.commandTruncated === true && <div>Truncated: only the first part of the command was reported.</div>}
      {row.ask !== undefined && <CallerAskNote ask={row.ask} where="card" warning={false} />}
      {row.note !== undefined && <div data-testid="notice-note">{row.note}</div>}
      {machine !== undefined && (
        <div data-testid="held-widening">
          {row.renewal === undefined ? (
            <>
              Widens rights: every trusted peer may run this on <MachineName name={machine.name} />, byte for byte, {words}.
            </>
          ) : (
            <>
              Renews {row.shell} {JSON.stringify(row.renewal.entry)} on <MachineName name={machine.name} /> (the used up or expired entry is replaced, its counter starts again), {words}.
            </>
          )}
        </div>
      )}
      <div>
        Once: the command runs once, then the next identical request is refused (or held) again. A permanent lifetime, 50 calls or more, or more than 7 days is flagged: with the admin key unlocked it is signed only after a second click.
      </div>
    </div>
  );
}
