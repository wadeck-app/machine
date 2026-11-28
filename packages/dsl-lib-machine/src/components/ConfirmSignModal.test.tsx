import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { adminKeyHolder } from '../lib/adminKeyHolder.js';
import { describe, expect, it, vi } from 'vitest';
import { ConfirmSignModal } from './ConfirmSignModal.js';

// The passphrase hint (decision 57): stored in clear in the key file, shown BEFORE the passphrase is typed, never a secret.

const base = { title: 'Allow?', details: [{ label: 'Machine', value: 'desktop' }], warning: 'careful', confirmLabel: 'Allow and sign', onConfirm: vi.fn(), onCancel: vi.fn() };

describe('the passphrase hint of the signing dialog', () => {
  it('is the helpText of the passphrase field (the standard small text UNDER the field, in aria-describedby), shown before anything is typed, no custom box', () => {
    render(<ConfirmSignModal {...base} hint="the street of my first school" />);
    const field = screen.getByLabelText('Admin passphrase');
    // The helpText of the field (FieldSecret): described by it, after the input, before anything is typed.
    const helpId = field.getAttribute('aria-describedby');
    expect(helpId).not.toBeNull();
    const help = document.getElementById(helpId as string);
    expect(help).toHaveTextContent('Hint: the street of my first school');
    expect(field.compareDocumentPosition(help as HTMLElement) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.queryByTestId('passphrase-hint')).toBeNull();
    expect(field).toHaveValue('');
  });

  it('shows no description at all when the key has no hint', () => {
    render(<ConfirmSignModal {...base} />);
    expect(screen.queryByText(/Hint:/)).toBeNull();

  });

  it('is not shown when no passphrase is asked (informational dialog)', () => {
    render(<ConfirmSignModal {...base} needsPassphrase={false} hint="should not appear" />);
    expect(screen.queryByText(/Hint:/)).toBeNull();
  });

  it('is text only: markup in a hint is shown as text, never interpreted', () => {
    render(<ConfirmSignModal {...base} hint="<b>bold</b>" />);
    expect(screen.getByText('Hint: <b>bold</b>')).toBeInTheDocument();
    expect(screen.getByText('Hint: <b>bold</b>').querySelector('b')).toBeNull();
  });
});

describe('the warning box of the signing dialog', () => {
  it('is shown when there is a warning, and no empty box when the dialog has none (the caller already said it)', () => {
    const { rerender } = render(<ConfirmSignModal {...base} />);
    expect(screen.getByText('careful')).toBeInTheDocument();
    rerender(<ConfirmSignModal {...base} warning="" />);
    expect(screen.getByRole('dialog').querySelector('p.border-warning')).toBeNull();
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

describe('askEveryTime: no unlock window (approve from the page)', () => {
  const key = () => {
    let locked = false;
    return { privateKey: {} as CryptoKey, publicKeyRaw: new Uint8Array(32), publicKey: 'p', keyId: 'k'.repeat(32), lock: () => { locked = true; }, isLocked: () => locked };
  };

  it('asks the passphrase even while a key is held in this page, and offers no "Keep unlocked for" and no unlocked bar', async () => {
    const onConfirm = vi.fn();
    adminKeyHolder.hold(key());
    render(<ConfirmSignModal {...base} askEveryTime onConfirm={onConfirm} />);
    expect(screen.getByLabelText('Admin passphrase')).toBeInTheDocument();
    expect(screen.queryByLabelText('Keep unlocked for')).toBeNull();
    expect(screen.queryByText(/Admin key unlocked/)).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Allow and sign' }));
    // Nothing typed: nothing is confirmed, never a null passphrase.
    expect(onConfirm).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent('Enter the admin passphrase');
  });

  it('take() returns the typed passphrase ONCE and empties the field', async () => {
    const onConfirm = vi.fn();
    render(<ConfirmSignModal {...base} askEveryTime onConfirm={onConfirm} />);
    const field = screen.getByLabelText('Admin passphrase') as HTMLInputElement;
    await userEvent.type(field, 'secret words');
    await userEvent.click(screen.getByRole('button', { name: 'Allow and sign' }));
    const take = onConfirm.mock.calls[0]?.[0] as () => string | null;
    expect(field.value).toBe('secret words');
    expect(take()).toBe('secret words');
    expect(field.value).toBe('');
  });
});

describe('the aside and the busy label of the signing dialog', () => {
  it('an aside (the timeline of the approval) is shown INSIDE the dialog, before the content, so it stays visible while the dialog is open', () => {
    render(<ConfirmSignModal {...base} aside={<ol aria-label="Progress"><li>step</li></ol>} />);
    const dialog = screen.getByRole('dialog');
    const aside = screen.getByLabelText('Progress');
    expect(dialog).toContainElement(aside);
    expect(aside.compareDocumentPosition(screen.getByText('desktop')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('no aside: the dialog has no side column', () => {
    render(<ConfirmSignModal {...base} />);
    expect(screen.getByRole('dialog').querySelector('[data-part="aside"]')).toBeNull();
  });

  it('the busy button says what is happening (default "Signing...")', () => {
    const { rerender } = render(<ConfirmSignModal {...base} busy />);
    expect(screen.getByRole('button', { name: 'Signing...' })).toBeDisabled();
    rerender(<ConfirmSignModal {...base} busy busyLabel="Telling the other machines..." />);
    expect(screen.getByRole('button', { name: 'Telling the other machines...' })).toBeDisabled();
  });
});
