import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { SecurityCodeCompare } from './SecurityCodeCompare.js';

// The security code of an approval, first and large, with what the person must do with it: compare it with the candidate machine. Pressing "Codes match" only
// records the comparison on this page; the decisive confirmation is made on the candidate machine (the admin key is pinned there).

const CODE = '12345 67890 12345 67890 12345';

describe('SecurityCodeCompare', () => {
  it('shows the code as given (five groups of five digits) in a group named "Security code", with the sentence that says where it must read the same', () => {
    render(<SecurityCodeCompare code={CODE} name="laptop" />);
    expect(screen.getByLabelText('Security code')).toHaveTextContent(CODE);
    expect(screen.getByText(/must read exactly the same on/)).toHaveTextContent('laptop');
  });

  it('says plainly that the decisive confirmation is made on the candidate machine, where `machine join` shows its own code', () => {
    render(<SecurityCodeCompare code={CODE} name="laptop" onMatch={() => undefined} onDiffer={() => undefined} />);
    const text = document.body.textContent ?? '';
    expect(text).toMatch(/only records your comparison on this page/);
    expect(text).toMatch(/decisive confirmation is made on laptop/);
    expect(text).toContain('machine join');
    expect(text).toMatch(/asks you to confirm/);
  });

  it('"Codes match" and "Codes differ" call back; both are plain buttons of the page', async () => {
    const onMatch = vi.fn();
    const onDiffer = vi.fn();
    render(<SecurityCodeCompare code={CODE} name="laptop" onMatch={onMatch} onDiffer={onDiffer} />);
    await userEvent.click(screen.getByRole('button', { name: 'Codes match' }));
    expect(onMatch).toHaveBeenCalledTimes(1);
    await userEvent.click(screen.getByRole('button', { name: 'Codes differ' }));
    expect(onDiffer).toHaveBeenCalledTimes(1);
  });

  it('answered: no button any more (the answer is final for this approval)', () => {
    render(<SecurityCodeCompare code={CODE} name="laptop" onMatch={() => undefined} onDiffer={() => undefined} answered />);
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.getByLabelText('Security code')).toHaveTextContent(CODE);
  });

  it('read again later (no callback): the code and the sentence, no button, and no claim that this page records anything', () => {
    render(<SecurityCodeCompare code={CODE} name="laptop" />);
    expect(screen.queryByRole('button')).toBeNull();
    expect(document.body.textContent).not.toMatch(/records your comparison/);
    expect(document.body.textContent).toMatch(/decisive confirmation is made on laptop/);
  });
});

describe('SecurityCodeCompare: layout and the comparison held back', () => {
  it('shows the 25 digits as five groups of five in a grid of five columns, so a group is never cut and the line never breaks 20 + 5', () => {
    render(<SecurityCodeCompare code={CODE} name="laptop" />);
    const group = screen.getByLabelText('Security code');
    const cells = Array.from(group.children);
    expect(cells.map((c) => c.textContent)).toEqual(['12345', '67890', '12345', '67890', '12345']);
    expect(group.className).toMatch(/grid-cols-5/);
    expect(cells.every((c) => /whitespace-nowrap/.test(c.className))).toBe(true);
  });

  it('a code that is not five groups is shown as given, in one piece', () => {
    render(<SecurityCodeCompare code="not a code" name="laptop" />);
    expect(screen.getByLabelText('Security code')).toHaveTextContent('not a code');
  });

  it('held back (the documents are not delivered): no "Codes match" and no "Codes differ", ONE line says why, and the code stays readable', () => {
    render(<SecurityCodeCompare code={CODE} name="laptop" onMatch={() => undefined} onDiffer={() => undefined} heldBack="Comparing the codes waits until every machine has its documents." />);
    expect(screen.queryByRole('button', { name: 'Codes match' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Codes differ' })).toBeNull();
    expect(screen.getByText('Comparing the codes waits until every machine has its documents.')).toBeInTheDocument();
    expect(screen.getByLabelText('Security code')).toHaveTextContent(CODE);
    // The sentence that describes the buttons is gone with them.
    expect(document.body.textContent).not.toMatch(/only records your comparison/);
  });

  it('the command of the sentence is monospace, with no backtick', () => {
    render(<SecurityCodeCompare code={CODE} name="laptop" />);
    expect(document.body.textContent).not.toContain('`');
    expect(screen.getByText('machine join')).toBeInTheDocument();
  });
});
