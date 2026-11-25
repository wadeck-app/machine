import { Tabs, type SortDir } from '@wadeck-app/dsl-ui';
import { useMemo, useRef, useState } from 'react';
import { shellAllowApi, type AllowApi } from '../lib/allowFlow.js';
import type { EditOutcome } from '../lib/allowedEdit.js';
import { NOTICE_SUCCESS, NOTICE_WARNING, TEXT_MUTED_SM } from '../lib/styleTokens.js';
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
  /** The answer of `GET /api/modules/machine/allowed` (`$sources.allowed`, polled by the page). Absent: not read yet, or the read failed (the page's notifier says why). */
  data?: AllowedPageData;
  /** The search word (`$urlParam.search`, typed in the SearchBar of the page). */
  search?: string;
  /**
   * True until the first read of the page's sources has finished.
   * @ctxDefault $initialLoading
   */
  loading?: boolean;
  /**
   * A re-read is in flight while the rows are shown.
   * @ctxDefault $refreshing
   */
  refreshing?: boolean;
  /**
   * Re-runs the page's sources, so the list is the daemon's own after a change. Defaults to the page's `$refresh`.
   * @ctxDefault $refresh
   */
  onRefresh?: (source?: string) => Promise<void>;
}

const LOAD_ERROR = 'flex flex-col items-start gap-2 rounded border border-danger bg-danger-bg p-3 text-sm text-danger-text';
const NOT_READ = 'The list of allowed commands could not be read: the reason is in the notification of the page (the machine daemon or the module is not running, or this machine is not initialized). Fix it, then press Refresh.';

/** The tab label: name and entries (the entries that match the search while one is typed), and a word when the policy could not be read. */
const labelOf = (m: AllowedMachineData, count: number): string => `${m.name} (${count})${m.problem === '' ? '' : ' - unreadable policy'}`;

/**
 * The Allowed page: the commands approved for each machine, the same lists `machine allowed <machine>` prints. One tab per machine, one table per tab. The page
 * (allowed.yaml) reads the route, polls it, owns the search field and the Refresh button; this component shows what it is given.
 * Where this machine can sign (the admin machine, policy mode admin), a row can be deleted or given another lifetime, one by one or by a selection of the
 * shared table (decision 112): the confirmation names the exact commands, the signature is made IN THE BROWSER with the unlocked admin key like Allow. Elsewhere
 * it is read-only and says why. A command is shown as text, never as HTML.
 *
 * @registryCategory composite
 * @registryTags allowed whitelist allow list policy commands approved machines
 */
export function AllowedList({ data, search = '', loading = false, refreshing = false, onRefresh }: AllowedListProps) {
  const [chosen, setChosen] = useState<string | undefined>(undefined);
  // Most recent use first; kept here so that the choice survives a change of tab and a re-read.
  const [sortCol, setSortCol] = useState('lastUsedSort');
  const [sortDir, setSortDir] = useState<SortDir>('desc');
  // What the last change did (signed, delivered or not), kept until the next one.
  const [outcome, setOutcome] = useState<EditOutcome | null>(null);
  const api = useRef<AllowApi | null>(null);
  api.current ??= shellAllowApi();
  const safer = useSaferMode();

  const needle = search.trim().toLowerCase();
  const machines = useMemo(() => data?.machines ?? [], [data]);
  const shown = useMemo(() => machines.map((m) => ({ machine: m, rows: m.entries.filter((e) => matches(needle, e)) })), [machines, needle]);
  const shownEntries = shown.reduce((n, s) => n + s.rows.length, 0);
  // The tab of the user, else the first machine that holds entries (the others are one click away), else the first.
  const active = shown.find((s) => s.machine.uuid === chosen)?.machine.uuid ?? (shown.find((s) => s.machine.entries.length > 0) ?? shown[0])?.machine.uuid;

  return (
    <section className="flex flex-col gap-3" aria-label="Allowed commands">
      <UnlockedKeyBar variant="chip" />
      {data !== undefined && needle !== '' ? <span className={TEXT_MUTED_SM} aria-live="polite">{`${shownEntries} of ${data.entryCount} entries shown`}</span> : null}

      {outcome !== null ? (
        <div role={outcome.tone === 'danger' ? 'alert' : 'status'} aria-label="Last change" className={outcome.tone === 'success' ? NOTICE_SUCCESS : outcome.tone === 'warning' ? NOTICE_WARNING : LOAD_ERROR}>
          {outcome.text}
        </div>
      ) : null}

      {data !== undefined ? (
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
                    refreshing={refreshing}
                    api={api.current as AllowApi}
                    saferMode={safer.on}
                    onEdited={(done) => {
                      setOutcome(done);
                      // The list is the daemon's own again (a signed change is recorded here even when its delivery failed).
                      void onRefresh?.('allowed');
                    }}
                  />
                ),
              }))}
            />
          ) : null}
        </>
      ) : loading ? (
        <p className={TEXT_MUTED_SM} aria-live="polite">Loading...</p>
      ) : (
        <div role="alert" className={LOAD_ERROR}>{NOT_READ}</div>
      )}
    </section>
  );
}
