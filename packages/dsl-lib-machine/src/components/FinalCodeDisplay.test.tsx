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
    expect(await screen.findByLabelText('Security code')).toHaveTextContent(expected);
  });

  it('tells the admin to compare it with the code on the candidate machine', async () => {
    render(<FinalCodeDisplay {...inputs()} />);
    await screen.findByLabelText('Security code');
    expect(screen.getByText(/candidate machine/i)).toBeInTheDocument();
  });

  it('calls onConfirm only after the admin ticks that the codes match and presses the button, never before', async () => {
    const onConfirm = vi.fn();
    render(<FinalCodeDisplay {...inputs()} onConfirm={onConfirm} />);
    await screen.findByLabelText('Security code');
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
    expect(alert).toHaveTextContent('Cannot compute the security code');
    expect(alert).toHaveTextContent('candidacy random');
    expect(screen.queryByLabelText('Security code')).toBeNull();
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Codes match, continue' })).toBeNull());
  });

  // The theme tokens follow the light/dark theme; a Tailwind palette class (hue and shade) or text-white does not.
  const PALETTE = /\b(text|bg|border)-(red|gray|blue)-\d|\btext-white\b/;

  it('uses only theme tokens, never a Tailwind palette colour: pending, ready', async () => {
    const { container } = render(<FinalCodeDisplay {...inputs()} />);
    expect(container.innerHTML).not.toMatch(PALETTE);
    await screen.findByLabelText('Security code');
    expect(container.innerHTML).not.toMatch(PALETTE);
  });

  it('uses only theme tokens, never a Tailwind palette colour: error', async () => {
    const { container } = render(<FinalCodeDisplay {...inputs()} random="not-a-random" />);
    await screen.findByRole('alert');
    expect(container.innerHTML).not.toMatch(PALETTE);
  });
});
