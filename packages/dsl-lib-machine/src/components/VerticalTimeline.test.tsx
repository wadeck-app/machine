import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { VerticalTimeline, type TimelineStep } from './VerticalTimeline.js';

const STEPS: TimelineStep[] = [
  { id: 'received', title: 'Candidacy received', status: 'done', info: 'Answers: a stranger posting a candidacy.' },
  { id: 'checked', title: 'Details checked', status: 'current', description: 'Name and address match', info: 'Answers: substitution of the key.' },
  { id: 'signed', title: 'Passphrase and signature', status: 'todo' },
];

describe('VerticalTimeline', () => {
  it('lists every step in order with its title', () => {
    render(<VerticalTimeline steps={STEPS} />);
    const items = screen.getAllByRole('listitem');
    expect(items).toHaveLength(3);
    expect(items[0]).toHaveTextContent(/^Candidacy received/);
    expect(items[1]).toHaveTextContent(/^Details checked/);
    expect(items[2]).toHaveTextContent(/^Passphrase and signature/);
  });

  it('marks the current step for assistive technology and exposes every status', () => {
    render(<VerticalTimeline steps={STEPS} />);
    const items = screen.getAllByRole('listitem');
    expect(items.map(li => li.getAttribute('data-status'))).toEqual(['done', 'current', 'todo']);
    expect(items.map(li => li.getAttribute('aria-current'))).toEqual([null, 'step', null]);
    // The status is also written, not only coloured.
    expect(within(items[0]!).getByText('Done')).toBeInTheDocument();
    expect(within(items[1]!).getByText('Current')).toBeInTheDocument();
    expect(within(items[2]!).getByText('To do')).toBeInTheDocument();
  });

  it('shows the description of a step', () => {
    render(<VerticalTimeline steps={STEPS} />);
    expect(screen.getByText('Name and address match')).toBeInTheDocument();
  });

  it('gives the info text of a step as a tooltip on a named "i" button, and no button for a step without info', () => {
    render(<VerticalTimeline steps={STEPS} />);
    const button = screen.getByRole('button', { name: 'About: Details checked' });
    expect(button).toHaveAccessibleDescription('Answers: substitution of the key.');
    expect(screen.getAllByRole('button')).toHaveLength(2);
    expect(screen.getAllByRole('tooltip')).toHaveLength(2);
  });

  it('refuses an empty list loudly instead of rendering nothing', () => {
    render(<VerticalTimeline steps={[]} />);
    expect(screen.getByRole('alert')).toHaveTextContent('VerticalTimeline: no step given');
  });

  it('refuses two steps with the same id, naming it', () => {
    render(<VerticalTimeline steps={[STEPS[0]!, { ...STEPS[1]!, id: 'received' }]} />);
    expect(screen.getByRole('alert')).toHaveTextContent('duplicate step id "received"');
  });
});
