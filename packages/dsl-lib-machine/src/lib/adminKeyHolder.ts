import type { UnlockedAdminKey } from '@wadeck-app/machine-webcrypto';

// The holder of the UNLOCKED admin key (decision 92). One module-level singleton, so the key survives the navigation between the pages of the module (the
// SPA keeps this bundle loaded) and is shared by every signing path: the Allow dialog, the inline Allow, the batch, the remote requests list, the signer.
//
// What it holds: the NON-EXTRACTABLE CryptoKey returned by `unlockAdminKey`, in a variable of this module and nowhere else. Never the passphrase (it only
// goes through the callers' local variables), never localStorage, sessionStorage, IndexedDB, a cookie, `$setVar`, `$publishOutput`, a URL, a prop or an
// Error message. The choice of the duration is memory only too: it is back to 5 minutes after a reload.
//
// It is wiped (and the key locked) on: `lock()` (the Lock now button), the idle timeout (no signing for the chosen duration), `pagehide` (tab close, reload,
// navigation out of the page). The unmount of a component is NOT a reason to lock.

/** The choices of "Keep unlocked for": minutes as text, or `ask` (keep nothing: the passphrase is asked every time, the behaviour of before). */
export type KeepChoice = '1' | '5' | '15' | '30' | 'ask';

export const KEEP_CHOICES: ReadonlyArray<{ value: KeepChoice; label: string; ms: number | null }> = [
  { value: '1', label: '1 min', ms: 60_000 },
  { value: '5', label: '5 min', ms: 5 * 60_000 },
  { value: '15', label: '15 min', ms: 15 * 60_000 },
  { value: '30', label: '30 min', ms: 30 * 60_000 },
  { value: 'ask', label: 'Ask every time', ms: null },
];

export const DEFAULT_KEEP: KeepChoice = '5';

export interface HolderSnapshot {
  unlocked: boolean;
  /** Epoch milliseconds when the key locks itself if nothing is signed; null when locked. */
  expiresAt: number | null;
  keep: KeepChoice;
}

const msOf = (choice: KeepChoice): number | null => KEEP_CHOICES.find((c) => c.value === choice)?.ms ?? null;

/** `4:32`: the time left, rounded UP to the second so an unlocked key never shows 0:00. */
export function formatCountdown(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

let held: UnlockedAdminKey | null = null;
let idleMs = 0;
let expiresAt: number | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;
let keep: KeepChoice = DEFAULT_KEEP;
let pageHideRegistered = false;
let snap: HolderSnapshot = { unlocked: false, expiresAt: null, keep };
const listeners = new Set<() => void>();

function publish(): void {
  snap = { unlocked: held !== null, expiresAt, keep };
  for (const l of Array.from(listeners)) {
    l();
  }
}

function clearTimer(): void {
  if (timer !== null) {
    clearTimeout(timer);
  }
  timer = null;
}

function schedule(): void {
  clearTimer();
  expiresAt = Date.now() + idleMs;
  timer = setTimeout(() => adminKeyHolder.lock(), idleMs);
}

export const adminKeyHolder = {
  /** The unlocked key, or null when locked, expired or locked from outside. Never extends the idle timeout: `touch()` does, when a signature is made. */
  current(): UnlockedAdminKey | null {
    if (held !== null && held.isLocked()) {
      adminKeyHolder.lock();
    }
    return held;
  },

  /**
   * Keeps `key` for the chosen duration (or `options.ms`). Returns false when nothing is to be kept ("ask every time"): the key is LOCKED here, the caller
   * must not use it afterwards. A previously held key is locked.
   */
  hold(key: UnlockedAdminKey, options: { ms?: number } = {}): boolean {
    const ms = options.ms ?? msOf(keep);
    if (held !== null && held !== key) {
      held.lock();
    }
    if (ms === null) {
      key.lock();
      held = null;
      clearTimer();
      expiresAt = null;
      publish();
      return false;
    }
    if (!pageHideRegistered && typeof window !== 'undefined') {
      pageHideRegistered = true;
      // Tab close, reload, navigation out of the page: the key goes with it (the module state would die anyway; a page kept in the back-forward cache would not).
      window.addEventListener('pagehide', () => adminKeyHolder.lock());
    }
    held = key;
    idleMs = ms;
    schedule();
    publish();
    return true;
  },

  /** A signature is made with the held key: the idle timeout restarts from now. */
  touch(): void {
    if (held !== null) {
      schedule();
      publish();
    }
  },

  /** Wipes and locks the key (the Lock now button, the idle timeout, pagehide). */
  lock(): void {
    const key = held;
    held = null;
    expiresAt = null;
    clearTimer();
    key?.lock();
    publish();
  },

  keepChoice(): KeepChoice {
    return keep;
  },

  /** The chosen duration applies from now to a key already held; "ask every time" locks it at once. */
  setKeep(choice: KeepChoice): void {
    keep = choice;
    const ms = msOf(choice);
    if (held !== null) {
      if (ms === null) {
        adminKeyHolder.lock();
        return;
      }
      idleMs = ms;
      schedule();
    }
    publish();
  },

  snapshot(): HolderSnapshot {
    return snap;
  },

  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },

  /** Back to the start state (locked, 5 minutes, no subscriber). For tests. */
  reset(): void {
    adminKeyHolder.lock();
    keep = DEFAULT_KEEP;
    listeners.clear();
    publish();
  },
};
