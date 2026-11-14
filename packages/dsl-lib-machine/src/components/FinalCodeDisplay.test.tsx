import { newCandidacyRandom, finalCode as coreFinalCode, generateSigningKeyPair } from '@wadeck-app/machine-core';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { FinalCodeDisplay } from './FinalCodeDisplay.js';

function inputs() {
  return {
    candidatePublicKey: generateSigningKeyPair().publicKey,
    adminPublicKey: generateSigningKeyPair().publicKey,
    random: newCandidacyRandom(),
  };
}

describe('FinalCodeDisplay', () => {
  it('shows the final code, the same one machine-core computes', async () => {
    const i = inputs();
    render(<FinalCodeDisplay {...i} />);
    const expected = coreFinalCode(i.candidatePublicKey, i.adminPublicKey, i.random);
    expect(await screen.findByLabelText('Final verification code')).toHaveTextContent(expected);
  });

  it('tells the admin to compare it with the code on the candidate machine', async () => {
    render(<FinalCodeDisplay {...inputs()} />);
    await screen.findByLabelText('Final verification code');
    expect(screen.getByText(/candidate machine/i)).toBeInTheDocument();
  });

  it('calls onConfirm only after the admin ticks that the codes match and presses the button, never before', async () => {
    const onConfirm = vi.fn();
    render(<FinalCodeDisplay {...inputs()} onConfirm={onConfirm} />);
    await screen.findByLabelText('Final verification code');
    const button = screen.getByRole('button', { name: 'Codes match, continue' });
    expect(button).toHaveAttribute('disabled');
    await userEvent.click(screen.getByRole('checkbox', { name: /same code/i }));
    expect(onConfirm).not.toHaveBeenCalled();
    await userEvent.click(button);
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('names the bad input and the fix when a key or the random is malformed, and shows no code', async () => {
    render(<FinalCodeDisplay {...inputs()} random="not-a-random" />);
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Cannot compute the final code');
    expect(alert).toHaveTextContent('candidacy random');
    expect(screen.queryByLabelText('Final verification code')).toBeNull();
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Codes match, continue' })).toBeNull());
  });
});
