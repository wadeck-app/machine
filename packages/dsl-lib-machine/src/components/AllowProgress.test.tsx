import React from 'react';
import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { initialProgress, reduceProgress, type ProgressRecord } from '../lib/allowProgress.js';
import { AllowProgress } from './AllowProgress.js';

// The steps and the bar after "Allow and sign" (decision 86): accessible (progressbar, live status), theme tokens only.

const T0 = 1_000_000;
const inbox = { ok: true as const, delivery: 'inbox' as const, target: { uuid: 'u', name: 'thinkcentre' }, version: 1, deliveryText: { tone: 'warning' as const, text: 'thinkcentre is not reachable directly: stored in the relay inbox, ... Cause: connect timed out' } };

function waiting(): ProgressRecord {
  let r = initialProgress({ machineName: 'thinkcentre', held: true, now: T0 });
  r = reduceProgress(r, { type: 'signed' }, T0);
  return reduceProgress(r, { type: 'result', result: inbox }, T0 + 1000);
}

describe('AllowProgress', () => {
  it('a determinate progressbar with the share of done steps, and the elapsed time', () => {
    render(<AllowProgress record={waiting()} now={T0 + 6000} />);
    const bar = screen.getByRole('progressbar');
    expect(bar).toHaveAttribute('aria-valuemin', '0');
    expect(bar).toHaveAttribute('aria-valuemax', '100');
    expect(bar).toHaveAttribute('aria-valuenow', '50');
    expect(screen.getByText('6 s')).toBeInTheDocument();
  });

  it('lists the steps in a live status region with their state in words, and the path with its cause', () => {
    render(<AllowProgress record={waiting()} now={T0 + 6000} />);
    const status = screen.getByTestId('allow-progress-steps');
    expect(status).toHaveAttribute('aria-live', 'polite');
    const items = within(status).getAllByRole('listitem');
    expect(items.map((i) => i.textContent)).toEqual([
      expect.stringMatching(/done.*Signed/),
      expect.stringMatching(/done.*Stored on the relay/),
      expect.stringMatching(/in progress.*thinkcentre installs the policy.*next inbox poll/),
      expect.stringMatching(/pending.*The held command is released/),
    ]);
    expect(status).toHaveTextContent('Cause: connect timed out');
  });

  it('only a done last step reaches 100 and the success wording', () => {
    const done = reduceProgress(waiting(), { type: 'hold', answer: { state: 'ended', outcome: 'allowed' } }, T0 + 8000);
    render(<AllowProgress record={done} now={T0 + 60_000} />);
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '100');
    expect(screen.getByText('The held command was released')).toBeInTheDocument();
    // The time stops at the end.
    expect(screen.getByText('8 s')).toBeInTheDocument();
  });

  it('a timeout shows the honest message and no success', () => {
    const lost = reduceProgress(waiting(), { type: 'timeout' }, T0 + 181_000);
    render(<AllowProgress record={lost} now={T0 + 300_000} />);
    expect(screen.getByTestId('allow-progress-steps')).toHaveTextContent('no confirmation from thinkcentre: it may be offline, or it runs an older build: check machine requests thinkcentre');
    expect(screen.getByRole('progressbar')).not.toHaveAttribute('aria-valuenow', '100');
    expect(screen.queryByText('The held command was released')).toBeNull();
  });

  it('uses theme tokens only: no palette class and no hex colour', () => {
    const { container } = render(<AllowProgress record={waiting()} now={T0} />);
    expect(container.innerHTML).not.toMatch(/(?:bg|text|border)-(?:red|green|blue|gray|slate|yellow|amber|emerald|orange)-\d/);
    expect(container.innerHTML).not.toMatch(/#[0-9a-f]{3,6}\b/i);
  });
});
