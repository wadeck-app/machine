import React, { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { ButtonAction, CompactSelect } from '@wadeck-app/dsl-ui';
import { adminKeyHolder, formatCountdown, KEEP_CHOICES, type KeepChoice } from '../lib/adminKeyHolder.js';
import { KEY_PILL, NOTICE_SUCCESS, TEXT_MUTED_SM } from '../lib/styleTokens.js';

const PILL = KEY_PILL;
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

// Height of the pill in px (text-xs line 16 + py-1 8 + border 2), used to centre it on a row.
const PILL_HEIGHT = 26;
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

  // The pill (chip variant) is fixed, so it takes no room in the flow. Its vertical place follows the title row of the page (the first h1, rendered by
  // app-core) and, once the title scrolled away, stays on the breadcrumb row, so it never covers the content (the Allow style and Safer mode switches
  // included). Without an h1 on the page it keeps the default offset of its class.
  const [top, setTop] = useState<number | null>(null);
  const shown = variant === 'chip' && unlocked;
  useEffect(() => {
    if (!shown) {
      return undefined;
    }
    let frame = 0;
    const place = () => {
      frame = 0;
      const title = document.querySelector('h1');
      if (title === null) {
        setTop(null);
        return;
      }
      const t = title.getBoundingClientRect();
      const wanted = t.top + (t.height - PILL_HEIGHT) / 2;
      const crumb = document.querySelector('nav[aria-label="Breadcrumb"]')?.getBoundingClientRect();
      const floor = crumb === undefined ? 0 : crumb.top + (crumb.height - PILL_HEIGHT) / 2;
      setTop(Math.round(Math.max(wanted, floor)));
    };
    const schedule = () => {
      if (frame === 0) {
        frame = requestAnimationFrame(place);
      }
    };
    place();
    // Capture: the page may scroll in the window or in an inner container.
    window.addEventListener('scroll', schedule, true);
    window.addEventListener('resize', schedule);
    // The sticky header of app-core collapses with a CSS transition: its final place is known only when the transition ends.
    window.addEventListener('transitionend', schedule, true);
    return () => {
      window.removeEventListener('scroll', schedule, true);
      window.removeEventListener('resize', schedule);
      window.removeEventListener('transitionend', schedule, true);
      cancelAnimationFrame(frame);
    };
  }, [shown]);

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
    return (
      <div data-testid="unlocked-key-chip" title={PILL_TIP} className={PILL} style={top === null ? undefined : { top }}>
        <span role="status" aria-live="off" className="inline-flex items-center gap-1.5">
          <span data-testid="unlocked-key-dot" aria-hidden="true" className={`h-2 w-2 rounded-full ${remaining < 60_000 ? 'bg-warning' : 'bg-success'}`} />
          {`Key unlocked ${formatCountdown(remaining)}`}
        </span>
        {/* The time the key stays unlocked after the last signature: a longer choice applies from now (the holder restarts the countdown). */}
        <CompactSelect ariaLabel="Keep unlocked for" value={keep} onChange={(v) => adminKeyHolder.setKeep(v as KeepChoice)} options={KEEP_OPTIONS} />
        <button type="button" onClick={() => adminKeyHolder.lock()} className="rounded px-1 text-xs font-medium text-content underline-offset-2 hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-primary">
          Lock
        </button>
      </div>
    );
  }
  if (pageHasPill) {
    return <span className={TEXT_MUTED_SM}>No passphrase needed: the admin key is unlocked in this page.</span>;
  }
  return (
    <div data-testid="unlocked-key-bar" className={`flex flex-wrap items-center justify-between gap-2 ${NOTICE_SUCCESS}`}>
      <span>{`Admin key unlocked, locks in ${formatCountdown(expiresAt - now)}`}</span>
      <ButtonAction label="Lock now" variant="secondary" size="sm" onClick={() => adminKeyHolder.lock()} />
    </div>
  );
}
