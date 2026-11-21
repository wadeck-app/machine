import React from 'react';
import { PASSPHRASE_HINT, PASSPHRASE_HINT_LABEL } from '../lib/styleTokens.js';

// The hint the admin wrote when the key was created (decision 57). Stored in clear in the key file, so it is shown BEFORE the passphrase is typed;
// it is not a secret. Text only (a hint is never interpreted as markup). No hint: no element at all.

export function PassphraseHint({ hint }: { hint?: string | null | undefined }) {
  if (hint === undefined || hint === null || hint === '') {
    return null;
  }
  return (
    <p data-testid="passphrase-hint" className={PASSPHRASE_HINT}>
      <span className={PASSPHRASE_HINT_LABEL}>Hint:</span> {hint}
    </p>
  );
}
