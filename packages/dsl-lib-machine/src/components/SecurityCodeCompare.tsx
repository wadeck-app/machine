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
}

export function SecurityCodeCompare({ code, name, onMatch, onDiffer, answered = false }: SecurityCodeCompareProps) {
  const asking = onMatch !== undefined && onDiffer !== undefined;
  return (
    <div className="flex flex-col gap-2">
      <div aria-label="Security code" role="group" style={MONO_STYLE} className="text-3xl font-semibold tracking-wider text-content">
        {code}
      </div>
      <p className="text-sm">
        It must read exactly the same on {name}.{asking ? ' "Codes match" only records your comparison on this page: the' : ' The'} decisive confirmation is made on {name}, where <Text mono text="machine join" /> shows its own code and asks you to confirm it.
      </p>
      {asking && !answered && (
        <div className="flex flex-wrap gap-2">
          <ButtonAction label="Codes match" variant="primary" onClick={onMatch} />
          <ButtonAction label="Codes differ" variant="danger-outline" onClick={onDiffer} />
        </div>
      )}
    </div>
  );
}
