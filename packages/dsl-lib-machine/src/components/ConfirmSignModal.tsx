import React, { useEffect, useRef } from 'react';
import { ButtonAction, Dialog, DialogFooter, FieldReadOnly, FieldSecret, HorizontalStack, Notice, VerticalStack, type FieldSecretHandle } from '@wadeck-app/dsl-ui';
import { adminKeyHolder } from '../lib/adminKeyHolder.js';
import { hintHelpText } from '../lib/passphraseHint.js';
import { KeepUnlockedSelect } from './KeepUnlockedSelect.js';
import { UnlockedKeyBar } from './UnlockedKeyBar.js';
import { useAdminKey } from './useAdminKey.js';

// A confirmation dialog that asks for the admin passphrase (decision 76), built on the standard Dialog of dsl-ui (focus trap, Escape, backdrop, "Close dialog"). Used by the buttons that widen rights (the Allow button of the Requests page;
// approve and revoke later). It is NOT a registry component on purpose (no @registryCategory): it can never be wired from a view, so the passphrase
// it reads can only go to the code that renders it.
//
// The passphrase lives in the input element only. `onConfirm` receives `take`, which returns it ONCE and empties the field at the same time, so the
// string exists only in the caller's local variable for the duration of one signature. It is never kept in state or a ref, and never shown.
//
// While the admin key is unlocked in this page (adminKeyHolder, decision 92) there is no passphrase field: the summary and the warning stay, one click
// signs, and `take()` returns null (the signing code then uses the held key).

export interface ConfirmSignModalProps {
  /** Plain text (the Dialog title is a string). */
  title: string;
  /** What is about to happen, as rows (machine, shell, exact command ...). Values are shown as given, in a monospace read-only field. */
  details: Array<{ label: string; value: string }>;
  /** Why this needs care (what it widens). Shown above the passphrase field. */
  warning: string;
  /** Free text under the details (version change, who is not affected ...). */
  notes?: string[];
  confirmLabel: string;
  /** True while the signature is made: the buttons are disabled. */
  busy?: boolean;
  /** What the disabled confirm button says while `busy` (default "Signing..."). */
  busyLabel?: string;
  /** A side column INSIDE the dialog (the timeline of an approval), so the progress stays visible while the dialog hides the page. Absent: no column. */
  aside?: React.ReactNode;
  /** The last failure, shown in the dialog with the way to proceed. */
  error?: string | null;
  /** Extra controls under the notes (the lifetime choice of the Allow dialog). They are not part of the passphrase form. */
  children?: React.ReactNode;
  /** The hint of the admin key (readable without the passphrase), shown above the field. Absent: none is stored. */
  hint?: string | null;
  /** False: nothing to sign (already allowed, load failure): the dialog only informs, with a Close button. */
  needsPassphrase?: boolean;
  /**
   * True: the passphrase is asked at EVERY confirmation, whatever the holder keeps: no "Keep unlocked for", no unlocked bar, no one-click signing, and `take()` never
   * returns null. For the actions whose key must never outlive the one signature (approving a machine, decision of #146: no unlock window).
   */
  askEveryTime?: boolean;
  /** Called with `take` when the person confirms; `take()` returns the typed passphrase and empties the field, or null when the admin key is unlocked in this page (no passphrase then). */
  onConfirm: (take: () => string | null) => void;
  onCancel: () => void;
}

/** What the core says when the key cannot be unlocked (machine-webcrypto adminKey.ts): the same message for a wrong passphrase and a damaged file. */
const WRONG_PASSPHRASE = /wrong passphrase or damaged key file/;

/** The message the dialog shows: a wrong passphrase says what to do first (nothing was signed, retype), the message of the core follows as the detail. */
function shownMessage(message: string): string {
  return WRONG_PASSPHRASE.test(message) ? `Nothing was signed. Retype the passphrase. Detail: ${message}` : message;
}

export function ConfirmSignModal({ title, details, warning, notes = [], confirmLabel, busy = false, busyLabel = 'Signing...', aside, error = null, hint = null, needsPassphrase = true, askEveryTime = false, children, onConfirm, onCancel }: ConfirmSignModalProps) {
  const passphrase = useRef<FieldSecretHandle>(null);
  const [localError, setLocalError] = React.useState<string | null>(null);
  const held = useAdminKey().unlocked;
  const unlocked = held && !askEveryTime;

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) {
      return;
    }
    // Unlocked: nothing to type. The key is read again at signing time; an expiry in between is said by the signing code, with the fix.
    if (!askEveryTime && adminKeyHolder.current() !== null) {
      setLocalError(null);
      onConfirm(() => null);
      return;
    }
    const field = passphrase.current;
    if (field === null || field.read() === '') {
      setLocalError('Enter the admin passphrase to sign. Nothing was signed.');
      return;
    }
    setLocalError(null);
    onConfirm(() => {
      const value = field.read();
      field.clear();
      return value;
    });
  };

  const shown = localError ?? error;
  // An error (wrong passphrase, empty field) puts the focus back where the person retypes: the field is inert while busy, so this runs once it is usable again.
  useEffect(() => {
    if (shown !== null && !busy) {
      passphrase.current?.focus();
    }
  }, [shown, busy]);
  const content = (
    <div>
      <VerticalStack gap="gap-3">
        {details.map(d => (
          <FieldReadOnly key={d.label} label={d.label} value={d.value} mono />
        ))}
        {notes.map((n, i) => (
          <Notice key={i} variant="default" label={n} />
        ))}
        {children}
        {needsPassphrase && warning !== '' && <Notice variant="warning" label={warning} />}
        <form onSubmit={submit}>
          <VerticalStack gap="gap-3">
            {needsPassphrase && unlocked && <UnlockedKeyBar />}
            {needsPassphrase && !unlocked && (
              <>
                {/* Same fixed username as the unlock form: the browser offers ONE saved login for the admin passphrase, never the app-core PIN. */}
                {/* violations-suppress: react/no-raw-input a fixed, read-only username for the browser's password manager, not a user input */}
                <input type="text" name="machine-admin-username" autoComplete="username" value="machine-admin" readOnly tabIndex={-1} aria-hidden="true" className="sr-only" />
                {/* FieldSecret is uncontrolled: the passphrase lives in its input only, read by take() and cleared at once. */}
                <FieldSecret ref={passphrase} id="machine-admin-passphrase" label="Admin passphrase" {...hintHelpText(hint)} name="machine-admin-passphrase" autoComplete="current-password" disabled={busy} />
                {!askEveryTime && <KeepUnlockedSelect busy={busy} />}
              </>
            )}
            {shown !== null && <Notice variant="danger" label={shownMessage(shown)} />}
            <DialogFooter>
              {/* Cancel is the default focus (autoFocus): Enter without thinking must never sign. */}
              <ButtonAction label={needsPassphrase ? 'Cancel' : 'Close'} variant="secondary" onClick={onCancel} disabled={busy} autoFocus />
              {needsPassphrase && <ButtonAction type="submit" label={busy ? busyLabel : confirmLabel} variant="primary" disabled={busy} />}
            </DialogFooter>
          </VerticalStack>
        </form>
      </VerticalStack>
    </div>
  );
  return (
    <Dialog
      // The Dialog takes its initial focus (the button marked autoFocus) when it opens only: a new key opens it again when it turns informational (the result view), so the focus
      // goes to Close instead of falling to the page body when the confirm button, which had it, goes away.
      key={needsPassphrase ? 'asks' : 'informs'}
      open
      title={title}
      size={aside === undefined ? 'lg' : 'xl'}
      // Escape, the cross and the backdrop ask to close: not while the signature is made (the buttons are off too).
      onOpenChange={(open) => {
        if (!open && !busy) {
          onCancel();
        }
      }}
    >
      {aside === undefined ? (
        content
      ) : (
        <HorizontalStack gap="gap-4" align="items-start" itemSizes={['fixed', 'flex']}>
          <div data-part="aside">{aside}</div>
          {content}
        </HorizontalStack>
      )}
    </Dialog>
  );
}
