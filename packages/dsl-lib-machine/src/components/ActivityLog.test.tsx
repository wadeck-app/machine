import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ActivityLog, type ActivityPageData } from './ActivityLog.js';

// The Activity page: the commands this machine sent and received, with filters, a period and pages. The app-core shell is a stub on globalThis;
// the module backend is a fake that records the URL of every request (the filters are its query string).

function row(n: number, over: Partial<ActivityPageData['rows'][number]> = {}): ActivityPageData['rows'][number] {
  return { key: `k${n}`, ts: `2026-11-21T10:${String(n).padStart(2, '0')}:00.000Z`, whenText: `${n} min ago`, direction: 'sent', directionText: 'Sent', fromText: 'desktop', toText: 'laptop', shell: 'sh', command: `echo ${n}`, outcome: 'ran', outcomeText: 'ran (exit 0)', tone: 'success', detailText: '1.5 s', verified: true, ...over };
}

function page(over: Partial<ActivityPageData> = {}): ActivityPageData {
  const rows = over.rows ?? [row(1), row(2, { direction: 'received', directionText: 'Received', fromText: 'laptop', toText: 'desktop', command: 'whoami', outcome: 'refused', outcomeText: 'refused (not-listed)', tone: 'warning' })];
  return { machine: { uuid: 'u', name: 'desktop' }, rows, total: rows.length, offset: 0, limit: 25, hasMore: false, counts: { sent: 1, received: 1 }, machines: ['laptop', 'nas'], outcomes: ['ran', 'refused', 'denied'], emptyMessage: 'No activity yet', chainText: '', notes: [], ...over };
}

let urls: string[];
let answer: (url: string) => unknown;

beforeEach(() => {
  urls = [];
  answer = () => page();
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
});

const query = (url: string): URLSearchParams => new URL(`http://x/${url.replace(/^GET /, '')}`).searchParams;

describe('the timeline', () => {
  it('shows each entry: when, direction, from to, shell, command, outcome with its tone', async () => {
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
    expect(sent.getByText('ran (exit 0)').className).toMatch(/bg-success-bg/);
    expect(within(rows[2] as HTMLElement).getByText('refused (not-listed)').className).toMatch(/bg-warning-bg/);
    expect(sent.getByText('1 min ago')).toHaveAttribute('title', '2026-11-21T10:01:00.000Z');
  });

  it('asks the backend for the first page with no filter, and says how many entries there are', async () => {
    render(<ActivityLog />);
    await screen.findByText('echo 1');
    expect(urls[0]).toMatch(/^GET \/api\/modules\/machine\/activity\?/);
    const q = query(urls[0] as string);
    expect(q.get('offset')).toBe('0');
    expect(q.get('limit')).toBe('25');
    expect(q.get('direction') ?? '').toBe('');
    expect(screen.getByText(/2 entries: 1 sent, 1 received/)).toBeInTheDocument();
  });

  it('uses only the semantic tokens of the app: no palette class, no colour value', async () => {
    const { container } = render(<ActivityLog />);
    await screen.findByText('echo 1');
    const palette = /(?:^|\s)(?:[a-z-]+:)*(?:bg|text|border|ring|fill|stroke|divide)-(?:white|black|slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)(?:-\d{2,3})?(?:\/\d+)?(?=\s|$)/;
    for (const el of container.querySelectorAll('[class]')) {
      expect(el.getAttribute('class') ?? '', 'palette class').not.toMatch(palette);
      expect(el.getAttribute('class') ?? '', 'colour value').not.toMatch(/#[0-9a-fA-F]{3,8}|rgb\(/);
    }
    expect(container.querySelector('[style]')).toBeNull();
  });
});

describe('the filters', () => {
  it('sends the direction, the machine and the outcome chosen, and starts again at the first page', async () => {
    const user = userEvent.setup();
    render(<ActivityLog />);
    await screen.findByText('echo 1');
    await user.selectOptions(screen.getByLabelText('Direction'), 'sent');
    await waitFor(() => expect(query(urls.at(-1) as string).get('direction')).toBe('sent'));
    await user.selectOptions(screen.getByLabelText('Machine'), 'nas');
    await waitFor(() => expect(query(urls.at(-1) as string).get('machine')).toBe('nas'));
    await user.selectOptions(screen.getByLabelText('Outcome'), 'denied');
    await waitFor(() => expect(query(urls.at(-1) as string).get('outcome')).toBe('denied'));
    expect(query(urls.at(-1) as string).get('direction')).toBe('sent');
    expect(query(urls.at(-1) as string).get('offset')).toBe('0');
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
    await user.type(screen.getByLabelText('Search'), 'df');
    await waitFor(() => expect(query(urls.at(-1) as string).get('text')).toBe('df'));
    // One request for the whole word, not one per key.
    expect(urls.length - before).toBe(1);
  });

  it('says what is empty: nothing yet, or nothing for these filters', async () => {
    answer = () => page({ rows: [], total: 0, counts: { sent: 0, received: 0 }, emptyMessage: 'No entry matches these filters' });
    render(<ActivityLog />);
    expect(await screen.findByText('No entry matches these filters')).toBeInTheDocument();
  });
});

describe('the pages', () => {
  it('goes to the next and previous page with the offsets the backend gave', async () => {
    const user = userEvent.setup();
    answer = (url) => (query(url).get('offset') === '25' ? page({ offset: 25, total: 60, hasMore: true, nextOffset: 50, prevOffset: 0, rows: [row(30)] }) : page({ total: 60, hasMore: true, nextOffset: 25, rows: [row(1)] }));
    render(<ActivityLog />);
    await screen.findByText('echo 1');
    expect(screen.getByText(/1-1 of 60/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Previous page' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Next page' }));
    expect(await screen.findByText('echo 30')).toBeInTheDocument();
    expect(query(urls.at(-1) as string).get('offset')).toBe('25');
    expect(screen.getByRole('button', { name: 'Next page' })).toBeEnabled();
    await user.click(screen.getByRole('button', { name: 'Previous page' }));
    expect(await screen.findByText('echo 1')).toBeInTheDocument();
    expect(query(urls.at(-1) as string).get('offset')).toBe('0');
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
});
