import React from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { SaferModeSwitch } from './SaferModeSwitch.js';

describe('SaferModeSwitch', () => {
  it('is a switch named "Safer mode: confirm risky lifetimes" with a one-line tooltip, off by default', () => {
    render(<SaferModeSwitch value={false} onChange={() => undefined} />);
    const sw = screen.getByRole('switch', { name: 'Safer mode: confirm risky lifetimes' });
    expect(sw).toHaveAttribute('aria-checked', 'false');
    expect(sw.closest('[title]')).toHaveAttribute('title', expect.stringMatching(/second click/));
  });

  it('a click reports the opposite value', async () => {
    const onChange = vi.fn();
    render(<SaferModeSwitch value={false} onChange={onChange} />);
    await userEvent.click(screen.getByRole('switch'));
    expect(onChange).toHaveBeenCalledWith(true);
  });

  it('shows why the choice is not remembered', () => {
    render(<SaferModeSwitch value={true} onChange={() => undefined} problem="the browser storage refused" />);
    expect(screen.getByRole('alert')).toHaveTextContent('the browser storage refused');
  });
});
