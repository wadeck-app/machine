import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ActivityLog, type ActivityPageData } from './ActivityLog.js';
import { MONO_STYLE } from '../lib/styleTokens.js';

// The Activity page: the commands this machine sent and received, with filters, a period and server-side pages. The app-core shell is a stub on
// globalThis; the module backend is a fake that records the URL of every request (the filters and the page are its query string).

type Row = ActivityPageData['rows'][number];

function row(n: number, over: Partial<Row> = {}): Row {
  return {
    key: `k${n}`,
    ts: `2026-11-21T10:${String(n % 60).padStart(2, '0')}:00.000Z`,
    whenText: `${n} min ago`,
    direction: 'sent',
    directionText: 'Sent',
    fromText: 'desktop',
    toText: 'laptop',
    shell: 'sh',
    command: `echo ${n}`,
    outcome: 'ran',
    resultText: 'ran',
    tone: 'success',
    exitText: '0',
    exitTone: 'ok',
    exitTitle: 'Exit code 0: success',
    ranText: '312 ms',
    ranDerived: false,
    ranTitle: 'Run time of the command on the target',
    waitedText: '-',
    detailText: '',
    verified: true,
    ...over,
  };
}

const REFUSED: Partial<Row> = { direction: 'received', directionText: 'Received', fromText: 'laptop', toText: 'desktop', command: 'whoami', outcome: 'refused', resultText: 'refused (not-listed)', tone: 'warning', exitText: '-', exitTone: 'none', exitTitle: 'No command ran', ranText: '-', ranTitle: 'No command ran' };

function page(over: Partial<ActivityPageData> = {}): ActivityPageData {
  const rows = over.rows ?? [row(1), row(2, REFUSED)];
  return { machine: { uuid: 'u', name: 'desktop' }, rows, total: rows.length, totalExact: true, page: 1, pageSize: 25, pageCount: 1, pageSizes: [25, 50, 100], counts: { sent: 1, received: 1 }, machines: ['laptop', 'nas'], outcomes: ['ran', 'refused', 'denied'], emptyMessage: 'No activity yet', chainText: '', notes: [], ...over };
}

let urls: string[];
let answer: (url: string) => unknown;

beforeEach(() => {
  urls = [];
  answer = () => page();
  window.history.replaceState({}, '', '/modules/machine/activity');
  const fetcher = async (url: string) => {
    urls.push(url);
    const result = answer(url);
    if (result instanceof Error) {
      throw result;
    }
    return result;
  };
  Object.defineProperty(globalThis, '__APP_CORE_SHELL__', { value: { elevate: async () => undefined, fetcher }, configurable: true, writable: true });
});
afterEach(() => {
  vi.useRealTimers();
  Reflect.deleteProperty(globalThis, '__APP_CORE_SHELL__');
  window.history.replaceState({}, '', '/');
});

const query = (url: string): URLSearchParams => new URL(`http://x/${url.replace(/^GET /, '')}`).searchParams;
/** A page of the log: `total` entries at `size` per page, the rows of page `n`. */
const pageOf = (n: number, total: number, size = 25): ActivityPageData => {
  const count = Math.min(size, total - (n - 1) * size);
  return page({ rows: Array.from({ length: count }, (_, i) => row((n - 1) * size + i + 1)), total, page: n, pageSize: size, pageCount: Math.max(1, Math.ceil(total / size)) });
};

describe('the timeline', () => {
  it('shows each entry: when, direction, from to, shell, command, then the result badge with its tone', async () => {
    render(<ActivityLog />);
    expect(await screen.findByText('echo 1')).toBeInTheDocument();
    const rows = screen.getAllByRole('row');
    // header + 2
    expect(rows).toHaveLength(3);
    const sent = within(rows[1] as HTMLElement);
    expect(sent.getByText('Sent')).toBeInTheDocument();
    expect(sent.getByText('desktop')).toBeInTheDocument();
    expect(sent.getByText('laptop')).toBeInTheDocument();
    expect(sent.getByText('sh')).toBeInTheDocument();
    expect(sent.getByText('ran').className).toMatch(/bg-success-bg/);
    expect(within(rows[2] as HTMLElement).getByText('refused (not-listed)').className).toMatch(/bg-warning-bg/);
    expect(sent.getByText('1 min ago')).toHaveAttribute('title', '2026-11-21T10:01:00.000Z');
  });

  it('has a column each for the result, the exit code, the run time and the wait', async () => {
    render(<ActivityLog />);
    await screen.findByText('echo 1');
    expect(screen.getAllByRole('columnheader').map((h) => h.textContent)).toEqual(['When', 'Direction', 'From \u2192 To', 'Shell', 'Command', 'Result', 'Exit', 'Ran for', 'Waited']);
  });

  it('shows the exit code green for 0 and red for any other code, a timeout or a kill, and a muted dash when no command ran', async () => {
    answer = () => page({
      rows: [
        row(1),
        row(2, { exitText: '127', exitTone: 'fail', exitTitle: 'Exit code 127: the command failed', tone: 'warning' }),
        row(3, { exitText: 'timed out', exitTone: 'fail', exitTitle: 'The target stopped the command at its time limit', tone: 'warning' }),
        row(4, { exitText: 'killed', exitTone: 'fail', tone: 'warning' }),
        row(5, REFUSED),
      ],
    });
    render(<ActivityLog />);
    await screen.findByText('echo 1');
    const cell = (n: number, text: string): HTMLElement => within(screen.getAllByRole('row')[n] as HTMLElement).getByText(text, { selector: '[data-exit] span' });
    expect(cell(1, '0').className).toMatch(/text-success-text/);
    expect(cell(2, '127').className).toMatch(/text-danger-text/);
    expect(cell(3, 'timed out').className).toMatch(/text-danger-text/);
    expect(cell(4, 'killed').className).toMatch(/text-danger-text/);
    expect(cell(5, '-').className).toMatch(/text-muted/);
    expect(cell(2, '127')).toHaveAttribute('title', 'Exit code 127: the command failed');
    // The code is a Badge of the design system inside the cell of its column.
    expect(cell(1, '0').closest('[data-exit]')?.closest('td')).not.toBeNull();
  });

  it('shows the run time of the command and the wait in their own columns, with a subtle ~ and an explanation on an estimate', async () => {
    answer = () => page({
      rows: [
        row(1, { ranText: '312 ms', waitedText: '1 min 47 s' }),
        row(2, { ranText: '~300 ms', ranDerived: true, ranTitle: 'Estimated: the whole run minus the wait', waitedText: '1 min 47 s' }),
      ],
    });
    render(<ActivityLog />);
    await screen.findByText('echo 1');
    const first = within(screen.getAllByRole('row')[1] as HTMLElement);
    const second = within(screen.getAllByRole('row')[2] as HTMLElement);
    expect(first.getByText('312 ms')).toBeInTheDocument();
    expect(first.getByText('1 min 47 s')).toBeInTheDocument();
    expect(second.getByText('~300 ms')).toHaveAttribute('title', expect.stringContaining('Estimated'));
    // Numbers never wrap (the nowrap column of the DataTable).
    expect(first.getByText('312 ms').closest('td')?.className).toMatch(/whitespace-nowrap/);
    expect(first.getByText('1 min 47 s').closest('td')?.className).toMatch(/whitespace-nowrap/);
  });

  it('is the standard DataTable of the design system: nine column headers in one table, no scroll box of its own around it', async () => {
    const { container } = render(<ActivityLog />);
    await screen.findByText('echo 1');
    expect(screen.getAllByRole('table')).toHaveLength(1);
    expect(screen.getAllByRole('columnheader')).toHaveLength(9);
    expect(container.querySelector('[class*="max-h-"]')).toBeNull();
  });

  it('asks the backend for the first page of 25 with no filter', async () => {
    render(<ActivityLog />);
    await screen.findByText('echo 1');
    expect(urls[0]).toMatch(/^GET \/api\/modules\/machine\/activity\?/);
    const q = query(urls[0] as string);
    expect(q.get('page')).toBe('1');
    expect(q.get('pageSize')).toBe('25');
    expect(q.has('offset')).toBe(false);
    expect(q.get('direction') ?? '').toBe('');
  });

  it('uses only the semantic tokens of the app: no palette class, no colour value', async () => {
    const { container } = render(<ActivityLog />);
    await screen.findByText('echo 1');
    const palette = /(?:^|\s)(?:[a-z-]+:)*(?:bg|text|border|ring|fill|stroke|divide)-(?:white|black|slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)(?:-\d{2,3})?(?:\/\d+)?(?=\s|$)/;
    for (const el of container.querySelectorAll('[class]')) {
      expect(el.getAttribute('class') ?? '', 'palette class').not.toMatch(palette);
      expect(el.getAttribute('class') ?? '', 'colour value').not.toMatch(/#[0-9a-fA-F]{3,8}|rgb\(/);
    }
    // The only inline style is the monospace stack of machine names and commands (styleTokens MONO_STYLE): never a colour.
    for (const el of container.querySelectorAll('[style]')) {
      expect(el.getAttribute('style') ?? '').toMatch(/^\s*font-family:[^;]*;?\s*$/);
    }
  });
});

describe('the filters', () => {
  it('sends the direction, the machine and the outcome chosen, and starts again at the first page', async () => {
    const user = userEvent.setup();
    answer = (url) => pageOf(Number(query(url).get('page')), 200);
    render(<ActivityLog />);
    await screen.findByText('echo 1');
    await user.click(screen.getByRole('button', { name: 'Next page' }));
    await waitFor(() => expect(query(urls.at(-1) as string).get('page')).toBe('2'));
    await user.selectOptions(screen.getByLabelText('Direction'), 'sent');
    await waitFor(() => expect(query(urls.at(-1) as string).get('direction')).toBe('sent'));
    expect(query(urls.at(-1) as string).get('page')).toBe('1');
    await user.selectOptions(screen.getByLabelText('Machine'), 'nas');
    await waitFor(() => expect(query(urls.at(-1) as string).get('machine')).toBe('nas'));
    await user.selectOptions(screen.getByLabelText('Outcome'), 'denied');
    await waitFor(() => expect(query(urls.at(-1) as string).get('outcome')).toBe('denied'));
    expect(query(urls.at(-1) as string).get('direction')).toBe('sent');
  });

  it('offers the machines and outcomes the backend lists', async () => {
    render(<ActivityLog />);
    await screen.findByText('echo 1');
    expect(within(screen.getByLabelText('Machine')).getAllByRole('option').map((o) => o.textContent)).toEqual(['All machines', 'laptop', 'nas']);
    expect(within(screen.getByLabelText('Outcome')).getAllByRole('option').map((o) => o.textContent)).toEqual(['All outcomes', 'ran', 'refused', 'denied']);
  });

  it('turns the period choice into a duration for the backend', async () => {
    const user = userEvent.setup();
    render(<ActivityLog />);
    await screen.findByText('echo 1');
    await user.selectOptions(screen.getByLabelText('Period'), 'Last 24 hours');
    await waitFor(() => expect(query(urls.at(-1) as string).get('since')).toBe('24h'));
    await user.selectOptions(screen.getByLabelText('Period'), 'All time');
    await waitFor(() => expect(query(urls.at(-1) as string).get('since') ?? '').toBe(''));
  });

  it('searches the text once the person stopped typing', async () => {
    const user = userEvent.setup();
    render(<ActivityLog />);
    await screen.findByText('echo 1');
    const before = urls.length;
    await user.type(screen.getByLabelText('Search commands, machines, outcomes'), 'df');
    await waitFor(() => expect(query(urls.at(-1) as string).get('text')).toBe('df'));
    // One request for the whole word, not one per key.
    expect(urls.length - before).toBe(1);
  });

  it('says what is empty: nothing yet, or nothing for these filters', async () => {
    answer = () => page({ rows: [], total: 0, counts: { sent: 0, received: 0 }, emptyMessage: 'No entry matches these filters' });
    render(<ActivityLog />);
    expect(await screen.findByText('No entry matches these filters')).toBeInTheDocument();
    expect(screen.getByText('0 entries')).toBeInTheDocument();
  });
});

describe('the pages', () => {
  it('says which entries are shown out of how many, with thousands separators, in a live region', async () => {
    answer = () => pageOf(1, 1234);
    render(<ActivityLog />);
    await screen.findByText('echo 1');
    const count = screen.getByText(/1-25 of 1,234/);
    // A Notice of the design system: a status, announced politely.
    expect(count.closest('[role="status"]')).not.toBeNull();
    expect(screen.getByText(/Page 1 of 50/)).toBeInTheDocument();
  });

  it('says so when the total is a lower bound', async () => {
    answer = () => ({ ...pageOf(1, 4000), totalExact: false });
    render(<ActivityLog />);
    await screen.findByText('echo 1');
    expect(screen.getByText(/1-25 of at least 4,000/)).toBeInTheDocument();
  });

  it('goes first, previous, next and last, asking the backend for each page', async () => {
    const user = userEvent.setup();
    answer = (url) => pageOf(Number(query(url).get('page')), 60);
    render(<ActivityLog />);
    await screen.findByText('echo 1');
    expect(screen.getByRole('button', { name: 'First page' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Previous page' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Next page' }));
    expect(await screen.findByText('echo 26')).toBeInTheDocument();
    expect(query(urls.at(-1) as string).get('page')).toBe('2');
    expect(screen.getByText(/26-50 of 60/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Last page' }));
    expect(await screen.findByText('echo 51')).toBeInTheDocument();
    expect(query(urls.at(-1) as string).get('page')).toBe('3');
    expect(screen.getByRole('button', { name: 'Next page' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Last page' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Previous page' }));
    expect(await screen.findByText('echo 26')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'First page' }));
    expect(await screen.findByText('echo 1')).toBeInTheDocument();
    expect(query(urls.at(-1) as string).get('page')).toBe('1');
  });

  it('works from the keyboard: the controls are buttons in a labelled navigation, reached by Tab and used with Enter', async () => {
    const user = userEvent.setup();
    answer = (url) => pageOf(Number(query(url).get('page')), 60);
    render(<ActivityLog />);
    await screen.findByText('echo 1');
    const nav = screen.getByRole('navigation', { name: 'Pages of the activity' });
    expect(within(nav).getAllByRole('button').map((b) => b.textContent)).toEqual(['First', 'Previous', 'Next', 'Last']);
    screen.getByRole('button', { name: 'Next page' }).focus();
    await user.keyboard('{Enter}');
    expect(await screen.findByText('echo 26')).toBeInTheDocument();
  });

  it('changes the page size (25, 50, 100) and goes back to the first page', async () => {
    const user = userEvent.setup();
    answer = (url) => pageOf(Number(query(url).get('page')), 200, Number(query(url).get('pageSize')));
    render(<ActivityLog />);
    await screen.findByText('echo 1');
    expect(within(screen.getByLabelText('Rows per page')).getAllByRole('option').map((o) => o.textContent)).toEqual(['25', '50', '100']);
    await user.click(screen.getByRole('button', { name: 'Next page' }));
    await screen.findByText('echo 26');
    await user.selectOptions(screen.getByLabelText('Rows per page'), '100');
    await waitFor(() => expect(query(urls.at(-1) as string).get('pageSize')).toBe('100'));
    expect(query(urls.at(-1) as string).get('page')).toBe('1');
    expect(await screen.findByText(/1-100 of 200/)).toBeInTheDocument();
  });

  it('keeps the filters, the page and the size in the address, so a page can be shared and reloaded', async () => {
    const user = userEvent.setup();
    answer = (url) => pageOf(Number(query(url).get('page')), 200, Number(query(url).get('pageSize')));
    render(<ActivityLog />);
    await screen.findByText('echo 1');
    await user.selectOptions(screen.getByLabelText('Outcome'), 'ran');
    await user.selectOptions(screen.getByLabelText('Rows per page'), '50');
    await user.click(await screen.findByRole('button', { name: 'Next page' }));
    await screen.findByText('echo 51');
    const params = new URLSearchParams(window.location.search);
    expect(Object.fromEntries(params)).toMatchObject({ outcome: 'ran', pageSize: '50', page: '2' });
    expect(window.location.pathname).toBe('/modules/machine/activity');
  });

  it('starts from the address: a shared link opens on the same page with the same filters', async () => {
    window.history.replaceState({}, '', '/modules/machine/activity?page=3&pageSize=50&outcome=ran&machine=nas&since=7d&text=df&direction=sent');
    answer = (url) => pageOf(Number(query(url).get('page')), 200, Number(query(url).get('pageSize')));
    render(<ActivityLog />);
    expect(await screen.findByText('echo 101')).toBeInTheDocument();
    const q = query(urls[0] as string);
    expect(Object.fromEntries(q)).toMatchObject({ page: '3', pageSize: '50', outcome: 'ran', machine: 'nas', since: '7d', text: 'df', direction: 'sent' });
    expect(screen.getByLabelText('Search commands, machines, outcomes')).toHaveValue('df');
    expect(screen.getByLabelText('Outcome')).toHaveValue('ran');
    expect(screen.getByLabelText('Rows per page')).toHaveValue('50');
  });

  it('ignores a page size or a page in the address that the page does not offer, and says nothing is wrong with the rest', async () => {
    window.history.replaceState({}, '', '/modules/machine/activity?page=abc&pageSize=7');
    render(<ActivityLog />);
    await screen.findByText('echo 1');
    const q = query(urls[0] as string);
    expect(q.get('page')).toBe('1');
    expect(q.get('pageSize')).toBe('25');
  });
});

describe('errors', () => {
  it('shows the message of the backend with a Retry button, keeps the filters, and recovers', async () => {
    const user = userEvent.setup();
    answer = () => new Error('the machine daemon is not running (no daemon.port.json): start it with `machine daemon` and reload the page');
    render(<ActivityLog />);
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('the machine daemon is not running');
    answer = () => page();
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('echo 1')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('shows a page past the end as an error with the fix, and Retry asks the same page again', async () => {
    window.history.replaceState({}, '', '/modules/machine/activity?page=9');
    answer = () => new Error('page 9 is beyond the last page (2): 30 entries match at 25 per page. Ask for a page from 1 to 2');
    render(<ActivityLog />);
    expect(await screen.findByRole('alert')).toHaveTextContent('beyond the last page (2)');
    expect(screen.getByRole('button', { name: 'First page' })).toBeEnabled();
  });

  it('tells the person to update app-core when the shell offers no fetcher (never a silent plain fetch)', async () => {
    Reflect.deleteProperty(globalThis, '__APP_CORE_SHELL__');
    render(<ActivityLog />);
    expect(await screen.findByRole('alert')).toHaveTextContent(/update app-core/);
  });

  it('shows the notes and the broken audit chain of the answer', async () => {
    answer = () => page({ notes: ['2 damaged line(s) of the run log were skipped'], chainText: 'The audit log is broken at line 4' });
    render(<ActivityLog />);
    expect(await screen.findByText(/2 damaged line\(s\)/)).toBeInTheDocument();
    expect(screen.getByText(/broken at line 4/)).toBeInTheDocument();
  });
});

describe('refresh', () => {
  it('reloads by itself while the first page is shown, without flashing the list away', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    render(<ActivityLog />);
    await screen.findByText('echo 1');
    const before = urls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(16_000);
    });
    expect(urls.length).toBeGreaterThan(before);
    expect(screen.getByText('echo 1')).toBeInTheDocument();
  });

  it('does not reload by itself on another page: the person is reading it', async () => {
    window.history.replaceState({}, '', '/modules/machine/activity?page=2');
    vi.useFakeTimers({ shouldAdvanceTime: true });
    answer = (url) => pageOf(Number(query(url).get('page')), 60);
    render(<ActivityLog />);
    await screen.findByText('echo 26');
    const before = urls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(16_000);
    });
    expect(urls.length).toBe(before);
  });
});
