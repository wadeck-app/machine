import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ButtonAction, CompactSelect, RefreshButton, SearchBar } from '@wadeck-app/dsl-ui';
import { appFetcher } from '../lib/shellApi.js';
import { COMMAND_TEXT, EXIT_FAIL, EXIT_NONE, EXIT_OK, NOTICE_NEUTRAL, NOTICE_WARNING, OUTCOME_DANGER, OUTCOME_NEUTRAL, OUTCOME_SUCCESS, OUTCOME_WARNING, TABLE_BODY_ROW, TABLE_HEAD_ROW, TEXT_ERROR, TEXT_MUTED_SM, MONO_STYLE } from '../lib/styleTokens.js';
import { MachineName } from './MachineName.js';

export interface ActivityRowData {
  key: string;
  /** ISO 8601, UTC: shown as the tooltip of the age. */
  ts: string;
  whenText: string;
  direction: 'sent' | 'received';
  directionText: string;
  fromText: string;
  toText: string;
  shell: string;
  command: string;
  outcome: string;
  /** The Result column: ran, refused (reason), denied, deadline, timeout, connection-lost, error (cause), unfinished. */
  resultText: string;
  tone: 'success' | 'warning' | 'danger' | 'neutral';
  /** The Exit column: the code, `timed out`, `killed`, or `-` when no command ran. */
  exitText: string;
  exitTone: 'ok' | 'fail' | 'none';
  exitTitle: string;
  /** The Ran for column: the run time of the command on the target; a leading ~ marks an estimate. */
  ranText: string;
  ranDerived: boolean;
  ranTitle: string;
  /** The Waited column: how long the request was held waiting for approval. */
  waitedText: string;
  detailText: string;
  verified: boolean;
}

/** The answer of `GET /api/modules/machine/activity`. */
export interface ActivityPageData {
  machine: { uuid: string; name: string };
  rows: ActivityRowData[];
  total: number;
  /** False: the total is a lower bound (counting stopped at its budget). */
  totalExact: boolean;
  /** 1-based. */
  page: number;
  pageSize: number;
  pageCount: number;
  pageSizes: number[];
  counts: { sent: number; received: number };
  machines: string[];
  outcomes: string[];
  emptyMessage: string;
  chainText: string;
  notes: string[];
}

export interface ActivityLogProps {
  /** Rows per page when the address does not say (25, 50 or 100; default 25). */
  pageSize?: number;
}

const PERIODS: Array<{ label: string; since: string }> = [
  { label: 'All time', since: '' },
  { label: 'Last hour', since: '1h' },
  { label: 'Last 24 hours', since: '24h' },
  { label: 'Last 7 days', since: '7d' },
  { label: 'Last 30 days', since: '30d' },
];

const DIRECTIONS: Array<{ label: string; value: string }> = [
  { label: 'Sent and received', value: '' },
  { label: 'Sent', value: 'sent' },
  { label: 'Received', value: 'received' },
];

const TONES: Record<ActivityRowData['tone'], string> = { success: OUTCOME_SUCCESS, warning: OUTCOME_WARNING, danger: OUTCOME_DANGER, neutral: OUTCOME_NEUTRAL };
const EXIT_TONES: Record<ActivityRowData['exitTone'], string> = { ok: EXIT_OK, fail: EXIT_FAIL, none: EXIT_NONE };

/** The page is re-read this often while its first page is shown: a command sent from a terminal shows up without a click. */
const REFRESH_MS = 15_000;
/** The sizes the backend accepts (machine-core ACTIVITY_PAGE_SIZES). */
const PAGE_SIZES = [25, 50, 100];
const DEFAULT_PAGE_SIZE = 25;

interface Filters {
  direction: string;
  machine: string;
  outcome: string;
  since: string;
  text: string;
}

/** The options, plus the filter of the address when it is not one of them (a hand-edited link or a machine that left the log): the select shows it instead of a wrong choice. */
function withCurrent(options: Array<{ value: string; label: string }>, current: string): Array<{ value: string; label: string }> {
  return current === '' || options.some((o) => o.value === current) ? options : [...options, { value: current, label: current }];
}

const NO_FILTERS: Filters = { direction: '', machine: '', outcome: '', since: '', text: '' };
const FILTER_KEYS = Object.keys(NO_FILTERS) as Array<keyof Filters>;

/** What the address says; anything that is not a choice of the page (a hand-edited link) is dropped for its default. */
function stateFromAddress(defaultSize: number): { filters: Filters; page: number; pageSize: number } {
  const params = new URLSearchParams(typeof window === 'undefined' ? '' : window.location.search);
  const filters = { ...NO_FILTERS };
  for (const key of FILTER_KEYS) {
    filters[key] = (params.get(key) ?? '').slice(0, 100);
  }
  const size = Number(params.get('pageSize'));
  const page = Number(params.get('page'));
  return { filters, page: Number.isSafeInteger(page) && page >= 1 ? page : 1, pageSize: PAGE_SIZES.includes(size) ? size : defaultSize };
}

/** The address of the page for a state: only what differs from the defaults, so a plain page keeps a plain address. */
function addressOf(filters: Filters, page: number, pageSize: number, defaultSize: number): string {
  const params = new URLSearchParams();
  for (const key of FILTER_KEYS) {
    if (filters[key] !== '') {
      params.set(key, filters[key]);
    }
  }
  if (pageSize !== defaultSize) {
    params.set('pageSize', String(pageSize));
  }
  if (page > 1) {
    params.set('page', String(page));
  }
  const search = params.toString();
  return `${window.location.pathname}${search === '' ? '' : `?${search}`}${window.location.hash}`;
}

function urlOf(filters: Filters, page: number, pageSize: number): string {
  const params = new URLSearchParams();
  for (const key of FILTER_KEYS) {
    if (filters[key] !== '') {
      params.set(key, filters[key]);
    }
  }
  params.set('page', String(page));
  params.set('pageSize', String(pageSize));
  return `GET /api/modules/machine/activity?${params.toString()}`;
}

/** 1234567 -> "1,234,567". */
const grouped = (n: number): string => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');

/** The header cells stay in view while the table scrolls (the column of the numbers is on the right, its width fixed so the pages do not jump). */
const HEAD = 'sticky top-0 z-10 border-b border-border bg-surface py-1 font-medium';
const COLUMNS: Array<{ label: string; className: string }> = [
  { label: 'When', className: `${HEAD} whitespace-nowrap pr-3` },
  { label: 'Direction', className: `${HEAD} whitespace-nowrap pr-3` },
  { label: 'From \u2192 To', className: `${HEAD} whitespace-nowrap pr-3` },
  { label: 'Shell', className: `${HEAD} whitespace-nowrap pr-3` },
  { label: 'Command', className: `${HEAD} pr-3` },
  { label: 'Result', className: `${HEAD} whitespace-nowrap pr-3` },
  { label: 'Exit', className: `${HEAD} w-24 whitespace-nowrap pr-3 text-right` },
  { label: 'Ran for', className: `${HEAD} w-24 whitespace-nowrap pr-3 text-right` },
  { label: 'Waited', className: `${HEAD} w-28 whitespace-nowrap text-right` },
];

/**
 * The Activity page: every command this machine sent with `machine run` and every command it received, newest first. Filters (direction,
 * machine, outcome, period, a word of the command) and pages cut on the server (a log holds thousands of commands), a column for the result, the
 * exit code (green for 0, red otherwise), the run time of the command and the time it waited for approval. The filters, the page and the page size
 * are in the address, so a page can be shared and reloaded. Read-only: it asks one route of the module and shows what that route says, errors
 * included (they name the fix).
 *
 * @registryCategory composite
 * @registryTags activity log run audit sent received history
 */
export function ActivityLog({ pageSize = DEFAULT_PAGE_SIZE }: ActivityLogProps) {
  const defaultSize = PAGE_SIZES.includes(pageSize) ? pageSize : DEFAULT_PAGE_SIZE;
  const [initial] = useState(() => stateFromAddress(defaultSize));
  const [filters, setFilters] = useState<Filters>(initial.filters);
  const [page, setPage] = useState(initial.page);
  const [size, setSize] = useState(initial.pageSize);
  const [data, setData] = useState<ActivityPageData | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const [reload, setReload] = useState(0);
  const latest = useRef(0);

  // The address follows the state (replace, not push: the Back button leaves the page, it does not replay every click).
  useEffect(() => {
    const next = addressOf(filters, page, size, defaultSize);
    if (next !== `${window.location.pathname}${window.location.search}${window.location.hash}`) {
      window.history.replaceState(window.history.state, '', next);
    }
  }, [filters, page, size, defaultSize]);

  useEffect(() => {
    const mine = ++latest.current;
    setLoading(true);
    const url = urlOf(filters, page, size);
    // appFetcher throws at once (not a rejected promise) when the shell offers none: the same path as a failed request.
    Promise.resolve()
      .then(() => appFetcher(url))
      .then((answer) => {
        // A slower, older answer never replaces a newer one.
        if (mine === latest.current) {
          setData(answer as ActivityPageData);
          setError(undefined);
        }
      })
      .catch((e: unknown) => {
        if (mine === latest.current) {
          setError(e instanceof Error ? e.message : String(e));
        }
      })
      .finally(() => {
        if (mine === latest.current) {
          setLoading(false);
        }
      });
  }, [filters, page, size, reload]);

  useEffect(() => {
    if (page !== 1) {
      return undefined;
    }
    const timer = setInterval(() => setReload((n) => n + 1), REFRESH_MS);
    return () => clearInterval(timer);
  }, [page]);

  const change = useCallback((key: keyof Filters, value: string) => {
    setFilters((f) => ({ ...f, [key]: value }));
    setPage(1);
  }, []);

  const rows = data?.rows ?? [];
  const pageCount = data?.pageCount ?? page;
  const known = data !== undefined && error === undefined;
  const from = known && data.total > 0 ? (data.page - 1) * data.pageSize + 1 : 0;
  const to = known ? (data.page - 1) * data.pageSize + rows.length : 0;
  const atLast = !known || data.page >= data.pageCount;
  const goTo = (n: number): void => setPage(Math.max(1, n));

  return (
    <section className="flex flex-col gap-3" aria-label="Activity">
      <div className="flex flex-wrap items-end gap-3">
        {/* The toolbar selects carry no visible label (CompactSelect names them for a screen reader): each default option says what it filters. */}
        <CompactSelect size="sm" ariaLabel="Direction" value={filters.direction} options={DIRECTIONS} onChange={(v) => change('direction', v)} />
        <CompactSelect size="sm" ariaLabel="Machine" value={filters.machine} options={withCurrent([{ value: '', label: 'All machines' }, ...(data?.machines ?? []).map((m) => ({ value: m, label: m }))], filters.machine)} onChange={(v) => change('machine', v)} />
        <CompactSelect size="sm" ariaLabel="Outcome" value={filters.outcome} options={withCurrent([{ value: '', label: 'All outcomes' }, ...(data?.outcomes ?? []).map((o) => ({ value: o, label: o }))], filters.outcome)} onChange={(v) => change('outcome', v)} />
        <CompactSelect size="sm" ariaLabel="Period" value={filters.since} options={PERIODS.map((p) => ({ value: p.since, label: p.label }))} onChange={(v) => change('since', v)} />
        <SearchBar size="sm" placeholder="Search commands, machines, outcomes" value={filters.text} onChange={(v) => change('text', v.slice(0, 100))} />
        <RefreshButton loading={loading} onClick={() => setReload((n) => n + 1)} />
      </div>

      {error !== undefined ? (
        <div role="alert" className="flex flex-col items-start gap-2 rounded border border-danger bg-danger-bg p-3 text-sm text-danger-text">
          <span className={TEXT_ERROR}>{error}</span>
          <ButtonAction label="Retry" variant="secondary" size="xs" onClick={() => setReload((n) => n + 1)} />
        </div>
      ) : null}
      {data?.chainText ? <p className={NOTICE_WARNING}>{data.chainText}</p> : null}
      {(data?.notes ?? []).map((note) => (
        <p key={note} className={NOTICE_NEUTRAL}>{note}</p>
      ))}

      {known ? (
        <p className={TEXT_MUTED_SM} aria-live="polite">
          {data.total === 0 ? '0 entries' : `${from}-${to} of ${data.totalExact ? '' : 'at least '}${grouped(data.total)}`}
          {data.total > 0 ? <span>{`  (${grouped(data.counts.sent)} sent, ${grouped(data.counts.received)} received)`}</span> : null}
        </p>
      ) : loading && error === undefined ? (
        <p className={TEXT_MUTED_SM} aria-live="polite">Loading...</p>
      ) : null}

      {known && rows.length === 0 ? <p className={TEXT_MUTED_SM}>{data.emptyMessage}</p> : null}
      {rows.length > 0 ? (
        <div className="max-h-[70vh] overflow-auto">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className={TABLE_HEAD_ROW}>
                {COLUMNS.map((c) => (
                  <th key={c.label} className={c.className}>{c.label}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.key} className={TABLE_BODY_ROW}>
                  <td className="whitespace-nowrap py-1 pr-3 text-muted"><span title={r.ts}>{r.whenText}</span></td>
                  <td className="whitespace-nowrap py-1 pr-3">{r.directionText}</td>
                  <td className="whitespace-nowrap py-1 pr-3">
                    <MachineName name={r.fromText} /> <span className="text-muted">&rarr;</span> <MachineName name={r.toText} />
                  </td>
                  <td className="whitespace-nowrap py-1 pr-3 text-muted">{r.shell === '' ? '-' : r.shell}</td>
                  <td className="py-1 pr-3"><span className={COMMAND_TEXT} style={MONO_STYLE}>{r.command === '' ? '-' : r.command}</span></td>
                  <td className="py-1 pr-3">
                    <span className={TONES[r.tone]} title={r.detailText === '' ? undefined : r.detailText}>{r.resultText}</span>
                    {r.detailText !== '' ? <div className="text-xs text-muted">{r.detailText}</div> : null}
                  </td>
                  <td className="whitespace-nowrap py-1 pr-3 text-right"><span data-exit="" className={EXIT_TONES[r.exitTone]} title={r.exitTitle}>{r.exitText}</span></td>
                  <td className={`whitespace-nowrap py-1 pr-3 text-right tabular-nums ${r.ranText === '-' ? 'text-muted' : ''}`}><span title={r.ranTitle}>{r.ranText}</span></td>
                  <td className={`whitespace-nowrap py-1 text-right tabular-nums ${r.waitedText === '-' ? 'text-muted' : ''}`}>{r.waitedText}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      <nav aria-label="Pages of the activity" className="flex flex-wrap items-center gap-2">
        <ButtonAction label="First" ariaLabel="First page" variant="secondary" size="xs" disabled={page <= 1} onClick={() => goTo(1)} />
        <ButtonAction label="Previous" ariaLabel="Previous page" variant="secondary" size="xs" disabled={page <= 1} onClick={() => goTo(page - 1)} />
        <span className={TEXT_MUTED_SM}>{known ? `Page ${data.page} of ${grouped(pageCount)}${data.totalExact ? '' : '+'}` : `Page ${page}`}</span>
        <ButtonAction label="Next" ariaLabel="Next page" variant="secondary" size="xs" disabled={atLast} onClick={() => goTo(page + 1)} />
        <ButtonAction label="Last" ariaLabel="Last page" variant="secondary" size="xs" disabled={atLast || !data?.totalExact} onClick={() => goTo(pageCount)} />
        <label className="ml-auto flex items-center gap-2 text-xs text-muted">
          Rows per page
          <CompactSelect size="sm" ariaLabel="Rows per page" value={String(size)} options={(data?.pageSizes ?? PAGE_SIZES).map((n) => ({ value: String(n), label: String(n) }))} onChange={(v) => { setSize(Number(v)); setPage(1); }} />
        </label>
      </nav>
    </section>
  );
}
