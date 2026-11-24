import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { UnlockedAdminKey } from '@wadeck-app/machine-webcrypto';
import { adminKeyHolder, formatCountdown, KEEP_CHOICES } from './adminKeyHolder.js';

// The holder of the unlocked admin key (decision 92): one module-level singleton, the key only in memory.

function fakeKey(): UnlockedAdminKey & { lockCalls: number } {
  let locked = false;
  const key = {
    privateKey: {} as CryptoKey,
    publicKeyRaw: new Uint8Array(32),
    publicKey: 'pub',
    keyId: 'k'.repeat(32),
    lockCalls: 0,
    lock() {
      locked = true;
      key.lockCalls++;
    },
    isLocked: () => locked,
  };
  return key;
}

const MIN = 60_000;

beforeEach(() => {
  vi.useFakeTimers();
  adminKeyHolder.reset();
});
afterEach(() => {
  adminKeyHolder.reset();
  vi.useRealTimers();
});

describe('the holder of the unlocked admin key', () => {
  it('starts locked, with 5 minutes as the default and the choices 1, 5, 15, 30, 60 minutes and ask every time', () => {
    expect(adminKeyHolder.current()).toBeNull();
    expect(adminKeyHolder.snapshot()).toMatchObject({ unlocked: false, expiresAt: null, keep: '5' });
    expect(KEEP_CHOICES.map((c) => c.value)).toEqual(['1', '5', '15', '30', '60', 'ask']);
  });

  it('keeps the key after hold, and wipes AND locks it when the idle timeout runs out', () => {
    const key = fakeKey();
    expect(adminKeyHolder.hold(key)).toBe(true);
    expect(adminKeyHolder.current()).toBe(key);
    expect(adminKeyHolder.snapshot().expiresAt).toBe(Date.now() + 5 * MIN);
    vi.advanceTimersByTime(5 * MIN - 1);
    expect(adminKeyHolder.current()).toBe(key);
    vi.advanceTimersByTime(1);
    expect(adminKeyHolder.current()).toBeNull();
    expect(key.lockCalls).toBe(1);
    expect(adminKeyHolder.snapshot().unlocked).toBe(false);
  });

  it('every use (touch) extends the idle timeout from now', () => {
    const key = fakeKey();
    adminKeyHolder.hold(key);
    vi.advanceTimersByTime(4 * MIN);
    adminKeyHolder.touch();
    vi.advanceTimersByTime(4 * MIN);
    expect(adminKeyHolder.current()).toBe(key);
    expect(adminKeyHolder.snapshot().expiresAt).toBe(Date.now() + 1 * MIN);
    vi.advanceTimersByTime(1 * MIN);
    expect(adminKeyHolder.current()).toBeNull();
  });

  it('lock() wipes and locks the key at once and cancels the timer', () => {
    const key = fakeKey();
    adminKeyHolder.hold(key);
    adminKeyHolder.lock();
    expect(adminKeyHolder.current()).toBeNull();
    expect(key.lockCalls).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('"ask every time" keeps nothing: hold returns false and the key is locked', () => {
    adminKeyHolder.setKeep('ask');
    const key = fakeKey();
    expect(adminKeyHolder.hold(key)).toBe(false);
    expect(adminKeyHolder.current()).toBeNull();
    expect(key.lockCalls).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('the chosen duration is the idle timeout of the next unlocks', () => {
    adminKeyHolder.setKeep('15');
    adminKeyHolder.hold(fakeKey());
    expect(adminKeyHolder.snapshot().expiresAt).toBe(Date.now() + 15 * MIN);
  });

  it('changing the choice while unlocked applies from now; "ask every time" locks at once', () => {
    const key = fakeKey();
    adminKeyHolder.hold(key);
    vi.advanceTimersByTime(2 * MIN);
    adminKeyHolder.setKeep('1');
    expect(adminKeyHolder.snapshot().expiresAt).toBe(Date.now() + 1 * MIN);
    adminKeyHolder.setKeep('ask');
    expect(adminKeyHolder.current()).toBeNull();
    expect(key.lockCalls).toBe(1);
  });

  it('a key locked from outside is never handed out', () => {
    const key = fakeKey();
    adminKeyHolder.hold(key);
    key.lock();
    expect(adminKeyHolder.current()).toBeNull();
  });

  it('holding a second key locks the first one', () => {
    const first = fakeKey();
    const second = fakeKey();
    adminKeyHolder.hold(first);
    adminKeyHolder.hold(second);
    expect(first.lockCalls).toBe(1);
    expect(adminKeyHolder.current()).toBe(second);
  });

  it('an explicit duration (the signer component) overrides the choice for that hold, and "ask" still keeps it for that duration only when given', () => {
    adminKeyHolder.setKeep('ask');
    const key = fakeKey();
    expect(adminKeyHolder.hold(key, { ms: 2 * MIN })).toBe(true);
    expect(adminKeyHolder.snapshot().expiresAt).toBe(Date.now() + 2 * MIN);
  });

  it('tells its subscribers on every change, with a stable snapshot between changes', () => {
    const seen: boolean[] = [];
    const off = adminKeyHolder.subscribe(() => seen.push(adminKeyHolder.snapshot().unlocked));
    const before = adminKeyHolder.snapshot();
    expect(adminKeyHolder.snapshot()).toBe(before);
    adminKeyHolder.hold(fakeKey());
    adminKeyHolder.lock();
    off();
    adminKeyHolder.hold(fakeKey());
    expect(seen).toEqual([true, false]);
  });

  it('the page leaving (pagehide) locks the key', () => {
    const key = fakeKey();
    adminKeyHolder.hold(key);
    window.dispatchEvent(new Event('pagehide'));
    expect(adminKeyHolder.current()).toBeNull();
    expect(key.lockCalls).toBe(1);
  });

  it('writes NOTHING to localStorage, sessionStorage, IndexedDB or document.cookie, whatever it is asked to do', () => {
    const local = vi.spyOn(Storage.prototype, 'setItem');
    const cookie = vi.spyOn(document, 'cookie', 'set');
    const idb = { open: vi.fn() };
    vi.stubGlobal('indexedDB', idb);
    try {
      adminKeyHolder.setKeep('30');
      adminKeyHolder.hold(fakeKey());
      adminKeyHolder.touch();
      adminKeyHolder.setKeep('ask');
      adminKeyHolder.hold(fakeKey());
      adminKeyHolder.lock();
      expect(local).not.toHaveBeenCalled();
      expect(cookie).not.toHaveBeenCalled();
      expect(idb.open).not.toHaveBeenCalled();
      expect(window.localStorage.length).toBe(0);
      expect(window.sessionStorage.length).toBe(0);
    } finally {
      vi.unstubAllGlobals();
      local.mockRestore();
      cookie.mockRestore();
    }
  });
});

describe('formatCountdown', () => {
  it('shows minutes and two-digit seconds, rounding up so it never shows 0:00 while unlocked', () => {
    expect(formatCountdown(272_000)).toBe('4:32');
    expect(formatCountdown(59_001)).toBe('1:00');
    expect(formatCountdown(1)).toBe('0:01');
    expect(formatCountdown(0)).toBe('0:00');
    expect(formatCountdown(-5)).toBe('0:00');
  });
});

describe('an unlock that is still running when the key is locked from outside', () => {
  it('is not kept: the caller reads epoch() before the unlock, hold() with that epoch locks the key when lock() or reset() ran meanwhile', () => {
    for (const interrupt of [() => adminKeyHolder.lock(), () => adminKeyHolder.reset()]) {
      const since = adminKeyHolder.epoch();
      interrupt();
      const key = fakeKey();
      expect(adminKeyHolder.hold(key, { since })).toBe(false);
      expect(key.isLocked()).toBe(true);
      expect(adminKeyHolder.current()).toBeNull();
      expect(adminKeyHolder.snapshot().unlocked).toBe(false);
    }
  });

  it('is kept when nothing locked the holder meanwhile', () => {
    const since = adminKeyHolder.epoch();
    const key = fakeKey();
    expect(adminKeyHolder.hold(key, { since })).toBe(true);
    expect(adminKeyHolder.current()).toBe(key);
  });

  it('a second unlock that replaces the first one does not make the first one stale for itself', () => {
    const since = adminKeyHolder.epoch();
    expect(adminKeyHolder.hold(fakeKey())).toBe(true);
    const second = fakeKey();
    expect(adminKeyHolder.hold(second, { since })).toBe(true);
    expect(adminKeyHolder.current()).toBe(second);
  });
});

describe('a stale unlock never locks a key another unlock stored meanwhile', () => {
  it('the newer key stays held', () => {
    const since = adminKeyHolder.epoch();
    adminKeyHolder.lock();
    const newer = fakeKey();
    adminKeyHolder.hold(newer);
    const stale = fakeKey();
    expect(adminKeyHolder.hold(stale, { since })).toBe(false);
    expect(stale.isLocked()).toBe(true);
    expect(newer.isLocked()).toBe(false);
    expect(adminKeyHolder.current()).toBe(newer);
  });
});
