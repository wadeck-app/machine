import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { adminKeyHolder } from '../lib/adminKeyHolder.js';
import { describe, expect, it, vi } from 'vitest';
import { ConfirmSignModal } from './ConfirmSignModal.js';

// The passphrase hint (decision 57): stored in clear in the key file, shown BEFORE the passphrase is typed, never a secret.

const base = { title: 'Allow?', details: [{ label: 'Machine', value: 'desktop' }], warning: 'careful', confirmLabel: 'Allow and sign', onConfirm: vi.fn(), onCancel: vi.fn() };

describe('the passphrase hint of the signing dialog', () => {
  it('shows the hint on its own line, labelled, before anything is typed', () => {
    render(<ConfirmSignModal {...base} hint="the street of my first school" />);
    const hint = screen.getByTestId('passphrase-hint');
    expect(hint).toHaveTextContent('Hint: the street of my first school');
    // Above the passphrase field: the person reads it, then types.
    const field = screen.getByLabelText('Admin passphrase');
    expect(hint.compareDocumentPosition(field) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(field).toHaveValue('');
  });

  it('shows no element at all when the key has no hint', () => {
    render(<ConfirmSignModal {...base} />);
    expect(screen.queryByTestId('passphrase-hint')).toBeNull();
    expect(screen.queryByText(/Hint:/)).toBeNull();
  });

  it('is not shown when no passphrase is asked (informational dialog)', () => {
    render(<ConfirmSignModal {...base} needsPassphrase={false} hint="should not appear" />);
    expect(screen.queryByTestId('passphrase-hint')).toBeNull();
  });

  it('is text only: markup in a hint is shown as text, never interpreted', () => {
    render(<ConfirmSignModal {...base} hint="<b>bold</b>" />);
    expect(screen.getByTestId('passphrase-hint')).toHaveTextContent('Hint: <b>bold</b>');
    expect(screen.getByTestId('passphrase-hint').querySelector('b')).toBeNull();
  });
});

describe('the held admin key in the signing dialog (decision 92)', () => {
  const key = () => {
    let locked = false;
    return { privateKey: {} as CryptoKey, publicKeyRaw: new Uint8Array(32), publicKey: 'p', keyId: 'k'.repeat(32), lock: () => { locked = true; }, isLocked: () => locked };
  };

  it('locked: the passphrase field and "Keep unlocked for" (5 min by default) are shown, and take() gives the typed passphrase', async () => {
    const onConfirm = vi.fn();
    render(<ConfirmSignModal {...base} onConfirm={onConfirm} />);
    expect((screen.getByLabelText('Keep unlocked for') as HTMLSelectElement).value).toBe('5');
    await userEvent.type(screen.getByLabelText('Admin passphrase'), 'secret words');
    await userEvent.click(screen.getByRole('button', { name: 'Allow and sign' }));
    const take = onConfirm.mock.calls[0]?.[0] as () => string | null;
    expect(take()).toBe('secret words');
  });

  it('unlocked: the summary of what is signed stays, there is NO passphrase field and no hint, the bar shows the countdown, and ONE click signs with take() = null', async () => {
    const onConfirm = vi.fn();
    adminKeyHolder.hold(key());
    render(<ConfirmSignModal {...base} hint="my hint" onConfirm={onConfirm} />);
    expect(screen.getByText('Machine')).toBeInTheDocument();
    expect(screen.getByText('desktop')).toBeInTheDocument();
    expect(screen.getByText('careful')).toBeInTheDocument();
    expect(screen.queryByLabelText('Admin passphrase')).toBeNull();
    expect(screen.queryByTestId('passphrase-hint')).toBeNull();
    expect(screen.getByText(/Admin key unlocked, locks in 5:00/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Allow and sign' }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect((onConfirm.mock.calls[0]?.[0] as () => string | null)()).toBeNull();
  });

  it('Cancel stays the default focus when unlocked: Enter without thinking never signs', () => {
    adminKeyHolder.hold(key());
    render(<ConfirmSignModal {...base} />);
    expect(screen.getByRole('button', { name: 'Cancel' })).toHaveFocus();
  });

  it('Lock now in the dialog brings the passphrase field back', async () => {
    adminKeyHolder.hold(key());
    render(<ConfirmSignModal {...base} />);
    await userEvent.click(screen.getByRole('button', { name: 'Lock now' }));
    expect(screen.getByLabelText('Admin passphrase')).toBeInTheDocument();
    expect(screen.queryByText(/Admin key unlocked/)).toBeNull();
  });

  it('a key that locks itself while the dialog is open brings the field back too (never a click that fails)', () => {
    vi.useFakeTimers();
    try {
      adminKeyHolder.hold(key());
      render(<ConfirmSignModal {...base} />);
      expect(screen.queryByLabelText('Admin passphrase')).toBeNull();
      act(() => void vi.advanceTimersByTime(5 * 60_000));
      expect(screen.getByLabelText('Admin passphrase')).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });
});
