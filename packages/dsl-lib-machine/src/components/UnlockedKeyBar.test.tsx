import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { UnlockedAdminKey } from '@wadeck-app/machine-webcrypto';
import { adminKeyHolder } from '../lib/adminKeyHolder.js';
import { KeepUnlockedSelect } from './KeepUnlockedSelect.js';
import { HeaderActionsHost } from '../testHeaderActions.js';
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
  it('offers 1, 5, 15, 30, 60 minutes and ask every time, with 5 minutes selected by default', () => {
    render(<KeepUnlockedSelect />);
    const select = screen.getByLabelText('Keep unlocked for') as HTMLSelectElement;
    expect(Array.from(select.options).map((o) => o.textContent)).toEqual(['1 min', '5 min', '15 min', '30 min', '1 h', 'Ask every time']);
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

describe('UnlockedKeyBar as a pill in the header actions of the page (the Requests page)', () => {
  // User request 2026-11-24: lengthen the time from the badge itself, without going to the dialog.
  it('has a "Keep unlocked for" choice on the pill: picking a longer time extends the key from now and the countdown follows', () => {
    render(<UnlockedKeyBar variant="chip" />, { wrapper: HeaderActionsHost });
    act(() => void adminKeyHolder.hold(fakeKey()));
    advance(3 * MIN);
    expect(screen.getByTestId('unlocked-key-chip')).toHaveTextContent('Key unlocked 2:00');
    const select = screen.getByLabelText('Keep unlocked for') as HTMLSelectElement;
    expect(select.value).toBe('5');
    fireEvent.change(select, { target: { value: '60' } });
    expect(screen.getByTestId('unlocked-key-chip')).toHaveTextContent('Key unlocked 60:00');
    advance(10 * MIN);
    expect(adminKeyHolder.current()).not.toBeNull();
  });


  it('is nothing while the key is locked', () => {
    render(<UnlockedKeyBar variant="chip" />, { wrapper: HeaderActionsHost });
    expect(screen.getByTestId('header-actions-slot')).toBeEmptyDOMElement();
  });

  it('shows "Key unlocked 5:00" counting down, with a labelled Lock button that locks the key', () => {
    render(<UnlockedKeyBar variant="chip" />, { wrapper: HeaderActionsHost });
    act(() => void adminKeyHolder.hold(fakeKey()));
    const pill = screen.getByTestId('unlocked-key-chip');
    expect(pill).toHaveTextContent('Key unlocked 5:00');
    advance(28_000);
    expect(pill).toHaveTextContent('Key unlocked 4:32');
    expect(screen.queryByTestId('unlocked-key-bar')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Lock' }));
    expect(adminKeyHolder.current()).toBeNull();
    expect(screen.queryByTestId('unlocked-key-chip')).toBeNull();
  });

  it('is drawn in the slot of the host (the header actions), not where it is written, and with no custom positioning', () => {
    render(
      <section data-testid="page">
        <UnlockedKeyBar variant="chip" />
      </section>,
      { wrapper: HeaderActionsHost },
    );
    act(() => void adminKeyHolder.hold(fakeKey()));
    const pill = screen.getByTestId('unlocked-key-chip');
    expect(screen.getByTestId('header-actions-slot')).toContainElement(pill);
    expect(screen.getByTestId('page')).not.toContainElement(pill);
    expect(pill.className).toBe('');
    expect(pill.getAttribute('style')).toBeNull();
  });

  it('without a host (no provider, no slot) it shows nothing and does not throw', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const { container } = render(<UnlockedKeyBar variant="chip" />);
      expect(() => act(() => void adminKeyHolder.hold(fakeKey()))).not.toThrow();
      expect(screen.queryByTestId('unlocked-key-chip')).toBeNull();
      expect(container).toBeEmptyDOMElement();
    } finally {
      warn.mockRestore();
    }
  });

  it('the time is a role=status that does not announce every second; the lock itself is announced once', () => {
    render(<UnlockedKeyBar variant="chip" />, { wrapper: HeaderActionsHost });
    act(() => void adminKeyHolder.hold(fakeKey()));
    const time = screen.getByRole('status');
    expect(time).toHaveAttribute('aria-live', 'off');
    expect(time).toHaveTextContent('Key unlocked 5:00');
    const tip = 'The admin key stays in this page only; it locks when the time runs out, on Lock, or on reload';
    expect(screen.getByTestId('unlocked-key-chip')).toHaveAttribute('title', tip);
    advance(5 * MIN);
    expect(screen.queryByTestId('unlocked-key-chip')).toBeNull();
    const announced = screen.getByRole('status');
    expect(announced).toHaveAttribute('aria-live', 'polite');
    expect(announced).toHaveTextContent('Admin key locked');
  });

  it('the badge is green, and amber when less than 60 seconds remain', () => {
    render(<UnlockedKeyBar variant="chip" />, { wrapper: HeaderActionsHost });
    act(() => void adminKeyHolder.hold(fakeKey()));
    advance(4 * MIN);
    expect(screen.getByTestId('unlocked-key-chip')).toHaveTextContent('Key unlocked 1:00');
    expect(screen.getByText('Key unlocked 1:00').className).toMatch(/bg-success/);
    advance(1_000);
    expect(screen.getByTestId('unlocked-key-chip')).toHaveTextContent('Key unlocked 0:59');
    expect(screen.getByText('Key unlocked 0:59').className).toMatch(/bg-warning/);
    expect(screen.getByText('Key unlocked 0:59').className).not.toMatch(/bg-success/);
  });
});

describe('one indicator per page', () => {
  it('a dialog bar next to the page pill says no passphrase is needed, without a second countdown or Lock', () => {
    render(
      <>
        <UnlockedKeyBar variant="chip" />
        <UnlockedKeyBar />
      </>,
      { wrapper: HeaderActionsHost },
    );
    act(() => void adminKeyHolder.hold(fakeKey()));
    expect(screen.getAllByText(/key unlocked/i)).toHaveLength(1);
    expect(screen.getAllByRole('button', { name: /lock/i })).toHaveLength(1);
    expect(screen.queryByTestId('unlocked-key-bar')).toBeNull();
    expect(screen.getByText('No passphrase needed: the admin key is unlocked in this page.')).toBeInTheDocument();
  });

  it('without a pill the bar keeps its countdown and Lock now', () => {
    render(<UnlockedKeyBar />);
    act(() => void adminKeyHolder.hold(fakeKey()));
    expect(screen.getByTestId('unlocked-key-bar')).toHaveTextContent('Admin key unlocked, locks in 5:00');
    expect(screen.getByRole('button', { name: 'Lock now' })).toBeInTheDocument();
  });

  it('when the pill goes away the bar is the indicator again', () => {
    const pill = render(<UnlockedKeyBar variant="chip" />, { wrapper: HeaderActionsHost });
    render(<UnlockedKeyBar />);
    act(() => void adminKeyHolder.hold(fakeKey()));
    expect(screen.queryByTestId('unlocked-key-bar')).toBeNull();
    pill.unmount();
    expect(screen.getByTestId('unlocked-key-bar')).toBeInTheDocument();
  });
});
