import React from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { AllowStyleSwitch } from './AllowStyleSwitch.js';

describe('AllowStyleSwitch', () => {
  it('is a radiogroup named "Allow style" with Dialog and Inline, the current one checked', () => {
    render(<AllowStyleSwitch value="inline" onChange={() => undefined} />);
    const group = screen.getByRole('radiogroup', { name: 'Allow style' });
    expect(group).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'Inline' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('radio', { name: 'Dialog' })).toHaveAttribute('aria-checked', 'false');
  });

  it('a click on the other option reports it', async () => {
    const onChange = vi.fn();
    render(<AllowStyleSwitch value="inline" onChange={onChange} />);
    await userEvent.click(screen.getByRole('radio', { name: 'Dialog' }));
    expect(onChange).toHaveBeenCalledWith('dialog');
  });

  it('is usable from the keyboard: Tab reaches only the checked option, arrows move and choose', async () => {
    const onChange = vi.fn();
    render(<AllowStyleSwitch value="inline" onChange={onChange} />);
    await userEvent.tab();
    expect(screen.getByRole('radio', { name: 'Inline' })).toHaveFocus();
    expect(screen.getByRole('radio', { name: 'Dialog' })).toHaveAttribute('tabindex', '-1');
    await userEvent.keyboard('{ArrowLeft}');
    expect(onChange).toHaveBeenLastCalledWith('dialog');
  });

  it('the options are large enough to click and use theme tokens only', () => {
    render(<AllowStyleSwitch value="dialog" onChange={() => undefined} />);
    const checked = screen.getByRole('radio', { name: 'Dialog' });
    const other = screen.getByRole('radio', { name: 'Inline' });
    expect(checked.className).toMatch(/\bpx-4\b.*\bpy-2\b|\bpy-2\b.*\bpx-4\b/);
    expect(checked.className).toContain('bg-primary');
    expect(other.className).not.toContain('bg-primary');
    expect(`${checked.className} ${other.className}`).not.toMatch(/\b(bg|text|border)-(red|green|blue|gray|slate|zinc|amber|yellow)-\d/);
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
