import React from 'react';
import { ButtonAction, Text } from '@wadeck-app/dsl-ui';
import { MONO_STYLE } from '../lib/styleTokens.js';

// The security code of ONE approval (decision 55: 25 digits in five groups), first and large, with what to do with it. It is shown from the code the page computed while
// signing, or read again later from the one kept by the module (the relay purges the candidacy random once approved, so it cannot be recomputed). Only public values.

export interface SecurityCodeCompareProps {
  /** Five groups of five digits, shown as given. */
  code: string;
  /** The candidate machine: where the same code must be read. */
  name: string;
  /** Pressed when both machines show the same code. Absent (together with `onDiffer`): the code is only shown, with no button. */
  onMatch?: () => void;
  onDiffer?: () => void;
  /** The person already answered: no button any more. */
  answered?: boolean;
  /** Why the comparison is not offered yet (the documents are not delivered): no button, this one line instead. The code stays readable. */
  heldBack?: string;
}

/** The five groups of the code, or null when it is not in that shape (it is then shown as it is). */
function groupsOf(code: string): string[] | null {
  const groups = code.split(' ');
  return groups.length === 5 && groups.every((g) => /^\d{5}$/.test(g)) ? groups : null;
}

export function SecurityCodeCompare({ code, name, onMatch, onDiffer, answered = false, heldBack }: SecurityCodeCompareProps) {
  const asking = onMatch !== undefined && onDiffer !== undefined && heldBack === undefined;
  const groups = groupsOf(code);
  return (
    <div className="flex flex-col gap-2">
      {groups === null ? (
        <div aria-label="Security code" role="group" style={MONO_STYLE} className="text-2xl font-semibold tracking-wider text-content">
          {code}
        </div>
      ) : (
        // Five columns: a group is never cut and the line never breaks 20 + 5, whatever the width of the dialog.
        <div aria-label="Security code" role="group" style={MONO_STYLE} className="grid grid-cols-5 gap-x-3 text-2xl font-semibold text-content">
          {groups.map((g, i) => (
            <React.Fragment key={i}>
              {i > 0 && ' '}
              <span className="whitespace-nowrap">{g}</span>
            </React.Fragment>
          ))}
        </div>
      )}
      <p className="text-sm">
        It must read exactly the same on {name}.{asking ? ' "Codes match" only records your comparison on this page: the' : ' The'} decisive confirmation is made on {name}, where <Text mono text="machine join" /> shows its own code and asks you to confirm it.
      </p>
      {heldBack !== undefined && <p className="m-0 text-sm"><Text tone="muted" text={heldBack} /></p>}
      {asking && !answered && (
        <div className="flex flex-wrap gap-2">
          <ButtonAction label="Codes match" variant="primary" onClick={onMatch} />
          <ButtonAction label="Codes differ" variant="danger-outline" onClick={onDiffer} />
        </div>
      )}
    </div>
  );
}
