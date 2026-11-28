import React from 'react';
import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { initialProgress, reduceProgress, type ProgressRecord } from '../lib/allowProgress.js';
import { AllowProgressDetails } from './AllowProgressDetails.js';

// The content of the Details disclosure of a request: the vertical steps with their state in words, and the long explanation, said ONCE.

const T0 = 1_000_000;
const CAUSE = "thinkcentre's clock is 3 min behind this machine (its time 10:00:00, this machine 10:03:00): fix its time sync (Linux: `timedatectl status`)";
const inbox = { ok: true as const, delivery: 'inbox' as const, target: { uuid: 'u', name: 'thinkcentre' }, version: 4, fallback: { code: 'refused', cause: CAUSE }, deliveryText: { tone: 'warning' as const, text: `thinkcentre did not take the document directly: stored in the relay inbox, it installs it when it comes back (next poll within 60 s). Cause: ${CAUSE}` } };

function waiting(): ProgressRecord {
  let r = initialProgress({ machineName: 'thinkcentre', held: true, now: T0 });
  r = reduceProgress(r, { type: 'signed' }, T0);
  return reduceProgress(r, { type: 'result', result: inbox }, T0 + 1000);
}

describe('AllowProgressDetails', () => {
  it('lists the four steps with their state in words, in a polite live region', () => {
    render(<AllowProgressDetails record={waiting()} />);
    const status = screen.getByTestId('allow-progress-steps');
    expect(status).toHaveAttribute('aria-live', 'polite');
    expect(within(status).getAllByRole('listitem').map((i) => i.textContent)).toEqual([
      expect.stringMatching(/^doneSigned$/),
      expect.stringMatching(/^doneStored on the relay$/),
      expect.stringMatching(/^in progressthinkcentre installs the policy.*next inbox poll/),
      expect.stringMatching(/^pendingThe held command is released$/),
    ]);
  });

  it('carries the long explanation (with the fix) once, and the policy version with the CLI command that lists it', () => {
    render(<AllowProgressDetails record={waiting()} />);
    expect(screen.getAllByText(/fix its time sync/)).toHaveLength(1);
    expect(screen.getByText(/Policy version 4/)).toHaveTextContent('`machine allowed thinkcentre` lists it');
  });

  it('does not repeat the cause of a failed step: the row above the stepper says it', () => {
    const r = reduceProgress(waiting(), { type: 'hold', answer: { state: 'ended', outcome: 'denied' } }, T0 + 2000);
    render(<AllowProgressDetails record={r} />);
    expect(screen.getByText(/not released/i)).toBeInTheDocument();
    expect(screen.queryByText(/denied: nothing ran/)).toBeNull();
  });

  it('says it when the page could not ask the daemon, and that it asks again', () => {
    render(<AllowProgressDetails record={reduceProgress(waiting(), { type: 'poll-error', message: 'daemon unreachable' }, T0 + 3000)} />);
    expect(screen.getByText(/could not ask.*just now \(daemon unreachable\); it asks again/)).toBeInTheDocument();
  });

  it('names the machine in the machine font', () => {
    render(<AllowProgressDetails record={waiting()} />);
    const names = screen.getAllByText('thinkcentre');
    expect(names.length).toBeGreaterThan(0);
    expect(names.every((el) => el.style.fontFamily.includes('JetBrains Mono'))).toBe(true);
  });
});
