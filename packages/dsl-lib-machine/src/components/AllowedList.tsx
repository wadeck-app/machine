import { ButtonAction, ChipButton, SearchBar, Tabs, type SortDir } from '@wadeck-app/dsl-ui';
import { RefreshCw } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { shellAllowApi, type AllowApi } from '../lib/allowFlow.js';
import type { EditOutcome } from '../lib/allowedEdit.js';
import { appFetcher } from '../lib/shellApi.js';
import { NOTICE_SUCCESS, NOTICE_WARNING, TEXT_ERROR, TEXT_MUTED_SM } from '../lib/styleTokens.js';
import { AllowedMachineBlock, matches } from './AllowedMachineBlock.js';
import { UnlockedKeyBar } from './UnlockedKeyBar.js';
import { useSaferMode } from './useSaferMode.js';

// A type alias (not an interface): DataTable wants rows assignable to Record<string, unknown>.
export type AllowedEntryData = {
  /** Unique inside its machine. */
  key: string;
  /** `default` or `only for <peer>`. */
  listLabel: string;
  listTitle: string;
  /** Empty for the default list. */
  peerName: string;
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
  /** The uuid of the peer of an own list (what a signed edit names); empty for the default list. */
  peerUuid: string;
  /** The limits as signed (null: none). */
  maxCalls: number | null;
  expiresAt: number | null;
  /** Epoch seconds, null when not known (see lastUsedText). */
  lastUsedAt: number | null;
  /** Seconds, or -1 when unknown (sorts as the oldest). */
  lastUsedSort: number;
  lastUsedText: string;
  lastUsedNote: string;
  /** The terminal command that withdraws the entry; empty when none is known. */
  removeCommand: string;
};

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
  entries: AllowedEntryData[];
  deliveryNote: string;
  problem: string;
  emptyText: string;
  fillCommand: string;
  /** This machine can sign a change of this list: the page offers delete and change of lifetime (decision 112). */
  canEdit: boolean;
  /** Why not, with the terminal command, when the list has entries and cannot be changed here. */
  editNote: string;
}

/** The answer of `GET /api/modules/machine/allowed`. */
export interface AllowedPageData {
  machine: { uuid: string; name: string };
  entryCount: number;
  machineCount: number;
  machines: AllowedMachineData[];
  warnings: string[];
}

export interface AllowedListProps {
  /** Seconds between two re-reads of the page (5 to 600; default 15). */
  refreshSeconds?: number;
}

const LOAD_ERROR = 'flex flex-col items-start gap-2 rounded border border-danger bg-danger-bg p-3 text-sm text-danger-text';
const URL = 'GET /api/modules/machine/allowed';
// ChipButton marks itself as a toggle (aria-pressed); Refresh is an action, so the attribute is dropped (a spread, because the prop type only takes a boolean).
const NOT_A_TOGGLE = { 'aria-pressed': undefined } as unknown as object;

/** The tab label: name and entries (the entries that match the search while one is typed), and a word when the policy could not be read. */
const labelOf = (m: AllowedMachineData, count: number): string => `${m.name} (${count})${m.problem === '' ? '' : ' - unreadable policy'}`;

/**
 * The Allowed page: the commands approved for each machine, the same lists `machine allowed <machine>` prints. One tab per machine, one table per tab.
 * Where this machine can sign (the admin machine, policy mode admin), a row can be deleted or given another lifetime, one by one or by a selection of the
 * shared table (decision 112): the confirmation names the exact commands, the signature is made IN THE BROWSER with the unlocked admin key like Allow. Elsewhere
 * it is read-only and says why. It asks one route of the module and shows what that route says, errors included (they name the fix). A command is shown as text, never as HTML.
 *
 * @registryCategory composite
 * @registryTags allowed whitelist allow list policy commands approved machines
 */
export function AllowedList({ refreshSeconds = 15 }: AllowedListProps) {
  // A value outside 5 to 600 is a typo in the view: the default is used AND the page says so (never silently).
  const badRefresh = !(Number.isFinite(refreshSeconds) && refreshSeconds >= 5 && refreshSeconds <= 600);
  const refreshMs = (badRefresh ? 15 : refreshSeconds) * 1000;
  const [data, setData] = useState<AllowedPageData | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const [reload, setReload] = useState(0);
  const [search, setSearch] = useState('');
  const [chosen, setChosen] = useState<string | undefined>(undefined);
  // Most recent use first; kept here so that the choice survives a change of tab and a re-read.
  const [sortCol, setSortCol] = useState('lastUsedSort');
  const [sortDir, setSortDir] = useState<SortDir>('desc');
  const latest = useRef(0);
  // What the last change did (signed, delivered or not), kept until the next one.
  const [outcome, setOutcome] = useState<EditOutcome | null>(null);
  const api = useRef<AllowApi | null>(null);
  api.current ??= shellAllowApi();
  const safer = useSaferMode();

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
  const machines = useMemo(() => (known ? data.machines : []), [known, data]);
  const shown = useMemo(() => machines.map((m) => ({ machine: m, rows: m.entries.filter((e) => matches(needle, e)) })), [machines, needle]);
  const shownEntries = shown.reduce((n, s) => n + s.rows.length, 0);
  // The tab of the user, else the first machine that holds entries (the others are one click away), else the first.
  const active = shown.find((s) => s.machine.uuid === chosen)?.machine.uuid ?? (shown.find((s) => s.machine.entries.length > 0) ?? shown[0])?.machine.uuid;

  return (
    <section className="flex flex-col gap-3" aria-label="Allowed commands">
      <UnlockedKeyBar variant="chip" />
      <div className="flex flex-wrap items-center gap-3">
        <SearchBar value={search} onChange={setSearch} placeholder="Search" debounceMs={0} focusExpand size="sm" />
        <ChipButton active={false} onClick={() => setReload((n) => n + 1)} {...NOT_A_TOGGLE}>
          <span className="inline-flex items-center gap-1.5">
            <RefreshCw className="h-3 w-3" aria-hidden="true" />
            Refresh
          </span>
        </ChipButton>
        {known && needle !== '' ? <span className={TEXT_MUTED_SM} aria-live="polite">{`${shownEntries} of ${data.entryCount} entries shown`}</span> : null}
      </div>

      {badRefresh ? <p className={NOTICE_WARNING}>{`refreshSeconds must be from 5 to 600, got ${String(refreshSeconds)}: the page is re-read every 15 s. Fix it in the view (allowed.yaml).`}</p> : null}
      {error !== undefined ? (
        <div role="alert" className={LOAD_ERROR}>
          <span className={TEXT_ERROR}>{error}</span>
          <ButtonAction label="Retry" variant="secondary" size="sm" onClick={() => setReload((n) => n + 1)} />
        </div>
      ) : null}

      {outcome !== null ? (
        <div role={outcome.tone === 'danger' ? 'alert' : 'status'} aria-label="Last change" className={outcome.tone === 'success' ? NOTICE_SUCCESS : outcome.tone === 'warning' ? NOTICE_WARNING : LOAD_ERROR}>
          {outcome.text}
        </div>
      ) : null}

      {known ? (
        <>
          {data.warnings.map((w) => (
            <p key={w} className={NOTICE_WARNING}>{w}</p>
          ))}
          {shown.length > 0 && active !== undefined ? (
            <Tabs
              value={active}
              onChange={setChosen}
              tabs={shown.map(({ machine, rows }) => ({
                key: machine.uuid,
                label: labelOf(machine, rows.length),
                children: (
                  <AllowedMachineBlock
                    machine={machine}
                    rows={rows}
                    needle={needle}
                    sortCol={sortCol}
                    sortDir={sortDir}
                    onSortColChange={setSortCol}
                    onSortDirChange={setSortDir}
                    refreshing={loading}
                    api={api.current as AllowApi}
                    saferMode={safer.on}
                    onEdited={(done) => {
                      setOutcome(done);
                      // The list is the daemon's own again (a signed change is recorded here even when its delivery failed).
                      setReload((n) => n + 1);
                    }}
                  />
                ),
              }))}
            />
          ) : null}
        </>
      ) : loading && error === undefined ? (
        <p className={TEXT_MUTED_SM} aria-live="polite">Loading...</p>
      ) : null}
    </section>
  );
}
