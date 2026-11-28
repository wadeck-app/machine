import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { CodeText, CommandNotice } from './CommandNotice.js';

// A command between backticks is shown in monospace, never with its backticks; in a boxed message the prose stays in the box and the sentences with a command follow it.

describe('CommandNotice', () => {
  it('a text without a command is the plain Notice', () => {
    render(<CommandNotice variant="danger" label="Documents delivered." />);
    expect(screen.getByRole('alert')).toHaveTextContent('Documents delivered.');
  });

  it('the command is monospace text, once, and no backtick is shown; the prose stays in the box', () => {
    render(<CommandNotice variant="danger" label="Documents NOT delivered to 2 machines. Run `machine admin distribute 123`." />);
    expect(screen.getByRole('alert')).toHaveTextContent('Documents NOT delivered to 2 machines.');
    expect(screen.getByRole('alert')).not.toHaveTextContent('machine admin distribute');
    expect(screen.getAllByText('machine admin distribute 123')).toHaveLength(1);
    expect(document.body.textContent).not.toContain('`');
    expect(document.body.textContent).toContain('Run machine admin distribute 123.');
  });

  it('only a command: no empty box', () => {
    render(<CommandNotice variant="warning" label="Run `machine join`." />);
    expect(screen.queryByRole('status')).toBeNull();
    expect(screen.getByText('machine join')).toBeInTheDocument();
  });
});

describe('CodeText', () => {
  it('shows the commands in monospace and the rest as it is', () => {
    render(<p><CodeText text="Run `machine join` on the new machine, then `machine list`." /></p>);
    expect(screen.getByText('machine join')).toBeInTheDocument();
    expect(screen.getByText('machine list')).toBeInTheDocument();
    expect(document.body.textContent).toBe('Run machine join on the new machine, then machine list.');
  });
});
