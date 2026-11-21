import { render, screen } from '@testing-library/react';
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
