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

export interface DenyFormProps {
  /** The id of the held request. */
  id: string;
  api: AllowApi;
  onCancel: () => void;
  onDenied: () => void;
}

/** The inline Deny form of a held request: an optional reason for the caller. A restricting action: no PIN, no signature, no passphrase. */
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
    api.post('/deny', trimmed === '' ? { id } : { id, reason: trimmed }).then(
      () => onDenied(),
      (err: unknown) => {
        setBusy(false);
        // violations-suppress: ts/no-err-message-direct getErrorMessage is not exported by the entry of dsl-renderer or dsl-ui: the fetcher rejects with an Error that carries the daemon's sentence
        setError(err instanceof Error ? err.message : String(err));
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
