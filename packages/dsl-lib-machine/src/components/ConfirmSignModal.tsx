import React, { useEffect, useId, useRef } from 'react';
import { ButtonAction } from '@wadeck-app/dsl-ui';
import { INPUT, MODAL_BACKDROP, MODAL_PANEL, NOTICE_WARNING, TEXT_ERROR, TEXT_MUTED, TEXT_MUTED_SM } from '../lib/styleTokens.js';

// A confirmation dialog that asks for the admin passphrase (decision 76). Used by the buttons that widen rights (the Allow button of the Requests page;
// approve and revoke later). It is NOT a registry component on purpose (no @registryCategory): it can never be wired from a view, so the passphrase
// it reads can only go to the code that renders it.
//
// The passphrase lives in the input element only. `onConfirm` receives `take`, which returns it ONCE and empties the field at the same time, so the
// string exists only in the caller's local variable for the duration of one signature. It is never kept in state or a ref, and never shown.

export interface ConfirmSignModalProps {
  title: string;
  /** What is about to happen, as rows (machine, shell, exact command ...). Values are shown as given, in a monospace font. */
  details: Array<{ label: string; value: string }>;
  /** Why this needs care (what it widens). Shown above the passphrase field. */
  warning: string;
  /** Free text under the details (version change, who is not affected ...). */
  notes?: string[];
  confirmLabel: string;
  /** True while the signature is made: the buttons are disabled. */
  busy?: boolean;
  /** The last failure, shown in the dialog with the way to proceed. */
  error?: string | null;
  /** False: nothing to sign (already allowed, load failure): the dialog only informs, with a Close button. */
  needsPassphrase?: boolean;
  /** Called with `take` when the person confirms; `take()` returns the typed passphrase and empties the field. */
  onConfirm: (take: () => string) => void;
  onCancel: () => void;
}

const FOCUSABLE = 'button:not([disabled]), input:not([disabled]), [href], [tabindex]:not([tabindex="-1"])';

export function ConfirmSignModal({ title, details, warning, notes = [], confirmLabel, busy = false, error = null, needsPassphrase = true, onConfirm, onCancel }: ConfirmSignModalProps) {
  const titleId = useId();
  const root = useRef<HTMLDivElement>(null);
  const passphrase = useRef<HTMLInputElement>(null);
  const [localError, setLocalError] = React.useState<string | null>(null);

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
              <dd className="break-all font-mono">{d.value}</dd>
            </React.Fragment>
          ))}
        </dl>
        {notes.map(n => (
          <p key={n} className={TEXT_MUTED_SM}>{n}</p>
        ))}
        {needsPassphrase && <p className={NOTICE_WARNING}>{warning}</p>}
        <form className="flex flex-col gap-3" onSubmit={submit}>
          {needsPassphrase && (
            <label className="flex flex-col gap-1 text-sm">
              Admin passphrase
              {/* violations-suppress: react/no-raw-input the passphrase must live only in this uncontrolled element (read and emptied by take()); FieldText keeps its value in React state, which the passphrase rule forbids */}
              <input ref={passphrase} type="password" autoComplete="off" disabled={busy} className={INPUT} />
            </label>
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
