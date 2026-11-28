import React, { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Badge, ButtonAction, CompactSelect, HeaderActions, HorizontalStack, IconButton, Notice } from '@wadeck-app/dsl-ui';
import { Lock } from 'lucide-react';
import { adminKeyHolder, formatCountdown, KEEP_CHOICES, type KeepChoice } from '../lib/adminKeyHolder.js';

const KEEP_OPTIONS = KEEP_CHOICES.map((c) => ({ value: c.value, label: c.label }));
// The indicator exists once per page: while a pill is mounted, a bar (the dialogs and inline prompts) only says that no passphrase is needed.
let pillsMounted = 0;
const pillListeners = new Set<() => void>();
const pillsChanged = () => pillListeners.forEach((l) => l());
const subscribePills = (l: () => void) => {
  pillListeners.add(l);
  return () => void pillListeners.delete(l);
};
const hasPill = () => pillsMounted > 0;

const PILL_TIP = 'The admin key stays in this page only; it locks when the time runs out, on Lock, or on reload';
import { useAdminKey } from './useAdminKey.js';

// The badge of the held admin key (decision 92): "Admin key unlocked, locks in 4:32" and Lock now. Nothing at all while the key is locked. It reads the
// holder only; unmounting it (another page of the module) never locks the key.

export interface UnlockedKeyBarProps {
  /** `bar` (default): the boxed badge of a dialog. `chip`: one small chip "Key unlocked 4:32" with Lock, for the header of a page (shown once, not in every card). */
  variant?: 'bar' | 'chip';
}

export function UnlockedKeyBar({ variant = 'bar' }: UnlockedKeyBarProps) {
  const { unlocked, expiresAt, keep } = useAdminKey();
  const [now, setNow] = useState(() => Date.now());
  const pageHasPill = useSyncExternalStore(subscribePills, hasPill);
  const isPill = variant === 'chip';
  useEffect(() => {
    if (!isPill) {
      return undefined;
    }
    pillsMounted++;
    pillsChanged();
    return () => {
      pillsMounted--;
      pillsChanged();
    };
  }, [isPill]);

  // One tick per second, only while a key is held.
  useEffect(() => {
    if (!unlocked) {
      return undefined;
    }
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [unlocked, expiresAt]);

  // The pill tells a screen reader once that the key locked (the countdown itself is not announced).
  const wasUnlocked = useRef(false);
  const [lockedSinceMount, setLockedSinceMount] = useState(false);
  useEffect(() => {
    if (unlocked) {
      wasUnlocked.current = true;
      setLockedSinceMount(false);
    } else if (wasUnlocked.current) {
      wasUnlocked.current = false;
      setLockedSinceMount(true);
    }
  }, [unlocked]);

  if (!unlocked || expiresAt === null) {
    if (variant === 'chip' && lockedSinceMount) {
      return (
        <span role="status" aria-live="polite" className="sr-only">
          Admin key locked
        </span>
      );
    }
    return null;
  }
  if (variant === 'chip') {
    const remaining = expiresAt - now;
    // The pill lives in the header actions slot of the host (the breadcrumb row of app-core): no measuring, no fixed offset.
    return (
      <HeaderActions>
        <div data-testid="unlocked-key-chip" title={PILL_TIP}>
          <HorizontalStack gap="gap-2" align="items-center">
            <span role="status" aria-live="off">
              <Badge label={`Key unlocked ${formatCountdown(remaining)}`} variant={remaining < 60_000 ? 'warning' : 'success'} tone="subtle" size="sm" />
            </span>
            {/* The time the key stays unlocked after the last signature: a longer choice applies from now (the holder restarts the countdown). */}
            <CompactSelect ariaLabel="Keep unlocked for" size="sm" value={keep} onChange={(v) => adminKeyHolder.setKeep(v as KeepChoice)} options={KEEP_OPTIONS} />
            <IconButton icon={<Lock className="h-3 w-3" aria-hidden="true" />} aria-label="Lock" size="icon-xs" onClick={() => adminKeyHolder.lock()} />
          </HorizontalStack>
        </div>
      </HeaderActions>
    );
  }
  if (pageHasPill) {
    return <Notice variant="default" label="No passphrase needed: the admin key is unlocked in this page." />;
  }
  return (
    <div data-testid="unlocked-key-bar">
      <HorizontalStack gap="gap-2" align="items-center">
        <Notice variant="success" label={`Admin key unlocked, locks in ${formatCountdown(expiresAt - now)}`} />
        <ButtonAction label="Lock now" variant="secondary" size="sm" onClick={() => adminKeyHolder.lock()} />
      </HorizontalStack>
    </div>
  );
}
