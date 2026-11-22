import React, { useEffect, useState } from 'react';
import { ButtonAction } from '@wadeck-app/dsl-ui';
import { adminKeyHolder, formatCountdown } from '../lib/adminKeyHolder.js';
import { NOTICE_SUCCESS } from '../lib/styleTokens.js';
import { useAdminKey } from './useAdminKey.js';

// The badge of the held admin key (decision 92): "Admin key unlocked, locks in 4:32" and Lock now. Nothing at all while the key is locked. It reads the
// holder only; unmounting it (another page of the module) never locks the key.

export function UnlockedKeyBar() {
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
  return (
    <div data-testid="unlocked-key-bar" className={`flex flex-wrap items-center justify-between gap-2 ${NOTICE_SUCCESS}`}>
      <span>{`Admin key unlocked, locks in ${formatCountdown(expiresAt - now)}`}</span>
      <ButtonAction label="Lock now" variant="secondary" size="sm" onClick={() => adminKeyHolder.lock()} />
    </div>
  );
}
