import React from 'react';
import { FieldSelect } from '@wadeck-app/dsl-ui';
import { adminKeyHolder, KEEP_CHOICES, type KeepChoice } from '../lib/adminKeyHolder.js';
import { useAdminKey } from './useAdminKey.js';

// "Keep unlocked for [5 min v]": how long the admin key stays unlocked in this page after the passphrase (decision 92). The choice is kept in memory only.

const OPTIONS = KEEP_CHOICES.map((c) => ({ value: c.value, label: c.label }));

export function KeepUnlockedSelect({ busy = false }: { busy?: boolean }) {
  const { keep } = useAdminKey();
  return <FieldSelect label="Keep unlocked for" value={keep} onChange={(v) => adminKeyHolder.setKeep(v as KeepChoice)} options={OPTIONS} disabled={busy} />;
}
