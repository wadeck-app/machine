import React, { useEffect, useRef, useState } from 'react';
import { ButtonAction, FieldSecret, type FieldSecretHandle } from '@wadeck-app/dsl-ui';
import { lifetimeInput, lifetimeWords, type LifetimeChoice, type LifetimeResolution } from '../lib/lifetimeChoice.js';
import { NOTICE_WARNING, TEXT_ERROR } from '../lib/styleTokens.js';
import { LifetimePicker } from './LifetimePicker.js';
import { adminKeyHolder } from '../lib/adminKeyHolder.js';
import { KeepUnlockedSelect } from './KeepUnlockedSelect.js';
import { PassphraseHint } from './PassphraseHint.js';
import { useAdminKey } from './useAdminKey.js';

// The form of an Allow made in place (no modal): the lifetime, the key hint, the admin passphrase, one warning line, Allow and sign / Cancel. It is NOT a
// registry component (a view can never wire it): the passphrase it reads can only go to the code that renders it.
//
// Like ConfirmSignModal, the passphrase lives in the input element only: `onSubmit` receives `take`, which returns it ONCE and empties the field.
// While the admin key is unlocked in this page (decision 92) there is no field: one click signs and `take()` returns null.

export interface InlineAllowFormProps {
  /** Names the form for a screen reader (the group of requests it signs). */
  label: string;
  /** The one line that says what widens, given the lifetime in words (`lifetimeWords`). Absent with `fixedChoice` (the card says it in its Details). */
  warning?: (words: string) => React.ReactNode;
  /** The lifetime is decided OUTSIDE the form (the select of the card): no picker, no warning, the form is only the key. */
  fixedChoice?: LifetimeChoice;
  /** The hint of the admin key (readable without the passphrase), shown above the field. Absent: none is stored. */
  hint?: string | null | undefined;
  /** The lifetime preselected (a held request runs once). */
  defaultKind?: LifetimeChoice['kind'];
  /** The whole choice preselected (a renewal starts from the limits the entry had); wins over `defaultKind`. */
  defaultChoice?: LifetimeChoice;
  /** True while the signature is made: the controls are disabled. */
  busy?: boolean;
  /** The last failure with the way to proceed; the form keeps working. */
  error?: string | null;
  /** Called with the validated lifetime and `take`; an invalid lifetime never reaches it (the field says what to write). */
  onSubmit: (lifetime: Extract<LifetimeResolution, { ok: true }>, take: () => string | null) => void;
  onCancel: () => void;
  /** The text of the cancel button. */
  cancelLabel?: string;
}

export function InlineAllowForm({ label, warning, hint, defaultKind = 'once', defaultChoice, fixedChoice, busy = false, error = null, onSubmit, onCancel, cancelLabel = 'Cancel' }: InlineAllowFormProps) {
  const [choice, setChoice] = useState<LifetimeChoice>(defaultChoice ?? { kind: defaultKind, customKind: 'duration', customText: '' });
  const [localError, setLocalError] = useState<string | null>(null);
  const passphrase = useRef<FieldSecretHandle>(null);
  const { unlocked } = useAdminKey();

  // The form opens to be signed: the cursor is in the passphrase field (an Enter on an empty field signs nothing).
  useEffect(() => {
    passphrase.current?.focus();
  }, []);

  const resolution = lifetimeInput(fixedChoice ?? choice);
  const nowSeconds = Math.floor(Date.now() / 1000);
  const words = resolution.ok ? lifetimeWords(resolution.limits(nowSeconds), nowSeconds) : 'for the lifetime you enter';

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) {
      return;
    }
    // An invalid lifetime stops here, before the passphrase is taken: the field keeps what was typed and nothing is signed.
    if (!resolution.ok) {
      setLocalError(resolution.message);
      return;
    }
    if (adminKeyHolder.current() !== null) {
      setLocalError(null);
      onSubmit(resolution, () => null);
      return;
    }
    const field = passphrase.current;
    if (field === null || field.read() === '') {
      setLocalError('Enter the admin passphrase to sign. Nothing was signed.');
      return;
    }
    setLocalError(null);
    onSubmit(resolution, () => {
      const value = field.read();
      field.clear();
      return value;
    });
  };

  const shown = localError ?? error;
  return (
    <form
      aria-label={label}
      className="flex flex-col gap-2 border-t border-border pt-2"
      onSubmit={submit}
      onKeyDown={(e) => {
        if (e.key === 'Escape' && !busy) {
          e.stopPropagation();
          onCancel();
        }
      }}
    >
      {fixedChoice === undefined && <LifetimePicker choice={choice} onChange={setChoice} busy={busy} />}
      {fixedChoice === undefined && warning !== undefined && <p className={NOTICE_WARNING}>{warning(words)}</p>}
      {!unlocked && (
        <>
          {/* Same fixed username as the unlock form: the browser offers ONE saved login for the admin passphrase, never the app-core PIN. */}
          {/* violations-suppress: react/no-raw-input a fixed, read-only username for the browser's password manager, not a user input */}
          <input type="text" name="machine-admin-username" autoComplete="username" value="machine-admin" readOnly tabIndex={-1} aria-hidden="true" className="sr-only" />
          <PassphraseHint hint={hint} />
          <div className="flex flex-wrap items-end gap-3">
            <div className="min-w-48 flex-1">
              {/* FieldSecret is uncontrolled: the passphrase lives in its input only, read by take() and cleared at once. */}
              <FieldSecret ref={passphrase} label="Admin passphrase" name="machine-admin-passphrase" autoComplete="current-password" disabled={busy} />
            </div>
            <div className="w-40"><KeepUnlockedSelect busy={busy} /></div>
          </div>
        </>
      )}
      {shown !== null && <div role="alert" className={TEXT_ERROR}>{shown}</div>}
      <div className="flex justify-end gap-2">
        <ButtonAction label={cancelLabel} variant="secondary" size="sm" onClick={onCancel} disabled={busy} />
        <ButtonAction type="submit" label={busy ? 'Signing...' : 'Allow and sign'} variant="primary" size="sm" disabled={busy} />
      </div>
    </form>
  );
}
