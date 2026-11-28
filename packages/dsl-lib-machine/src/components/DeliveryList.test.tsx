import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { DeliveryMachine } from '../lib/approvalResult.js';
import { DeliveryList } from './DeliveryList.js';

// One short line per machine: state, one reason, and a next action ONLY when there is something to do (UX review: no bare "nothing to do", no command said twice).

const RETRY = 'machine admin distribute 22222222-2222-4222-8222-222222222222';
const m = (over: Partial<DeliveryMachine>): DeliveryMachine => ({ uuid: 'u', name: 'server', state: 'delivered', code: 'direct', reason: 'took the documents directly', next: 'nothing to do', ...over });

describe('DeliveryList', () => {
  it('a bare "nothing to do" is not a line', () => {
    render(<DeliveryList machines={[m({})]} text="" />);
    const item = within(screen.getByRole('list', { name: 'Machines told' })).getByRole('listitem');
    expect(item).toHaveTextContent('took the documents directly');
    expect(item).not.toHaveTextContent(/nothing to do/i);
  });

  it('a next action that is a real action is shown, its command in monospace and without backticks', () => {
    render(<DeliveryList machines={[m({ uuid: 'a', name: 'phone', state: 'inbox', code: 'peer-too-old', reason: 'too old', next: 'update it with `app-core-cli update` there' })]} text="" />);
    expect(screen.getByText('app-core-cli update')).toBeInTheDocument();
    expect(screen.getByRole('list').textContent).not.toContain('`');
  });

  it('a note that only reassures ("installs by itself when it is back, nothing to do") is kept: it explains the waiting', () => {
    render(<DeliveryList machines={[m({ state: 'inbox', code: 'unreachable', reason: 'offline', next: 'installs by itself when it is back, nothing to do' })]} text="" />);
    expect(screen.getByRole('list')).toHaveTextContent('installs by itself when it is back, nothing to do');
  });

  it('the command the result already says above (its headline) is not repeated on each machine', () => {
    render(<DeliveryList machines={[m({ uuid: 'a', state: 'failed', code: 'not-stored', reason: 'documents not stored', next: `run \`${RETRY}\`` }), m({ uuid: 'b', name: 'mac', state: 'failed', code: 'not-stored', reason: 'documents not stored', next: `run \`${RETRY}\`` })]} said={RETRY} text="" />);
    expect(screen.queryByText(RETRY)).toBeNull();
    expect(screen.getAllByRole('listitem')).toHaveLength(2);
  });
});

describe('Retry delivery and the terminal command (UX review 4, e)', () => {
  const REPORT = `[error] server (x): peer document not stored: relay down\n[warn] the approval stands: nothing was undone. Run \`${RETRY}\` to send what is missing; it is safe to run again`;
  const failedMachine = m({ state: 'failed', code: 'not-stored', reason: 'documents not stored', next: `run \`${RETRY}\`` });

  it('a failed delivery offers a Retry delivery button that calls the retry, with no passphrase field', async () => {
    const onRetry = vi.fn(async () => undefined);
    render(<DeliveryList machines={[failedMachine]} text={REPORT} retryCommand={RETRY} onRetry={onRetry} />);
    await userEvent.click(screen.getByRole('button', { name: 'Retry delivery' }));
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(screen.queryByLabelText(/passphrase/i)).toBeNull();
  });

  it('no Retry delivery when nothing can be retried (delivered)', () => {
    render(<DeliveryList machines={[m({})]} text="[ok] done" />);
    expect(screen.queryByRole('button', { name: 'Retry delivery' })).toBeNull();
  });

  it('the button is busy while the retry runs (no second click)', async () => {
    let finish: () => void = () => undefined;
    const onRetry = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
    render(<DeliveryList machines={[failedMachine]} text={REPORT} retryCommand={RETRY} onRetry={onRetry} />);
    await userEvent.click(screen.getByRole('button', { name: 'Retry delivery' }));
    expect(screen.getByRole('button', { name: /Retry delivery/ })).toBeDisabled();
    await userEvent.click(screen.getByRole('button', { name: /Retry delivery/ }));
    expect(onRetry).toHaveBeenCalledTimes(1);
    finish();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Retry delivery' })).toBeEnabled());
  });

  it('a retry that fails says why, as an alert, and the terminal command is still there', async () => {
    const onRetry = vi.fn(async () => { throw new Error('the daemon holds nothing to retry for this machine (it restarted)'); });
    render(<DeliveryList machines={[failedMachine]} text={REPORT} retryCommand={RETRY} onRetry={onRetry} />);
    await userEvent.click(screen.getByRole('button', { name: 'Retry delivery' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('the daemon holds nothing to retry for this machine (it restarted)');
    expect(screen.getByRole('button', { name: 'Retry delivery' })).toBeEnabled();
  });

  it('the terminal command is said ONCE: folded under "Run it in a terminal instead" with a Copy button, never in the machine lines or in the raw report', async () => {
    render(<DeliveryList machines={[failedMachine]} text={REPORT} retryCommand={RETRY} onRetry={vi.fn(async () => undefined)} said={RETRY} />);
    // Folded: not on screen.
    expect(screen.queryByText(RETRY)).toBeNull();
    expect(document.body.textContent).not.toContain(RETRY);
    // The raw report is folded (UX review 5), then open without the command, and still says what happened.
    expect(screen.queryByText(/relay down/)).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Details' }));
    expect(screen.getByText(/relay down/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Run it in a terminal instead' }));
    expect(screen.getAllByText(RETRY)).toHaveLength(1);
    expect(document.body.textContent?.split(RETRY).length).toBe(2);
    expect(screen.getByRole('button', { name: 'Copy command' })).toBeInTheDocument();
  });

  it('Copy command puts the command on the clipboard and says so; a browser without clipboard says how to copy it by hand', async () => {
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    render(<DeliveryList machines={[failedMachine]} text={REPORT} retryCommand={RETRY} onRetry={vi.fn(async () => undefined)} />);
    await userEvent.click(screen.getByRole('button', { name: 'Run it in a terminal instead' }));
    await userEvent.click(screen.getByRole('button', { name: 'Copy command' }));
    expect(writeText).toHaveBeenCalledWith(RETRY);
    expect(await screen.findByText('Command copied.')).toBeInTheDocument();
    Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true });
    await userEvent.click(screen.getByRole('button', { name: 'Copy command' }));
    expect(await screen.findByText(/Could not copy/)).toBeInTheDocument();
  });
});

describe('Retry delivery first, the terminal only when the daemon holds nothing (UX review 5, 4)', () => {
  const REPORT = `[error] server (x): peer document not stored: relay down\n[warn] the rename stands: nothing was undone. The machines above do not know it yet. Run \`${RETRY}\` to send what is missing; it is safe to run again`;
  const failedMachine = m({ state: 'failed', code: 'not-stored', reason: 'documents not stored', next: `run \`${RETRY}\`` });

  it('Details is folded by default, on a failure too: the machine lines and the buttons are what the person reads first', () => {
    render(<DeliveryList machines={[failedMachine]} text={REPORT} retryCommand={RETRY} onRetry={vi.fn(async () => undefined)} />);
    expect(screen.getByRole('button', { name: 'Details' })).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText(/relay down/)).toBeNull();
  });

  it('with Retry delivery, the raw report sends the person to Retry first and to the terminal only if Retry says nothing is kept', async () => {
    render(<DeliveryList machines={[failedMachine]} text={REPORT} retryCommand={RETRY} onRetry={vi.fn(async () => undefined)} />);
    await userEvent.click(screen.getByRole('button', { name: 'Details' }));
    const report = screen.getByText(/relay down/).closest('pre') as HTMLElement;
    expect(report.textContent).toMatch(/Retry delivery/);
    expect(report.textContent).toMatch(/only if Retry delivery says/);
    expect(report.textContent).not.toMatch(/Run the terminal command/);
    expect(report.textContent).not.toContain(RETRY);
  });

  it('the folded terminal section says when to use it: after Retry delivery says nothing is kept (the daemon restarted)', async () => {
    render(<DeliveryList machines={[failedMachine]} text={REPORT} retryCommand={RETRY} onRetry={vi.fn(async () => undefined)} />);
    await userEvent.click(screen.getByRole('button', { name: 'Run it in a terminal instead' }));
    const section = screen.getByText(RETRY).closest('div')?.parentElement as HTMLElement;
    expect(section.textContent).toMatch(/Only when Retry delivery says/);
    expect(section.textContent).toMatch(/restarted/);
  });

  it('without Retry delivery the terminal command is THE way: no mention of a button that is not there', async () => {
    render(<DeliveryList machines={[failedMachine]} text={REPORT} retryCommand={RETRY} />);
    expect(screen.queryByRole('button', { name: 'Retry delivery' })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Details' }));
    const report = screen.getByText(/relay down/).closest('pre') as HTMLElement;
    expect(report.textContent).toMatch(/Run the terminal command/);
    expect(report.textContent).not.toMatch(/Retry delivery/);
    await userEvent.click(screen.getByRole('button', { name: 'Run it in a terminal instead' }));
    expect(document.body.textContent).not.toMatch(/Only when Retry delivery says/);
  });

  it('a note about the command (why the same name twice) is shown with the command, in one clause', async () => {
    const note = 'The name is given twice on purpose: it is how `machine admin rename` sends the documents again, nothing is renamed.';
    render(<DeliveryList machines={[failedMachine]} text={REPORT} retryCommand={RETRY} retryNote={note} onRetry={vi.fn(async () => undefined)} />);
    expect(document.body.textContent).not.toContain('given twice');
    await userEvent.click(screen.getByRole('button', { name: 'Run it in a terminal instead' }));
    expect(screen.getByText(/given twice on purpose/)).toBeInTheDocument();
  });
});
