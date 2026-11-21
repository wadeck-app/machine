import React, { useCallback, useEffect, useId, useRef, useState } from 'react';
import { appFetcher } from '../lib/shellApi.js';
import { COMMAND_TEXT, INPUT, NOTICE_NEUTRAL, NOTICE_WARNING, OUTCOME_DANGER, OUTCOME_NEUTRAL, OUTCOME_SUCCESS, OUTCOME_WARNING, PAGE_BUTTON, TABLE_BODY_ROW, TABLE_HEAD_ROW, TEXT_ERROR, TEXT_MUTED_SM } from '../lib/styleTokens.js';

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
  outcomeText: string;
  tone: 'success' | 'warning' | 'danger' | 'neutral';
  detailText: string;
  verified: boolean;
}

/** The answer of `GET /api/modules/machine/activity`. */
export interface ActivityPageData {
  machine: { uuid: string; name: string };
  rows: ActivityRowData[];
  total: number;
  offset: number;
  limit: number;
  hasMore: boolean;
  nextOffset?: number;
  prevOffset?: number;
  counts: { sent: number; received: number };
  machines: string[];
  outcomes: string[];
  emptyMessage: string;
  chainText: string;
  notes: string[];
}

export interface ActivityLogProps {
  /** Entries per page, 1 to 100 (default 25). */
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

/** The page is re-read this often while its first page is shown: a command sent from a terminal shows up without a click. */
const REFRESH_MS = 15_000;
const SEARCH_DELAY_MS = 300;
const DEFAULT_PAGE_SIZE = 25;

interface Filters {
  direction: string;
  machine: string;
  outcome: string;
  since: string;
  text: string;
}

const NO_FILTERS: Filters = { direction: '', machine: '', outcome: '', since: '', text: '' };

function urlOf(filters: Filters, offset: number, limit: number): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) {
    if (value !== '') {
      params.set(key, value);
    }
  }
  params.set('limit', String(limit));
  params.set('offset', String(offset));
  return `GET /api/modules/machine/activity?${params.toString()}`;
}

/**
 * The Activity page: every command this machine sent with `machine run` and every command it received, newest first. Filters (direction,
 * machine, outcome, period, a word of the command), pages, and a refresh by itself while the first page is shown. Read-only: it asks one route
 * of the module and shows what that route says, errors included (they name the fix).
 *
 * @registryCategory composite
 * @registryTags activity log run audit sent received history
 */
export function ActivityLog({ pageSize = DEFAULT_PAGE_SIZE }: ActivityLogProps) {
  const limit = Math.min(100, Math.max(1, Math.floor(pageSize)));
  const ids = { direction: useId(), machine: useId(), outcome: useId(), period: useId(), search: useId() };
  const [filters, setFilters] = useState<Filters>(NO_FILTERS);
  const [searchText, setSearchText] = useState('');
  const [offset, setOffset] = useState(0);
  const [data, setData] = useState<ActivityPageData | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const [reload, setReload] = useState(0);
  const latest = useRef(0);

  // The word typed is searched once the person stops typing: one request for a word, not one per key.
  useEffect(() => {
    if (searchText === filters.text) {
      return undefined;
    }
    const timer = setTimeout(() => {
      setFilters((f) => ({ ...f, text: searchText }));
      setOffset(0);
    }, SEARCH_DELAY_MS);
    return () => clearTimeout(timer);
  }, [searchText, filters.text]);

  useEffect(() => {
    const mine = ++latest.current;
    setLoading(true);
    let url: string;
    try {
      url = urlOf(filters, offset, limit);
    } catch (e) {
      setError((e as Error).message);
      setLoading(false);
      return;
    }
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
  }, [filters, offset, limit, reload]);

  useEffect(() => {
    if (offset !== 0) {
      return undefined;
    }
    const timer = setInterval(() => setReload((n) => n + 1), REFRESH_MS);
    return () => clearInterval(timer);
  }, [offset]);

  const change = useCallback((key: keyof Filters, value: string) => {
    setFilters((f) => ({ ...f, [key]: value }));
    setOffset(0);
  }, []);

  const rows = data?.rows ?? [];
  const from = data === undefined || data.total === 0 ? 0 : data.offset + 1;
  const to = data === undefined ? 0 : data.offset + rows.length;

  return (
    <section className="flex flex-col gap-3" aria-label="Activity">
      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1 text-xs text-muted" htmlFor={ids.direction}>
          Direction
          <select id={ids.direction} className={INPUT} value={filters.direction} onChange={(e) => change('direction', e.target.value)}>
            {DIRECTIONS.map((d) => (
              <option key={d.value} value={d.value}>{d.label}</option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs text-muted" htmlFor={ids.machine}>
          Machine
          <select id={ids.machine} className={INPUT} value={filters.machine} onChange={(e) => change('machine', e.target.value)}>
            <option value="">All machines</option>
            {(data?.machines ?? []).map((m) => (
              <option key={m} value={m}>{m}</option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs text-muted" htmlFor={ids.outcome}>
          Outcome
          <select id={ids.outcome} className={INPUT} value={filters.outcome} onChange={(e) => change('outcome', e.target.value)}>
            <option value="">All outcomes</option>
            {(data?.outcomes ?? []).map((o) => (
              <option key={o} value={o}>{o}</option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs text-muted" htmlFor={ids.period}>
          Period
          <select id={ids.period} className={INPUT} value={filters.since} onChange={(e) => change('since', e.target.value)}>
            {PERIODS.map((p) => (
              <option key={p.since} value={p.since}>{p.label}</option>
            ))}
          </select>
        </label>
        <label className="flex min-w-48 flex-1 flex-col gap-1 text-xs text-muted" htmlFor={ids.search}>
          Search
          <input id={ids.search} type="search" className={INPUT} placeholder="a word of the command, a machine, an outcome" maxLength={100} value={searchText} onChange={(e) => setSearchText(e.target.value)} />
        </label>
        <button type="button" className={PAGE_BUTTON} onClick={() => setReload((n) => n + 1)}>
          Refresh
        </button>
      </div>

      {error !== undefined ? (
        <div role="alert" className="flex flex-col items-start gap-2 rounded border border-danger bg-danger-bg p-3 text-sm text-danger-text">
          <span className={TEXT_ERROR}>{error}</span>
          <button type="button" className={PAGE_BUTTON} onClick={() => setReload((n) => n + 1)}>
            Retry
          </button>
        </div>
      ) : null}
      {data?.chainText ? <p className={NOTICE_WARNING}>{data.chainText}</p> : null}
      {(data?.notes ?? []).map((note) => (
        <p key={note} className={NOTICE_NEUTRAL}>{note}</p>
      ))}

      {data !== undefined ? (
        <p className={TEXT_MUTED_SM} aria-live="polite">
          {data.total} {data.total === 1 ? 'entry' : 'entries'}: {data.counts.sent} sent, {data.counts.received} received
          {data.total > 0 ? `, showing ${from}-${to} of ${data.total}` : ''}
        </p>
      ) : loading ? (
        <p className={TEXT_MUTED_SM}>Loading...</p>
      ) : null}

      {data !== undefined && rows.length === 0 ? <p className={TEXT_MUTED_SM}>{data.emptyMessage}</p> : null}
      {rows.length > 0 ? (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className={TABLE_HEAD_ROW}>
                <th className="py-1 pr-3 font-medium">When</th>
                <th className="py-1 pr-3 font-medium">Direction</th>
                <th className="py-1 pr-3 font-medium">From &rarr; To</th>
                <th className="py-1 pr-3 font-medium">Shell</th>
                <th className="py-1 pr-3 font-medium">Command</th>
                <th className="py-1 font-medium">Outcome</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.key} className={TABLE_BODY_ROW}>
                  <td className="whitespace-nowrap py-1 pr-3 text-muted"><span title={r.ts}>{r.whenText}</span></td>
                  <td className="whitespace-nowrap py-1 pr-3">{r.directionText}</td>
                  <td className="whitespace-nowrap py-1 pr-3">
                    <span>{r.fromText}</span> <span className="text-muted">&rarr;</span> <span>{r.toText}</span>
                  </td>
                  <td className="whitespace-nowrap py-1 pr-3 text-muted">{r.shell === '' ? '-' : r.shell}</td>
                  <td className="py-1 pr-3"><span className={COMMAND_TEXT}>{r.command === '' ? '-' : r.command}</span></td>
                  <td className="py-1">
                    <span className={TONES[r.tone]} title={r.detailText === '' ? undefined : r.detailText}>{r.outcomeText}</span>
                    {r.detailText !== '' ? <div className="text-xs text-muted">{r.detailText}</div> : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      {data !== undefined && (offset > 0 || data.hasMore) ? (
        <div className="flex items-center gap-2">
          <button type="button" className={PAGE_BUTTON} disabled={data.prevOffset === undefined || loading} onClick={() => setOffset(data.prevOffset ?? 0)}>
            Previous page
          </button>
          <button type="button" className={PAGE_BUTTON} disabled={data.nextOffset === undefined || loading} onClick={() => setOffset(data.nextOffset ?? 0)}>
            Next page
          </button>
        </div>
      ) : null}
    </section>
  );
}
