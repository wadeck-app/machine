import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { appFetcher } from '../lib/shellApi.js';
import { INPUT, MONO_STYLE, NOTICE_NEUTRAL, NOTICE_WARNING, PAGE_BUTTON, TEXT_ERROR, TEXT_MUTED_SM } from '../lib/styleTokens.js';
import { AllowedMachineBlock, matches } from './AllowedMachineBlock.js';

export interface AllowedEntryData {
  key: string;
  /** Place in its list, from 1. */
  index: number;
  shell: string;
  /** The command or template as signed: shown as text, never as HTML. */
  text: string;
  typed: boolean;
  lifetimeText: string;
  limited: boolean;
  /** Why a value is not shown (the calls left of a list signed here); empty when there is nothing to say. */
  limitNote: string;
}

export interface AllowedListData {
  key: string;
  title: string;
  /** Empty for the default list. */
  peerName: string;
  entries: AllowedEntryData[];
}

export interface AllowedMachineData {
  uuid: string;
  name: string;
  isSelf: boolean;
  source: 'installed' | 'signed-here';
  sourceText: string;
  mode: 'admin' | 'local';
  version: number | null;
  signedText: string;
  signedIso: string;
  lists: AllowedListData[];
  deliveryNote: string;
  problem: string;
  emptyText: string;
  fillCommand: string;
}

/** The answer of `GET /api/modules/machine/allowed`. */
export interface AllowedPageData {
  machine: { uuid: string; name: string };
  entryCount: number;
  machineCount: number;
  summary: string;
  machines: AllowedMachineData[];
  warnings: string[];
  changeNote: string;
}

export interface AllowedListProps {
  /** Seconds between two re-reads of the page (5 to 600; default 15). */
  refreshSeconds?: number;
}

const LOAD_ERROR = 'flex flex-col items-start gap-2 rounded border border-danger bg-danger-bg p-3 text-sm text-danger-text';
const URL = 'GET /api/modules/machine/allowed';

/**
 * The Allowed page: the commands approved for each machine, the same lists `machine allowed <machine>` prints. Read-only: it asks one route of the
 * module and shows what that route says, errors included (they name the fix). A command is shown as text, never as HTML.
 *
 * @registryCategory composite
 * @registryTags allowed whitelist allow list policy commands approved machines
 */
export function AllowedList({ refreshSeconds = 15 }: AllowedListProps) {
  // A value outside 5 to 600 is a typo in the view: the default is used AND the page says so (never silently).
  const badRefresh = !(Number.isFinite(refreshSeconds) && refreshSeconds >= 5 && refreshSeconds <= 600);
  const refreshMs = (badRefresh ? 15 : refreshSeconds) * 1000;
  const ids = { machine: useId(), search: useId() };
  const [data, setData] = useState<AllowedPageData | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const [reload, setReload] = useState(0);
  const [machine, setMachine] = useState('');
  const [search, setSearch] = useState('');
  const latest = useRef(0);

  useEffect(() => {
    const mine = ++latest.current;
    setLoading(true);
    // appFetcher throws at once (not a rejected promise) when the shell offers none: the same path as a failed request.
    Promise.resolve()
      .then(() => appFetcher(URL))
      .then((answer) => {
        // A slower, older answer never replaces a newer one.
        if (mine === latest.current) {
          setData(answer as AllowedPageData);
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
  }, [reload]);

  useEffect(() => {
    const timer = setInterval(() => setReload((n) => n + 1), refreshMs);
    return () => clearInterval(timer);
  }, [refreshMs]);

  const needle = search.trim().toLowerCase();
  const known = data !== undefined && error === undefined;
  const shown = useMemo(() => (known ? data.machines.filter((m) => machine === '' || m.name === machine) : []), [known, data, machine]);
  const shownEntries = shown.reduce((n, m) => n + m.lists.reduce((k, l) => k + l.entries.filter((e) => matches(needle, e, l)).length, 0), 0);
  const filtered = needle !== '' || machine !== '';

  return (
    <section className="flex flex-col gap-3" aria-label="Allowed commands">
      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1 text-xs text-muted" htmlFor={ids.machine}>
          Machine
          <select id={ids.machine} className={INPUT} value={machine} onChange={(e) => setMachine(e.target.value)}>
            <option value="">All machines</option>
            {(data?.machines ?? []).map((m) => (
              <option key={m.uuid} value={m.name} style={MONO_STYLE}>{m.name}</option>
            ))}
          </select>
        </label>
        <label className="flex min-w-48 flex-1 flex-col gap-1 text-xs text-muted" htmlFor={ids.search}>
          Search
          <input id={ids.search} type="search" className={INPUT} placeholder="a word of a command, a shell, a peer" maxLength={100} value={search} onChange={(e) => setSearch(e.target.value)} />
        </label>
        <button type="button" className={PAGE_BUTTON} onClick={() => setReload((n) => n + 1)}>
          Refresh
        </button>
      </div>

      {badRefresh ? <p className={NOTICE_WARNING}>{`refreshSeconds must be from 5 to 600, got ${String(refreshSeconds)}: the page is re-read every 15 s. Fix it in the view (allowed.yaml).`}</p> : null}
      {error !== undefined ? (
        <div role="alert" className={LOAD_ERROR}>
          <span className={TEXT_ERROR}>{error}</span>
          <button type="button" className={PAGE_BUTTON} onClick={() => setReload((n) => n + 1)}>
            Retry
          </button>
        </div>
      ) : null}

      {known ? (
        <>
          <p className={TEXT_MUTED_SM} aria-live="polite">
            {data.summary}
            {filtered ? <span className="ml-3">{`${shownEntries} of ${data.entryCount} entries shown`}</span> : null}
          </p>
          <p className={NOTICE_NEUTRAL}>{data.changeNote}</p>
          {data.warnings.map((w) => (
            <p key={w} className={NOTICE_WARNING}>{w}</p>
          ))}
          {shown.map((m) => (
            <AllowedMachineBlock key={m.uuid} machine={m} needle={needle} />
          ))}
        </>
      ) : loading && error === undefined ? (
        <p className={TEXT_MUTED_SM} aria-live="polite">Loading...</p>
      ) : null}
    </section>
  );
}

