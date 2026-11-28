import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
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

  it('a step that does not apply is "Not needed": written as such, neither Done nor Current, not marked as the current step', () => {
    render(<VerticalTimeline steps={[...STEPS, { id: 'code', title: 'Security code compared', status: 'skipped', description: 'No code to compare' }]} />);
    const item = screen.getAllByRole('listitem')[3]!;
    expect(item.getAttribute('data-status')).toBe('skipped');
    expect(item.getAttribute('aria-current')).toBeNull();
    expect(within(item).getByText('Not needed')).toBeInTheDocument();
    expect(within(item).queryByText('Done')).toBeNull();
    expect(within(item).queryByText('Current')).toBeNull();
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
    // The visible card is drawn on demand (hover or focus), not kept in the page.
    expect(screen.queryByTestId('tooltip-card')).toBeNull();
  });

  it('shows a distinct state per step with the semantic tokens of the app, never a palette class or a hex value', () => {
    const { container } = render(<VerticalTimeline steps={STEPS} />);
    const markers = Array.from(container.querySelectorAll('[data-part="marker"]'));
    expect(markers[0]).toHaveClass('bg-success', 'border-success', 'text-on-solid');
    expect(markers[1]).toHaveClass('border-primary', 'bg-surface', 'text-primary');
    expect(markers[2]).toHaveClass('border-muted', 'bg-surface', 'text-muted');
    const statuses = Array.from(container.querySelectorAll('[data-part="status"]'));
    expect(statuses.map(s => s.className)).toEqual(['text-xs text-success-text', 'text-xs text-primary', 'text-xs text-muted']);
    // The connector after a done step is the success colour, the others the border token.
    const connectors = Array.from(container.querySelectorAll('[data-part="connector"]'));
    expect(connectors).toHaveLength(2);
    expect(connectors[0]).toHaveClass('bg-success');
    expect(connectors[1]).toHaveClass('bg-border');
    // No Tailwind palette class (a hue name, with or without a shade number) and no arbitrary colour anywhere in the markup.
    const palette = /(?:^|\s)(?:[a-z-]+:)*(?:bg|text|border|ring|fill|stroke|divide|from|to|via)-(?:white|black|slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)(?:-\d{2,3})?(?:\/\d+)?(?=\s|$)/;
    const classes = Array.from(container.querySelectorAll('[class]')).map(el => el.getAttribute('class') ?? '');
    for (const value of classes) {
      expect(value, `palette class in "${value}"`).not.toMatch(palette);
      expect(value, `arbitrary colour in "${value}"`).not.toMatch(/\[#|\[rgb|\[hsl/);
    }
  });

  it('opens the explanation (the tooltip of the design-system icon button) on hover and on keyboard focus, closes it on leave, blur and Escape', async () => {
    render(<VerticalTimeline steps={STEPS} />);
    const button = screen.getByRole('button', { name: 'About: Candidacy received' });
    expect(screen.queryByTestId('tooltip-card')).toBeNull();
    await userEvent.hover(button);
    expect(await screen.findByTestId('tooltip-card')).toHaveTextContent('Answers: a stranger posting a candidacy.');
    await userEvent.unhover(button);
    await waitFor(() => expect(screen.queryByTestId('tooltip-card')).toBeNull());
    await userEvent.tab();
    expect(button).toHaveFocus();
    expect(await screen.findByTestId('tooltip-card')).toHaveTextContent('Answers: a stranger posting a candidacy.');
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByTestId('tooltip-card')).toBeNull());
  });

  it('draws the explanation outside the timeline (portaled by the design system), so no ancestor with an overflow clips it', async () => {
    const { container } = render(<VerticalTimeline steps={STEPS} />);
    await userEvent.tab();
    const card = await screen.findByTestId('tooltip-card');
    expect(container.contains(card)).toBe(false);
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
