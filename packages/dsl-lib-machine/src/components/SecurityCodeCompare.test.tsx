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
