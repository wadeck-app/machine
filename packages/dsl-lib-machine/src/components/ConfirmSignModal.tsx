import React, { useEffect, useId, useRef } from 'react';
import { ButtonAction } from '@wadeck-app/dsl-ui';
import { adminKeyHolder } from '../lib/adminKeyHolder.js';
import { KeepUnlockedSelect } from './KeepUnlockedSelect.js';
import { PassphraseHint } from './PassphraseHint.js';
import { UnlockedKeyBar } from './UnlockedKeyBar.js';
import { useAdminKey } from './useAdminKey.js';
import { INPUT, MODAL_BACKDROP, MODAL_PANEL, MONO_STYLE, NOTICE_WARNING, TEXT_ERROR, TEXT_MUTED, TEXT_MUTED_SM } from '../lib/styleTokens.js';

// A confirmation dialog that asks for the admin passphrase (decision 76). Used by the buttons that widen rights (the Allow button of the Requests page;
// approve and revoke later). It is NOT a registry component on purpose (no @registryCategory): it can never be wired from a view, so the passphrase
// it reads can only go to the code that renders it.
//
// The passphrase lives in the input element only. `onConfirm` receives `take`, which returns it ONCE and empties the field at the same time, so the
// string exists only in the caller's local variable for the duration of one signature. It is never kept in state or a ref, and never shown.
//
// While the admin key is unlocked in this page (adminKeyHolder, decision 92) there is no passphrase field: the summary and the warning stay, one click
// signs, and `take()` returns null (the signing code then uses the held key).

export interface ConfirmSignModalProps {
  /** Text, or text with machine names (MachineName). */
  title: React.ReactNode;
  /** What is about to happen, as rows (machine, shell, exact command ...). Values are shown as given, in a monospace font. */
  details: Array<{ label: string; value: React.ReactNode }>;
  /** Why this needs care (what it widens). Shown above the passphrase field. */
  warning: React.ReactNode;
  /** Free text under the details (version change, who is not affected ...). */
  notes?: React.ReactNode[];
  confirmLabel: string;
  /** True while the signature is made: the buttons are disabled. */
  busy?: boolean;
  /** The last failure, shown in the dialog with the way to proceed. */
  error?: string | null;
  /** Extra controls under the notes (the lifetime choice of the Allow dialog). They are not part of the passphrase form. */
  children?: React.ReactNode;
  /** The hint of the admin key (readable without the passphrase), shown above the field. Absent: none is stored. */
  hint?: string | null;
  /** False: nothing to sign (already allowed, load failure): the dialog only informs, with a Close button. */
  needsPassphrase?: boolean;
  /** Called with `take` when the person confirms; `take()` returns the typed passphrase and empties the field, or null when the admin key is unlocked in this page (no passphrase then). */
  onConfirm: (take: () => string | null) => void;
  onCancel: () => void;
}

const FOCUSABLE = 'button:not([disabled]), input:not([disabled]), select:not([disabled]), [href], [tabindex]:not([tabindex="-1"])';

export function ConfirmSignModal({ title, details, warning, notes = [], confirmLabel, busy = false, error = null, hint = null, needsPassphrase = true, children, onConfirm, onCancel }: ConfirmSignModalProps) {
  const titleId = useId();
  const root = useRef<HTMLDivElement>(null);
  const passphrase = useRef<HTMLInputElement>(null);
  const [localError, setLocalError] = React.useState<string | null>(null);
  const { unlocked } = useAdminKey();

  // Cancel is the default focus: Enter without thinking must never sign.
  useEffect(() => {
    root.current?.querySelector<HTMLElement>('[data-footer] button')?.focus();
  }, []);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape' && !busy) {
      e.stopPropagation();
      onCancel();
      return;
    }
    if (e.key !== 'Tab' || root.current === null) {
      return;
    }
    const items = Array.from(root.current.querySelectorAll<HTMLElement>(FOCUSABLE));
    if (items.length === 0) {
      return;
    }
    const first = items[0] as HTMLElement;
    const last = items[items.length - 1] as HTMLElement;
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  };

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) {
      return;
    }
    // Unlocked: nothing to type. The key is read again at signing time; an expiry in between is said by the signing code, with the fix.
    if (adminKeyHolder.current() !== null) {
      setLocalError(null);
      onConfirm(() => null);
      return;
    }
    const input = passphrase.current;
    if (input === null || input.value === '') {
      setLocalError('Enter the admin passphrase to sign. Nothing was signed.');
      return;
    }
    setLocalError(null);
    onConfirm(() => {
      const value = input.value;
      input.value = '';
      return value;
    });
  };

  const shown = localError ?? error;
  return (
    <div className={MODAL_BACKDROP} onKeyDown={onKeyDown}>
      <div ref={root} role="dialog" aria-modal="true" aria-labelledby={titleId} className={MODAL_PANEL}>
        <h2 id={titleId} className="text-lg font-semibold text-content">{title}</h2>
        <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-sm">
          {details.map(d => (
            <React.Fragment key={d.label}>
              <dt className={TEXT_MUTED}>{d.label}</dt>
              <dd className="break-all" style={MONO_STYLE}>{d.value}</dd>
            </React.Fragment>
          ))}
        </dl>
        {notes.map((n, i) => (
          <p key={i} className={TEXT_MUTED_SM}>{n}</p>
        ))}
        {children}
        {needsPassphrase && <p className={NOTICE_WARNING}>{warning}</p>}
        <form className="flex flex-col gap-3" onSubmit={submit}>
          {needsPassphrase && unlocked && <UnlockedKeyBar />}
          {needsPassphrase && !unlocked && (
            <>
              {/* Same fixed username as the unlock form: the browser offers ONE saved login for the admin passphrase, never the app-core PIN. */}
              {/* violations-suppress: react/no-raw-input a fixed, read-only username for the browser's password manager, not a user input */}
              <input type="text" name="machine-admin-username" autoComplete="username" value="machine-admin" readOnly tabIndex={-1} aria-hidden="true" className="sr-only" />
              <PassphraseHint hint={hint} />
              <div className="flex flex-wrap items-end gap-3">
                <label className="flex min-w-48 flex-1 flex-col gap-1 text-sm">
                  Admin passphrase
                  {/* violations-suppress: react/no-raw-input the passphrase must live only in this uncontrolled element (read and emptied by take()); FieldText keeps its value in React state, which the passphrase rule forbids */}
                  <input ref={passphrase} type="password" name="machine-admin-passphrase" id="machine-admin-passphrase-confirm" autoComplete="current-password" disabled={busy} className={INPUT} />
                </label>
              <div className="w-40"><KeepUnlockedSelect busy={busy} /></div>
              </div>
            </>
          )}
          {shown !== null && <div role="alert" className={TEXT_ERROR}>{shown}</div>}
          <div data-footer="" className="flex justify-end gap-2">
            <ButtonAction label={needsPassphrase ? 'Cancel' : 'Close'} variant="secondary" onClick={onCancel} disabled={busy} />
            {needsPassphrase && <ButtonAction type="submit" label={busy ? 'Signing...' : confirmLabel} variant="primary" disabled={busy} />}
          </div>
        </form>
      </div>
    </div>
  );
}
