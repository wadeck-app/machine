import React, { useMemo, useRef, useState } from 'react';
import { ButtonAction, FieldSelect } from '@wadeck-app/dsl-ui';
import { readAdminKeyHint, shellAllowApi, type AllowApi } from '../lib/allowFlow.js';
import { mergeNotices, type NoticeData } from '../lib/noticeRows.js';
import { elevateForRemote, fetchRemoteRequests, type RemoteOutcome } from '../lib/remoteRequestsFlow.js';
import { NOTICE_NEUTRAL, NOTICE_WARNING, TEXT_ERROR, TEXT_MUTED_SM } from '../lib/styleTokens.js';
import { AllowRequestsTable, type PendingRequestRow } from './AllowRequestsTable.js';
import { ConfirmSignModal } from './ConfirmSignModal.js';
import { HeldRequests, type HeldRequestRow } from './HeldRequests.js';

type Capability = { available: boolean; machine: { uuid: string; name: string }; note: string };

export interface RequestsOverviewProps {
  /** This machine (`$sources.requests.machine`). */
  self?: { uuid: string; name: string };
  /** The trusted machines (`$sources.machines.machines`): this one and its peers. */
  machines?: Array<{ uuid: string; name: string; self?: boolean }>;
  /** The requests held right now on THIS machine (`$sources.requests.waiting`), soonest deadline first. */
  held?: HeldRequestRow[];
  /** The requests refused on THIS machine because the command is not allowed (`$sources.requests.pending`). */
  pending?: PendingRequestRow[];
  /** Whether Allow is offered for this machine (`$sources.requests.allow`). */
  allow?: Capability;
  /** Whether this machine may ask the others (`$sources.requests.remote`): the admin machine only. */
  remote?: { available: boolean; note: string };
  /** What OTHER machines reported (`$sources.requests.notices`): held and refused requests, not verified live. Shown without a passphrase; Load the other machines replaces them with the live rows. */
  notices?: NoticeData[];
  /** Why the notices may be incomplete (`$sources.requests.noticesError`); shown as a warning when not empty. */
  noticesError?: string;
  emptyMessage?: string;
  /**
   * Re-runs the page's sources, so the lists are the daemon's own after an allow or a deny. Defaults to the page's $refresh.
   * @ctxDefault $refresh
   */
  onRefresh?: (source?: string) => Promise<void>;
}

const ALL = 'all';
const NO_HELD: HeldRequestRow[] = [];
const NO_PENDING: PendingRequestRow[] = [];
const NO_NOTICES: NoticeData[] = [];
const NO_MACHINES: Array<{ uuid: string; name: string; self?: boolean }> = [];

const clock = (ms: number): string => new Date(ms).toTimeString().slice(0, 5);

/**
 * The held and refused requests of ALL the trusted machines, with a machine filter. This machine's own come from the page; the others are loaded on
 * demand by the admin machine: the page signs a read-only requests-list per peer IN THE BROWSER with the admin key (passphrase asked each time, never
 * stored), the daemon forwards it, the peer answers (same authorization as the CLI `machine requests <machine>`). Allow signs the policy of the machine the row
 * belongs to. Deny of a request held elsewhere is sent by the daemon of this machine to the machine that holds it (it must name this machine among its notice recipients).
 *
 * @registryCategory composite
 * @registryTags requests allow hold policy admin machines
 */
export function RequestsOverview({ self, machines = NO_MACHINES, held = NO_HELD, pending = NO_PENDING, allow, remote, notices = NO_NOTICES, noticesError = '', emptyMessage = 'No request is waiting for approval', onRefresh }: RequestsOverviewProps) {
  const [filter, setFilter] = useState(ALL);
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [modalError, setModalError] = useState<string | null>(null);
  const [startError, setStartError] = useState<string | null>(null);
  const [hint, setHint] = useState<string | null>(null);
  const [loaded, setLoaded] = useState<{ at: number; outcomes: RemoteOutcome[] } | null>(null);
  const api = useRef<AllowApi | null>(null);
  api.current ??= shellAllowApi();

  const peers = useMemo(() => machines.filter((m) => m.self !== true && m.uuid !== self?.uuid).map((m) => ({ uuid: m.uuid, name: m.name })), [machines, self?.uuid]);
  // The countdown of this machine's own rows runs from the moment the page got them, whatever else is loaded or filtered meanwhile.
  const ownFetchedAt = useMemo(() => Date.now(), [held]);
  const showSelf = filter === ALL || filter === self?.uuid;

  const ownRows = useMemo<HeldRequestRow[]>(() => (showSelf ? held.map((r) => ({ ...r, fetchedAtMs: ownFetchedAt })) : []), [held, showSelf, ownFetchedAt]);
  const remoteRows = useMemo<HeldRequestRow[]>(() => {
    if (loaded === null) {
      return [];
    }
    return loaded.outcomes.flatMap((o) => {
      if (!o.ok || (filter !== ALL && filter !== o.peer.uuid)) {
        return [];
      }
      return o.page.waiting.map((w) => ({ ...w, machine: o.page.machine, canAllow: o.page.allow.available, fetchedAtMs: loaded.at }));
    });
  }, [loaded, filter]);
  // The notices of a machine the page has loaded live are replaced by its live rows; a machine that did not answer keeps its notices.
  const loadedMachines = useMemo(() => new Set((loaded?.outcomes ?? []).flatMap((o) => (o.ok ? [o.peer.uuid] : []))), [loaded]);
  // The countdown of a notice runs from the moment the page got it.
  const noticesFetchedAt = useMemo(() => Date.now(), [notices]);
  const noticeRows = useMemo(() => mergeNotices({ notices, selfUuid: self?.uuid, loadedMachines, filter, allowAvailable: allow?.available === true }), [notices, self?.uuid, loadedMachines, filter, allow?.available]);
  const noticeHeld = useMemo<HeldRequestRow[]>(() => noticeRows.held.map((r) => ({ ...r, fetchedAtMs: noticesFetchedAt })), [noticeRows, noticesFetchedAt]);
  const rows = useMemo(() => [...ownRows, ...remoteRows, ...noticeHeld].sort((a, b) => a.secondsLeft - b.secondsLeft), [ownRows, remoteRows, noticeHeld]);

  const options = [{ value: ALL, label: 'All machines' }, ...(self !== undefined ? [{ value: self.uuid, label: `${self.name} (this machine)` }] : []), ...peers.map((p) => ({ value: p.uuid, label: p.name }))];

  const start = async () => {
    setStartError(null);
    try {
      // The PIN first, before the passphrase form (same order as the Allow button).
      await elevateForRemote(api.current as AllowApi);
      // The hint of the key is stored in clear: on screen before the passphrase is typed (a damaged key file stops here, with its fix).
      setHint((await readAdminKeyHint(api.current as AllowApi)) ?? null);
      setModalError(null);
      setAsking(true);
    } catch (e) {
      setStartError((e as Error).message);
    }
  };

  const confirm = (take: () => string) => {
    if (self === undefined) {
      return;
    }
    // The passphrase is a local variable of this call: read and cleared from the field at once, never stored, never passed anywhere but the unlock.
    let passphrase = take();
    setBusy(true);
    setModalError(null);
    fetchRemoteRequests(api.current as AllowApi, { selfUuid: self.uuid, peers, passphrase, now: Math.floor(Date.now() / 1000) }).then(
      (outcomes) => {
        passphrase = '';
        setLoaded({ at: Date.now(), outcomes });
        setBusy(false);
        setAsking(false);
      },
      (e: unknown) => {
        passphrase = '';
        setModalError((e as Error).message);
        setBusy(false);
      },
    );
  };

  const failures = loaded?.outcomes.filter((o): o is Extract<RemoteOutcome, { ok: false }> => !o.ok) ?? [];
  const pages = (loaded?.outcomes ?? []).flatMap((o) => (o.ok && (filter === ALL || filter === o.peer.uuid) ? [o.page] : []));
  const counts = `${rows.length} held request${rows.length === 1 ? '' : 's'}`;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end gap-3">
        <div className="min-w-48">
          <FieldSelect label="Machine" value={filter} onChange={setFilter} options={options} />
        </div>
        {remote?.available === true && peers.length > 0 && (
          <ButtonAction label={loaded === null ? 'Load the other machines' : 'Reload the other machines'} variant="secondary" onClick={() => void start()} />
        )}
      </div>
      {remote !== undefined && !remote.available && remote.note !== '' && <div className={NOTICE_NEUTRAL}>{remote.note}</div>}
      {remote?.available === true && peers.length === 0 && <div className={NOTICE_NEUTRAL}>This machine trusts no other machine yet: there is nothing to load (see the Machines page).</div>}
      {startError !== null && <div role="alert" className={TEXT_ERROR}>{startError}</div>}
      {loaded !== null && (
        <div className={TEXT_MUTED_SM}>
          Other machines loaded at {clock(loaded.at)} ({loaded.outcomes.length - failures.length} of {loaded.outcomes.length} answered). They are not refreshed by themselves: reload to see newer requests.
        </div>
      )}
      {noticesError !== '' && (
        <div role="alert" className={NOTICE_WARNING}>
          Request notices from the other machines may be missing: {noticesError}
        </div>
      )}
      {failures.map((f) => (
        <div key={f.peer.uuid} role="alert" className={NOTICE_WARNING}>
          {f.peer.name}: {f.message}
        </div>
      ))}

      <HeldRequests rows={rows} allow={allow} {...(onRefresh !== undefined ? { onRefresh } : {})} />
      {rows.length === 0 && <div className={TEXT_MUTED_SM}>No held request{filter === ALL ? '' : ' for this machine'} ({counts}).</div>}

      {showSelf && (
        <div className="flex flex-col gap-2">
          <h3 className="text-base font-semibold text-content">Waiting for approval{self !== undefined ? ` on ${self.name}` : ''}</h3>
          <AllowRequestsTable rows={pending} allow={allow} emptyMessage={emptyMessage} {...(onRefresh !== undefined ? { onRefresh } : {})} />
        </div>
      )}
      {pages.map((page) => (
        <div key={page.machine.uuid} className="flex flex-col gap-2">
          <h3 className="text-base font-semibold text-content">Waiting for approval on {page.machine.name}</h3>
          {!page.chainOk && <div className={NOTICE_WARNING}>{page.chainText}</div>}
          <AllowRequestsTable rows={page.pending} allow={page.allow} emptyMessage={`No refused request on ${page.machine.name}`} />
          {page.notes.map((n) => (
            <div key={n} className={TEXT_MUTED_SM}>{n}</div>
          ))}
        </div>
      ))}

      {noticeRows.refused.map((section) => (
        <div key={section.machine.uuid} className="flex flex-col gap-2">
          <h3 className="text-base font-semibold text-content">Waiting for approval on {section.machine.name}</h3>
          <AllowRequestsTable rows={section.rows} allow={{ available: allow?.available === true, machine: section.machine, note: '' }} emptyMessage={`No refused request on ${section.machine.name}`} {...(onRefresh !== undefined ? { onRefresh } : {})} />
        </div>
      ))}

      {asking && (
        <ConfirmSignModal
          title="Load the requests of the other machines?"
          details={[{ label: 'Machines', value: peers.map((p) => p.name).join(', ') }]}
          notes={['Each machine is asked for its held requests and its refused ones, over the authenticated channel, with a read-only request signed here. Nothing is run and nothing is changed on any machine; each machine records the exchange.']}
          warning="The admin passphrase unlocks the admin key in this page for the signatures only. It is not stored and not sent: only the signed requests leave the page."
          confirmLabel="Sign and load"
          busy={busy}
          error={modalError}
          hint={hint}
          onConfirm={confirm}
          onCancel={() => setAsking(false)}
        />
      )}
    </div>
  );
}
