import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { adminKeyHolder } from '../lib/adminKeyHolder.js';
import { InlineAllowForm } from './InlineAllowForm.js';

// The inline Allow form and the held admin key (decision 92).

const props = { label: 'Allow ls', warning: () => 'Widens rights', onCancel: vi.fn() };
const key = () => {
  let locked = false;
  return { privateKey: {} as CryptoKey, publicKeyRaw: new Uint8Array(32), publicKey: 'p', keyId: 'k'.repeat(32), lock: () => { locked = true; }, isLocked: () => locked };
};

describe('InlineAllowForm', () => {
  it('locked: asks the passphrase, with "Keep unlocked for" next to it', async () => {
    const onSubmit = vi.fn();
    render(<InlineAllowForm {...props} hint="a hint" onSubmit={onSubmit} />);
    expect((screen.getByLabelText('Keep unlocked for') as HTMLSelectElement).value).toBe('5');
    expect(screen.getByTestId('passphrase-hint')).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText('Admin passphrase'), 'abc def');
    await userEvent.click(screen.getByRole('button', { name: 'Allow and sign' }));
    expect((onSubmit.mock.calls[0]?.[1] as () => string | null)()).toBe('abc def');
  });

  it('unlocked: no passphrase field and no hint, the lifetime and the warning stay, ONE click signs with take() = null', async () => {
    const onSubmit = vi.fn();
    adminKeyHolder.hold(key());
    render(<InlineAllowForm {...props} hint="a hint" onSubmit={onSubmit} />);
    expect(screen.queryByLabelText('Admin passphrase')).toBeNull();
    expect(screen.queryByTestId('passphrase-hint')).toBeNull();
    expect(screen.getByText('Widens rights')).toBeInTheDocument();
    expect(screen.getByTestId('lifetime-picker')).toBeInTheDocument();
    expect(screen.getByText(/Admin key unlocked, locks in/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Allow and sign' }));
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect((onSubmit.mock.calls[0]?.[1] as () => string | null)()).toBeNull();
  });

  it('an empty passphrase is still refused when locked', async () => {
    const onSubmit = vi.fn();
    render(<InlineAllowForm {...props} onSubmit={onSubmit} />);
    await userEvent.click(screen.getByRole('button', { name: 'Allow and sign' }));
    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent(/Enter the admin passphrase/);
  });
});
