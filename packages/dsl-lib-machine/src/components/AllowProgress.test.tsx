import React from 'react';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { initialProgress, reduceProgress, type ProgressRecord } from '../lib/allowProgress.js';
import { AllowProgress } from './AllowProgress.js';

// The thin stepper under a request (decision 86): four segments with one word each, merged with the determinate bar; the long wording lives in the
// details disclosure (AllowProgressDetails), never here. Accessible (progressbar with a text value), theme tokens only.

const T0 = 1_000_000;
const inbox = { ok: true as const, delivery: 'inbox' as const, target: { uuid: 'u', name: 'thinkcentre' }, version: 1, deliveryText: { tone: 'warning' as const, text: 'thinkcentre is not reachable directly: stored in the relay inbox, ... Cause: connect timed out' } };

function waiting(): ProgressRecord {
  let r = initialProgress({ machineName: 'thinkcentre', held: true, now: T0 });
  r = reduceProgress(r, { type: 'signed' }, T0);
  return reduceProgress(r, { type: 'result', result: inbox }, T0 + 1000);
}

describe('AllowProgress (the thin stepper)', () => {
  it('is one determinate progressbar with the share of done steps', () => {
    render(<AllowProgress record={waiting()} now={T0 + 6000} />);
    const bar = screen.getByRole('progressbar');
    expect(bar).toHaveAttribute('aria-valuemin', '0');
    expect(bar).toHaveAttribute('aria-valuemax', '100');
    expect(bar).toHaveAttribute('aria-valuenow', '50');
  });

  it('shows ONE word per step and nothing else: no cause, no sentence, no vertical list', () => {
    render(<AllowProgress record={waiting()} now={T0 + 6000} />);
    expect(screen.getByTestId('allow-progress')).toHaveTextContent(/^SignedStoredInstalledReleased$/);
    expect(screen.queryByRole('list')).toBeNull();
    expect(screen.queryByText(/Cause/)).toBeNull();
  });

  it('says the state of every step in words in the value text of the progress bar (aria-valuetext), not in titles of the badges', () => {
    render(<AllowProgress record={waiting()} now={T0} />);
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuetext', 'Signed: done, Stored: done, Installed: in progress, Released: pending');
    for (const word of ['Signed', 'Stored', 'Installed', 'Released']) {
      expect(screen.getByText(word).closest('[title]')).toBeNull();
    }
  });

  it('a request nobody waits for has three segments', () => {
    let r = reduceProgress(initialProgress({ machineName: 'thinkcentre', held: false, now: T0 }), { type: 'signed' }, T0);
    r = reduceProgress(r, { type: 'result', result: inbox }, T0);
    render(<AllowProgress record={r} now={T0} />);
    expect(screen.getByTestId('allow-progress')).toHaveTextContent(/^SignedStoredInstalled$/);
  });

  it('only a released request reaches 100; a timeout never does', () => {
    const done = reduceProgress(waiting(), { type: 'hold', answer: { state: 'ended', outcome: 'allowed' } }, T0 + 8000);
    const { unmount } = render(<AllowProgress record={done} now={T0 + 60_000} />);
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '100');
    unmount();
    render(<AllowProgress record={reduceProgress(waiting(), { type: 'timeout' }, T0 + 181_000)} now={T0 + 300_000} />);
    expect(screen.getByRole('progressbar')).not.toHaveAttribute('aria-valuenow', '100');
  });

  it('a failed step is drawn with the danger token', () => {
    const lost = reduceProgress(waiting(), { type: 'timeout' }, T0 + 181_000);
    const { container } = render(<AllowProgress record={lost} now={T0} />);
    expect(container.innerHTML).toMatch(/bg-danger/);
  });

  it('uses theme tokens only: no palette class and no hex colour', () => {
    const { container } = render(<AllowProgress record={waiting()} now={T0} />);
    expect(container.innerHTML).not.toMatch(/(?:bg|text|border)-(?:red|green|blue|gray|slate|yellow|amber|emerald|orange)-\d/);
    expect(container.innerHTML).not.toMatch(/#[0-9a-f]{3,6}\b/i);
  });
});
