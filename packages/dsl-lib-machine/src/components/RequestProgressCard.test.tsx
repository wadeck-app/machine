import React from 'react';
import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { initialProgress, reduceProgress, type ProgressRecord } from '../lib/allowProgress.js';
import { RequestProgressCard } from './RequestProgressCard.js';

// A request that is only a progress display: ONE line (icon, command, machine, outcome, elapsed) and the thin stepper; the long wording is behind
// Details. A success collapses into a slim row 10 s after it ends; a failure stays open with its one-line cause until it is dismissed.

const T0 = 1_000_000;
const ROW = { id: 'aaaa1111', command: 'ls' };
const SKEW = "thinkcentre's clock is 3 min behind this machine (its time 10:00:00, this machine 10:03:00): fix its time sync (x)";
const inbox = { ok: true as const, delivery: 'inbox' as const, target: { uuid: 'u', name: 'thinkcentre' }, version: 2, fallback: { code: 'refused', cause: SKEW }, deliveryText: { tone: 'warning' as const, text: `thinkcentre did not take the document directly: stored in the relay inbox. Cause: ${SKEW}` } };
const direct = { ok: true as const, delivery: 'direct' as const, target: { uuid: 'u', name: 'thinkcentre' }, version: 2, deliveryText: { tone: 'success' as const, text: 'Delivered directly to thinkcentre (installed, 0.4 s)' } };

const start = (): ProgressRecord => initialProgress({ machineName: 'thinkcentre', held: true, now: T0 });
const stored = (): ProgressRecord => reduceProgress(reduceProgress(start(), { type: 'signed' }, T0), { type: 'result', result: inbox }, T0 + 500);
const released = (): ProgressRecord => reduceProgress(reduceProgress(reduceProgress(start(), { type: 'signed' }, T0), { type: 'result', result: direct }, T0 + 500), { type: 'hold', answer: { state: 'ended', outcome: 'allowed' } }, T0 + 4000);
const denied = (): ProgressRecord => reduceProgress(reduceProgress(reduceProgress(start(), { type: 'signed' }, T0), { type: 'result', result: direct }, T0 + 500), { type: 'hold', answer: { state: 'ended', outcome: 'denied' } }, T0 + 4000);
const signingFailed = (): ProgressRecord => reduceProgress(start(), { type: 'failed', message: 'wrong passphrase: nothing was signed' }, T0 + 300);

const props = (record: ProgressRecord, over: Partial<React.ComponentProps<typeof RequestProgressCard>> = {}): React.ComponentProps<typeof RequestProgressCard> => ({ row: ROW, record, now: T0 + 6000, canRetry: true, onRetry: vi.fn(), onDismiss: vi.fn(), ...over });
const card = () => screen.getByRole('listitem', { name: 'Held request ls' });

afterEach(() => vi.useRealTimers());

describe('the compact card of a running request', () => {
  it('is ONE line: the command in mono, the machine in mono, the outcome and the elapsed time; the stepper is under it', () => {
    render(<RequestProgressCard {...props(stored())} />);
    const c = card();
    expect(within(c).getByText('ls')).toHaveClass('font-mono');
    expect(within(c).getByText('thinkcentre')).toHaveClass('font-mono');
    expect(within(c).getByText('Waiting for the install')).toBeInTheDocument();
    expect(within(c).getByText('6 s')).toBeInTheDocument();
    expect(within(c).getByRole('progressbar')).toHaveAttribute('aria-valuenow', '50');
    // No vertical list of steps until Details is opened.
    expect(within(c).queryByTestId('allow-progress-steps')).toBeNull();
  });

  it('says the delivery fact in one short line with its essence, and the long explanation is not rendered until Details is opened', async () => {
    render(<RequestProgressCard {...props(stored())} />);
    const c = card();
    expect(within(c).getByText('Stored on the relay (direct delivery refused: clock 3 min behind)')).toBeInTheDocument();
    expect(c).not.toHaveTextContent(/fix its time sync/);
    const details = within(c).getByRole('button', { name: 'Details' });
    expect(details).toHaveAttribute('aria-expanded', 'false');
    await userEvent.click(details);
    expect(details).toHaveAttribute('aria-expanded', 'true');
    expect(within(c).getByTestId('allow-progress-steps')).toBeInTheDocument();
    expect(within(c).getAllByText(/fix its time sync/)).toHaveLength(1);
    await userEvent.click(details);
    expect(within(c).queryByTestId('allow-progress-steps')).toBeNull();
  });

  it('shows no text twice or more: every sentence of the card is rendered once, Details open', async () => {
    render(<RequestProgressCard {...props(stored())} />);
    await userEvent.click(within(card()).getByRole('button', { name: 'Details' }));
    const seen = Array.from(card().querySelectorAll('*')).filter((e) => e.children.length === 0).map((e) => e.textContent ?? '').filter((t) => t.length > 12);
    const counts = new Map<string, number>();
    seen.forEach((t) => counts.set(t, (counts.get(t) ?? 0) + 1));
    expect(Array.from(counts.entries()).filter(([, n]) => n > 1)).toEqual([]);
  });

  it('has no Dismiss while it runs', () => {
    render(<RequestProgressCard {...props(stored())} />);
    expect(within(card()).queryByRole('button', { name: 'Dismiss' })).toBeNull();
  });
});

describe('a finished request', () => {
  it('a success shows Released, a Dismiss icon button at the right end, then collapses into a slim row 10 s after the end', () => {
    vi.useFakeTimers();
    vi.setSystemTime(T0 + 4000);
    render(<RequestProgressCard {...props(released(), { now: T0 + 4000 })} />);
    const c = card();
    // The outcome of the line and the last word of the stepper.
    expect(within(c).getAllByText('Released')).toHaveLength(2);
    expect(within(c).getByRole('progressbar')).toHaveAttribute('aria-valuenow', '100');
    expect(within(c).getAllByRole('button').at(-1)).toHaveAccessibleName('Dismiss');
    act(() => { vi.advanceTimersByTime(9000); });
    expect(within(c).getByRole('progressbar')).toBeInTheDocument();
    act(() => { vi.advanceTimersByTime(1500); });
    // Slim: the line stays (command, machine, outcome, time), the stepper is gone.
    expect(within(c).queryByRole('progressbar')).toBeNull();
    expect(within(c).getAllByText('Released')).toHaveLength(1);
    expect(within(c).getByText('ls')).toBeInTheDocument();
    expect(within(c).getByRole('button', { name: 'Dismiss' })).toBeInTheDocument();
  });

  it('a request that ended long ago is slim at once (the tab was in the background)', () => {
    vi.useFakeTimers();
    vi.setSystemTime(T0 + 60_000);
    render(<RequestProgressCard {...props(released(), { now: T0 + 60_000 })} />);
    act(() => { vi.advanceTimersByTime(0); });
    expect(within(card()).queryByRole('progressbar')).toBeNull();
  });

  it('a failure stays expanded with its one-line cause, in the danger token, and does not collapse', () => {
    vi.useFakeTimers();
    vi.setSystemTime(T0 + 4000);
    render(<RequestProgressCard {...props(denied(), { now: T0 + 4000 })} />);
    const c = card();
    expect(within(c).getByText('Not released')).toBeInTheDocument();
    // The cause is a danger Notice of the design system: announced as an alert.
    expect(within(c).getByRole('alert')).toHaveTextContent('denied: nothing ran');
    act(() => { vi.advanceTimersByTime(60_000); });
    expect(within(c).getByRole('progressbar')).toBeInTheDocument();
    expect(within(c).getByText('denied: nothing ran')).toBeInTheDocument();
    expect(within(c).queryByRole('button', { name: 'Allow again' })).toBeNull();
  });

  it('Dismiss calls the owner', async () => {
    const onDismiss = vi.fn();
    render(<RequestProgressCard {...props(denied(), { onDismiss })} />);
    await userEvent.click(within(card()).getByRole('button', { name: 'Dismiss' }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});

describe('a failed signature', () => {
  it('shows the failure in the danger token with its cause and Allow again, which asks the owner to retry', async () => {
    const onRetry = vi.fn();
    render(<RequestProgressCard {...props(signingFailed(), { onRetry })} />);
    const c = card();
    expect(within(c).getByText('Signing failed')).toBeInTheDocument();
    expect(within(c).getByRole('alert')).toHaveTextContent('wrong passphrase: nothing was signed');
    await userEvent.click(within(c).getByRole('button', { name: 'Allow again' }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('offers no Allow again where Allow is not offered', () => {
    render(<RequestProgressCard {...props(signingFailed(), { canRetry: false })} />);
    expect(within(card()).queryByRole('button', { name: 'Allow again' })).toBeNull();
  });
});

describe('what the card tells next to the line', () => {
  it('a warning of the owner (the notice recipients were not sent) is one line under the stepper', () => {
    render(<RequestProgressCard {...props(stored(), { warning: 'the list of notice recipients was NOT sent' })} />);
    expect(within(card()).getByText('the list of notice recipients was NOT sent').closest('[role="status"]')?.className).toMatch(/text-warning-text/);
  });

  it('uses theme tokens only', () => {
    const { container } = render(<RequestProgressCard {...props(denied())} />);
    expect(container.innerHTML).not.toMatch(/(?:bg|text|border)-(?:red|green|blue|gray|slate|yellow|amber|emerald|orange)-\d/);
    expect(container.innerHTML).not.toMatch(/#[0-9a-f]{3,6}\b/i);
  });
});

describe('what was signed (one-click Allow)', () => {
  const SUMMARY = { short: 'allowed once', full: 'sh "ls" on thinkcentre, allowed once' };
  const signedWith = (): ProgressRecord => reduceProgress(start(), { type: 'signed', summary: SUMMARY }, T0);

  it('the progress line says "Signed: <short summary>", and Details has the full summary', async () => {
    render(<RequestProgressCard {...props(signedWith())} />);
    expect(within(card()).getByText('Signed: allowed once')).toBeInTheDocument();
    expect(within(card()).queryByTestId('signed-summary')).toBeNull();
    await userEvent.click(within(card()).getByRole('button', { name: 'Details' }));
    expect(within(card()).getByTestId('signed-summary')).toHaveTextContent('Signed: sh "ls" on thinkcentre, allowed once');
  });

  it('no summary (an Allow from the dialog or the table): no such line', () => {
    render(<RequestProgressCard {...props(stored())} />);
    expect(within(card()).queryByText(/^Signed:/)).toBeNull();
  });
});
