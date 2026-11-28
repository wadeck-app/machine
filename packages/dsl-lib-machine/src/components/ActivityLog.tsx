import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Badge, type BadgeVariant, ButtonAction, CompactSelect, DataTable, Notice, RefreshButton, SearchBar, type TableColumn, Text } from '@wadeck-app/dsl-ui';
import { appFetcher } from '../lib/shellApi.js';
import type { SourceError } from '../lib/loadFailure.js';
import { MachineName } from './MachineName.js';
import { SourceFailureNotice } from './SourceFailureNotice.js';

export type ActivityRowData = {
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
};

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

const RESULT_VARIANT: Record<ActivityRowData['tone'], BadgeVariant> = { success: 'success', warning: 'warning', danger: 'danger', neutral: 'default' };
const EXIT_VARIANT: Record<ActivityRowData['exitTone'], BadgeVariant> = { ok: 'success', fail: 'danger', none: 'default' };

const COLUMNS: Array<TableColumn<ActivityRowData>> = [
  { key: 'whenText', label: 'When', muted: true, nowrap: true, render: (r) => <span title={r.ts}>{r.whenText}</span> },
  { key: 'directionText', label: 'Direction', nowrap: true, render: (r) => r.directionText },
  { key: 'fromText', label: 'From → To', nowrap: true, render: (r) => <><MachineName name={r.fromText} /> &rarr; <MachineName name={r.toText} /></> },
  { key: 'shell', label: 'Shell', muted: true, nowrap: true, render: (r) => (r.shell === '' ? '-' : r.shell) },
  // `wrap: 'words'`: the cell breaks between words (the DataTable default breaks at ANY character: "versi/on"); a token longer than the cell is still broken.
  { key: 'command', label: 'Command', mono: true, wrap: 'words', render: (r) => (r.command === '' ? '-' : r.command) },
  {
    key: 'resultText',
    label: 'Result',
    nowrap: true,
    render: (r) => (
      <>
        <Badge label={r.resultText} variant={RESULT_VARIANT[r.tone]} tone="subtle" {...(r.detailText === '' ? {} : { title: r.detailText })} />
        {r.detailText !== '' ? <div>{r.detailText}</div> : null}
      </>
    ),
  },
  { key: 'exitText', label: 'Exit', nowrap: true, render: (r) => <span data-exit=""><Badge label={r.exitText} variant={EXIT_VARIANT[r.exitTone]} tone="subtle" title={r.exitTitle} /></span> },
  { key: 'ranText', label: 'Ran for', nowrap: true, render: (r) => <span title={r.ranTitle}>{r.ranText}</span> },
  { key: 'waitedText', label: 'Waited', nowrap: true, render: (r) => r.waitedText },
];

/** A failed read as the page's `$sourceErrors` carries it: the message and, when the fetcher gives one, the HTTP status. */
function sourceErrorOf(e: unknown): SourceError {
  const status = typeof e === 'object' && e !== null ? (e as { status?: unknown }).status : undefined;
  const message = e instanceof Error ? e.message : String(e);
  return typeof status === 'number' ? { message, status } : { message };
}

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
  // The failure as `$sourceErrors` would carry it (message and HTTP status): the same notice as every page tells what it is (SourceFailureNotice).
  const [error, setError] = useState<SourceError | undefined>(undefined);
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
          setError(sourceErrorOf(e));
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
        <CompactSelect size="sm" ariaLabel="Direction" tooltip="Direction" value={filters.direction} options={DIRECTIONS} onChange={(v) => change('direction', v)} />
        <CompactSelect size="sm" ariaLabel="Machine" tooltip="Machine" value={filters.machine} options={withCurrent([{ value: '', label: 'All machines' }, ...(data?.machines ?? []).map((m) => ({ value: m, label: m }))], filters.machine)} onChange={(v) => change('machine', v)} />
        <CompactSelect size="sm" ariaLabel="Outcome" tooltip="Outcome" value={filters.outcome} options={withCurrent([{ value: '', label: 'All outcomes' }, ...(data?.outcomes ?? []).map((o) => ({ value: o, label: o }))], filters.outcome)} onChange={(v) => change('outcome', v)} />
        <CompactSelect size="sm" ariaLabel="Period" tooltip="Period" value={filters.since} options={PERIODS.map((p) => ({ value: p.since, label: p.label }))} onChange={(v) => change('since', v)} />
        <SearchBar size="sm" placeholder="Search commands, machines, outcomes" value={filters.text} onChange={(v) => change('text', v.slice(0, 100))} />
        <RefreshButton loading={loading} onClick={() => setReload((n) => n + 1)} />
      </div>

      {error !== undefined ? <SourceFailureNotice source="activity" error={error} onRefresh={() => setReload((n) => n + 1)} /> : null}
      {data?.chainText ? <Notice variant="warning" label={data.chainText} /> : null}
      {(data?.notes ?? []).map((note) => (
        <Notice key={note} variant="default" label={note} />
      ))}

      {known ? (
        <Notice variant="default" label={data.total === 0 ? '0 entries' : `${from}-${to} of ${data.totalExact ? '' : 'at least '}${grouped(data.total)}  (${grouped(data.counts.sent)} sent, ${grouped(data.counts.received)} received)`} />
      ) : loading && error === undefined ? (
        <Notice variant="default" label="Loading..." />
      ) : null}

      {known && rows.length === 0 ? <Notice variant="default" label={data.emptyMessage} /> : null}
      {rows.length > 0 ? <DataTable<ActivityRowData> rows={rows} columns={COLUMNS} rowKey="key" /> : null}

      <nav aria-label="Pages of the activity" className="flex flex-wrap items-center gap-2">
        <ButtonAction label="First" ariaLabel="First page" variant="secondary" size="xs" disabled={page <= 1} onClick={() => goTo(1)} />
        <ButtonAction label="Previous" ariaLabel="Previous page" variant="secondary" size="xs" disabled={page <= 1} onClick={() => goTo(page - 1)} />
        <Text tone="muted" size="sm" text={known ? `Page ${data.page} of ${grouped(pageCount)}${data.totalExact ? '' : '+'}` : `Page ${page}`} />
        <ButtonAction label="Next" ariaLabel="Next page" variant="secondary" size="xs" disabled={atLast} onClick={() => goTo(page + 1)} />
        <ButtonAction label="Last" ariaLabel="Last page" variant="secondary" size="xs" disabled={atLast || !data?.totalExact} onClick={() => goTo(pageCount)} />
        <label className="ml-auto flex items-center gap-2 text-xs text-muted">
          Rows per page
          <CompactSelect size="sm" ariaLabel="Rows per page" tooltip="Rows per page" value={String(size)} options={(data?.pageSizes ?? PAGE_SIZES).map((n) => ({ value: String(n), label: String(n) }))} onChange={(v) => { setSize(Number(v)); setPage(1); }} />
        </label>
      </nav>
    </section>
  );
}
