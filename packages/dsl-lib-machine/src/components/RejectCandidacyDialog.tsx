import React from 'react';
import { ButtonAction, Dialog, DialogFooter } from '@wadeck-app/dsl-ui';
import { CodeText } from './CommandNotice.js';

// The confirmation of a rejection: a standard Dialog that NAMES the machine ("Reject mac-m2?"), with the consequence and a Reject button of the same name. It replaces the
// generic "Please confirm" of the page action, whose text cannot say which machine it is about. A rejection only restricts (hard rule 4): no signature, no passphrase.

export interface RejectCandidacyDialogProps {
  /** The name the candidate chose for itself. */
  name: string;
  /** The person confirmed: the page action runs. */
  onConfirm: () => void;
  /** Cancel, Escape, the cross or the backdrop. */
  onCancel: () => void;
}

export function RejectCandidacyDialog({ name, onConfirm, onCancel }: RejectCandidacyDialogProps) {
  return (
    <Dialog open title={`Reject ${name}?`} size="md" onOpenChange={(open) => (open ? undefined : onCancel())}>
      <p className="m-0 text-sm">
        <CodeText text={`${name} is refused and must post a new candidacy to ask again (\`machine join --resume\` on it).`} />
      </p>
      <DialogFooter>
        {/* Cancel is the default focus (autoFocus): Enter without thinking must never reject. */}
        <ButtonAction label="Cancel" variant="secondary" onClick={onCancel} autoFocus />
        <ButtonAction label="Reject" variant="danger" onClick={onConfirm} />
      </DialogFooter>
    </Dialog>
  );
}
