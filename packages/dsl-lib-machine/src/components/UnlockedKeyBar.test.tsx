import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { UnlockedAdminKey } from '@wadeck-app/machine-webcrypto';
import { adminKeyHolder } from '../lib/adminKeyHolder.js';
import { KeepUnlockedSelect } from './KeepUnlockedSelect.js';
import { UnlockedKeyBar } from './UnlockedKeyBar.js';

// The badge of the held admin key and the "Keep unlocked for" choice (decision 92).

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
const advance = (ms: number) => act(() => void vi.advanceTimersByTime(ms));

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('UnlockedKeyBar', () => {
  it('shows nothing while the key is locked', () => {
    const { container } = render(<UnlockedKeyBar />);
    expect(container).toBeEmptyDOMElement();
  });

  it('says the key is unlocked and counts down to the lock, every second', () => {
    render(<UnlockedKeyBar />);
    act(() => void adminKeyHolder.hold(fakeKey()));
    expect(screen.getByText('Admin key unlocked, locks in 5:00')).toBeInTheDocument();
    advance(28_000);
    expect(screen.getByText('Admin key unlocked, locks in 4:32')).toBeInTheDocument();
  });

  it('a signature (touch) puts the countdown back to the full duration', () => {
    render(<UnlockedKeyBar />);
    act(() => void adminKeyHolder.hold(fakeKey()));
    advance(2 * MIN);
    expect(screen.getByText('Admin key unlocked, locks in 3:00')).toBeInTheDocument();
    act(() => adminKeyHolder.touch());
    expect(screen.getByText('Admin key unlocked, locks in 5:00')).toBeInTheDocument();
  });

  it('disappears by itself when the idle time runs out, and the key is locked', () => {
    const key = fakeKey();
    render(<UnlockedKeyBar />);
    act(() => void adminKeyHolder.hold(key));
    advance(5 * MIN);
    expect(screen.queryByText(/Admin key unlocked/)).toBeNull();
    expect(key.lockCalls).toBe(1);
  });

  it('Lock now wipes and locks the key at once', () => {
    const key = fakeKey();
    render(<UnlockedKeyBar />);
    act(() => void adminKeyHolder.hold(key));
    fireEvent.click(screen.getByRole('button', { name: 'Lock now' }));
    expect(adminKeyHolder.current()).toBeNull();
    expect(key.lockCalls).toBe(1);
    expect(screen.queryByText(/Admin key unlocked/)).toBeNull();
  });

  it('unmounting is NOT a reason to lock: the key survives a navigation inside the SPA and the next mount shows it', () => {
    const key = fakeKey();
    const first = render(<UnlockedKeyBar />);
    act(() => void adminKeyHolder.hold(key));
    advance(60_000);
    first.unmount();
    expect(adminKeyHolder.current()).toBe(key);
    expect(key.lockCalls).toBe(0);
    render(<UnlockedKeyBar />);
    expect(screen.getByText('Admin key unlocked, locks in 4:00')).toBeInTheDocument();
  });
});

describe('KeepUnlockedSelect', () => {
  it('offers 1, 5, 15, 30 minutes and ask every time, with 5 minutes selected by default', () => {
    render(<KeepUnlockedSelect />);
    const select = screen.getByLabelText('Keep unlocked for') as HTMLSelectElement;
    expect(Array.from(select.options).map((o) => o.textContent)).toEqual(['1 min', '5 min', '15 min', '30 min', 'Ask every time']);
    expect(select.value).toBe('5');
  });

  it('the choice is what the holder uses for the next unlock', () => {
    render(<KeepUnlockedSelect />);
    fireEvent.change(screen.getByLabelText('Keep unlocked for'), { target: { value: '15' } });
    expect(adminKeyHolder.keepChoice()).toBe('15');
    act(() => void adminKeyHolder.hold(fakeKey()));
    expect(adminKeyHolder.snapshot().expiresAt).toBe(Date.now() + 15 * MIN);
  });

  it('"Ask every time" locks a key that is held now', () => {
    const key = fakeKey();
    render(<KeepUnlockedSelect />);
    act(() => void adminKeyHolder.hold(key));
    fireEvent.change(screen.getByLabelText('Keep unlocked for'), { target: { value: 'ask' } });
    expect(adminKeyHolder.current()).toBeNull();
    expect(key.lockCalls).toBe(1);
  });
});
