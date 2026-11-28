import React from 'react';
import { Text } from '@wadeck-app/dsl-ui';

// The rows of a folded "Details" in a dialog: a label and its value in monospace (UX review 5). The standard FieldReadOnly breaks a value at ANY character (`break-all`:
// "they f/ollow", "an al/ias"): here a value wraps at its spaces and one long token (a uuid, a key id) stays whole. Nothing to copy or edit: a description list.

export interface DetailRow {
  label: string;
  value: string;
}

export function DetailRows({ rows }: { rows: DetailRow[] }) {
  if (rows.length === 0) {
    return null;
  }
  return (
    <dl className="m-0 flex flex-col gap-2">
      {rows.map((r) => (
        <div key={r.label} className="flex flex-col gap-0.5">
          <dt className="text-xs text-muted">{r.label}</dt>
          <dd className="m-0 break-normal">
            <Text mono size="sm" text={r.value} />
          </dd>
        </div>
      ))}
    </dl>
  );
}
