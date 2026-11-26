import React from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { AllowStyleSwitch } from './AllowStyleSwitch.js';

describe('AllowStyleSwitch', () => {
  it('is a radiogroup with Dialog and Inline (the dsl-ui RadioGroup), the current one checked', () => {
    render(<AllowStyleSwitch value="inline" onChange={() => undefined} />);
    expect(screen.getByRole('radiogroup')).toBeInTheDocument();
    expect(screen.getByText('Allow style')).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'Inline' })).toBeChecked();
    expect(screen.getByRole('radio', { name: 'Dialog' })).not.toBeChecked();
  });

  it('a click on the other option reports it', async () => {
    const onChange = vi.fn();
    render(<AllowStyleSwitch value="inline" onChange={onChange} />);
    await userEvent.click(screen.getByRole('radio', { name: 'Dialog' }));
    expect(onChange).toHaveBeenCalledWith('dialog');
  });

  it('is usable from the keyboard: Tab reaches the checked option, an arrow moves the focus (Radix checks the focused radio in the next frame, not asserted in jsdom)', async () => {
    render(<AllowStyleSwitch value="inline" onChange={() => undefined} />);
    await userEvent.tab();
    expect(screen.getByRole('radio', { name: 'Inline' })).toHaveFocus();
    await userEvent.keyboard('{ArrowLeft}');
    expect(screen.getByRole('radio', { name: 'Dialog' })).toHaveFocus();
  });

  it('says in one short line why the choice is not remembered, when a problem is given', () => {
    render(<AllowStyleSwitch value="inline" onChange={() => undefined} problem="the browser storage refused the choice (full): the Allow style is kept for this page only" />);
    expect(screen.getByRole('alert')).toHaveTextContent('the browser storage refused the choice');
  });

  it('no problem: no alert', () => {
    render(<AllowStyleSwitch value="inline" onChange={() => undefined} />);
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
