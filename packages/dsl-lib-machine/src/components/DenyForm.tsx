import React, { useState } from 'react';
import { ButtonAction, FieldText } from '@wadeck-app/dsl-ui';
import type { AllowApi } from '../lib/allowFlow.js';
import { TEXT_ERROR } from '../lib/styleTokens.js';

/** The limits of machine-core's checkDenyReason: the agent reads the reason and the audit log keeps it. */
export const REASON_MAX = 200;

/** Why a reason cannot be sent (the same words as the daemon), undefined when it can. */
export function reasonProblem(text: string): string | undefined {
  const trimmed = text.trim();
  if (trimmed.length > REASON_MAX) {
    return `the reason has ${trimmed.length} characters: at most ${REASON_MAX} (the agent reads it); shorten it`;
  }
  if (!/^[\x20-\x7e]*$/.test(trimmed)) {
    return 'the reason must be printable ASCII (no accent, no line break): the agent reads it and the audit log keeps it; rewrite it';
  }
  return undefined;
}

/**
 * The sentence shown when a Deny fails for the PIN: the PIN dialog was cancelled, or the sensitive route answered 401 elevation-required / 403 pin-not-set
 * (the shell normally handles both, so this is the fallback). The original text stays; the fix is added. Other errors are returned unchanged.
 */
export function denyFailureMessage(err: unknown): string {
  // violations-suppress: ts/no-err-message-direct getErrorMessage is not exported by the entry of dsl-renderer or dsl-ui: the fetcher rejects with an Error that carries the daemon's sentence
  const text = err instanceof Error ? err.message : String(err);
  if (/pin-not-set|pin not set/i.test(text)) {
    return `${text}. Deny needs the app-core PIN and none is chosen yet: run "app-core-cli pin set" (or choose one in the dashboard), then press Confirm deny again`;
  }
  if (/PIN not entered|elevation-required|\b401\b/i.test(text)) {
    return `${text}. Deny needs the app-core PIN (it answers a waiting caller): enter the app-core PIN, then press Confirm deny again`;
  }
  return text;
}

export interface DenyFormProps {
  /** The id of the held request. */
  id: string;
  api: AllowApi;
  onCancel: () => void;
  onDenied: () => void;
}

/** The inline Deny form of a held request: an optional reason for the caller. A restricting action: no signature and no passphrase, but the route is sensitive, so the app-core PIN is asked first (as for Allow). */
export function DenyForm({ id, api, onCancel, onDenied }: DenyFormProps) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    const problem = reasonProblem(reason);
    if (problem !== undefined) {
      setError(problem);
      return;
    }
    setBusy(true);
    setError(null);
    const trimmed = reason.trim();
    // The PIN first, like the Allow dialog (loadContext): a cancelled dialog stops here and nothing is posted.
    api.elevate().then(() => api.post('/deny', trimmed === '' ? { id } : { id, reason: trimmed })).then(
      () => onDenied(),
      (err: unknown) => {
        setBusy(false);
        setError(denyFailureMessage(err));
      },
    );
  };

  return (
    <form className="flex flex-col gap-2" onSubmit={submit}>
      <FieldText label="Reason for the caller (optional)" description={`Shown to the agent and kept in the audit log: printable ASCII, at most ${REASON_MAX} characters, nothing secret.`} name="machine-deny-reason" autoComplete="off" maxLength={REASON_MAX} value={reason} disabled={busy} onChange={setReason} />
      {error !== null && <div role="alert" className={TEXT_ERROR}>{error}</div>}
      <div className="flex gap-2">
        <ButtonAction type="submit" label="Confirm deny" variant="danger" size="sm" disabled={busy} />
        <ButtonAction label="Cancel" variant="secondary" size="sm" onClick={onCancel} disabled={busy} />
      </div>
    </form>
  );
}
