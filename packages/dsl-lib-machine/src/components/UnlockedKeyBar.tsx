import React, { useEffect, useState } from 'react';
import { ButtonAction } from '@wadeck-app/dsl-ui';
import { adminKeyHolder, formatCountdown } from '../lib/adminKeyHolder.js';
import { CHIP_SUCCESS, NOTICE_SUCCESS } from '../lib/styleTokens.js';
import { useAdminKey } from './useAdminKey.js';

// The badge of the held admin key (decision 92): "Admin key unlocked, locks in 4:32" and Lock now. Nothing at all while the key is locked. It reads the
// holder only; unmounting it (another page of the module) never locks the key.

export interface UnlockedKeyBarProps {
  /** `bar` (default): the boxed badge of a dialog. `chip`: one small chip "Key unlocked 4:32" with Lock, for the header of a page (shown once, not in every card). */
  variant?: 'bar' | 'chip';
}

export function UnlockedKeyBar({ variant = 'bar' }: UnlockedKeyBarProps) {
  const { unlocked, expiresAt } = useAdminKey();
  const [now, setNow] = useState(() => Date.now());

  // One tick per second, only while a key is held.
  useEffect(() => {
    if (!unlocked) {
      return undefined;
    }
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [unlocked, expiresAt]);

  if (!unlocked || expiresAt === null) {
    return null;
  }
  if (variant === 'chip') {
    return (
      <div data-testid="unlocked-key-chip" className={CHIP_SUCCESS}>
        <span>{`Key unlocked ${formatCountdown(expiresAt - now)}`}</span>
        <ButtonAction label="Lock" variant="secondary" size="sm" onClick={() => adminKeyHolder.lock()} />
      </div>
    );
  }
  return (
    <div data-testid="unlocked-key-bar" className={`flex flex-wrap items-center justify-between gap-2 ${NOTICE_SUCCESS}`}>
      <span>{`Admin key unlocked, locks in ${formatCountdown(expiresAt - now)}`}</span>
      <ButtonAction label="Lock now" variant="secondary" size="sm" onClick={() => adminKeyHolder.lock()} />
    </div>
  );
}
