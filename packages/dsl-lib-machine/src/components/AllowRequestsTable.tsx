import React, { useEffect, useRef, useState } from 'react';
import { loadContext, prepareAllow, shellAllowApi, signAndSubmitAllow, type AllowApi, type AllowContext, type AllowPrepared, type AllowResult } from '../lib/allowFlow.js';
import { ConfirmSignModal } from './ConfirmSignModal.js';

export interface PendingRequestRow {
  peerText: string;
  peer: string;
  shell: string;
  command: string;
  countText: string;
  firstSeenText: string;
  lastSeenText: string;
  /** The `machine admin allow ...` command that does the same from a terminal. */
  nextCommand: string;
  nextWhere: string;
}

export interface AllowRequestsTableProps {
  /** The pending requests of the Requests page (`$sources.requests.pending`). */
  rows?: PendingRequestRow[];
  /** Whether Allow is offered here and for which machine (`$sources.requests.allow`): the admin machine, in policy mode admin. */
  allow?: { available: boolean; machine: { uuid: string; name: string }; note: string };
  emptyMessage?: string;
  /**
   * Re-runs the page's sources, so the list is the daemon's own after an allow. Defaults to the page's `$refresh`.
   * @ctxDefault $refresh
   */
  onRefresh?: (source?: string) => Promise<void>;
}

const rowKey = (r: PendingRequestRow): string => `${r.peer}\u0000${r.shell}\u0000${r.command}`;

type Phase =
  | { kind: 'loading' }
  | { kind: 'ready'; context: AllowContext; prepared: AllowPrepared }
  | { kind: 'info'; message: string }
  | { kind: 'failed'; message: string }
  | { kind: 'signing'; context: AllowContext; prepared: AllowPrepared };

interface DialogProps {
  row: PendingRequestRow;
  machine: { uuid: string; name: string };
  api: AllowApi;
  onClose: () => void;
  onDone: (result: AllowResult) => void;
}

/** The confirmation of ONE row: loads the context (after the PIN), shows the exact change, asks the passphrase, signs in the page and posts. */
function AllowDialog({ row, machine, api, onClose, onDone }: DialogProps) {
  const [phase, setPhase] = useState<Phase>({ kind: 'loading' });
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    (async () => {
      try {
        const context = await loadContext(api, machine.uuid);
        const prepared = await prepareAllow(context, { shell: row.shell, command: row.command }, Math.floor(Date.now() / 1000));
        if (!mounted.current) return;
        if (!prepared.changed) {
          setPhase({ kind: 'info', message: `${row.shell} ${JSON.stringify(row.command)} is already allowed on "${machine.name}": nothing to sign. The list below catches up at its next refresh.` });
          return;
        }
        setPhase({ kind: 'ready', context, prepared });
      } catch (e) {
        if (mounted.current) setPhase({ kind: 'failed', message: (e as Error).message });
      }
    })();
    return () => {
      mounted.current = false;
    };
  }, [api, machine.uuid, machine.name, row.shell, row.command]);

  const confirm = (take: () => string) => {
    if (phase.kind !== 'ready') return;
    const { context, prepared } = phase;
    // The passphrase is a local variable of this call: read and cleared from the field at once, never stored, never passed anywhere but the signature.
    let passphrase = take();
    setError(null);
    setPhase({ kind: 'signing', context, prepared });
    signAndSubmitAllow(api, context, { shell: row.shell, command: row.command }, passphrase, Math.floor(Date.now() / 1000)).then(
      result => {
        passphrase = '';
        if (mounted.current) onDone(result);
      },
      (e: unknown) => {
        passphrase = '';
        if (!mounted.current) return;
        setError((e as Error).message);
        setPhase({ kind: 'ready', context, prepared });
      },
    );
  };

  if (phase.kind === 'loading') {
    return <ConfirmSignModal title={`Allow on ${machine.name}`} details={[]} warning="" needsPassphrase={false} confirmLabel="" onConfirm={() => undefined} onCancel={onClose} notes={['Checking the current policy...']} />;
  }
  if (phase.kind === 'info' || phase.kind === 'failed') {
    return <ConfirmSignModal title={`Allow on ${machine.name}`} details={[]} warning="" needsPassphrase={false} confirmLabel="" error={phase.kind === 'failed' ? phase.message : null} notes={phase.kind === 'info' ? [phase.message] : []} onConfirm={() => undefined} onCancel={onClose} />;
  }
  const { prepared, context } = phase;
  const notes = [
    `Policy version ${prepared.fromVersion} -> ${prepared.toVersion}, edited from the one ${context.source}. After this change every trusted peer may run ${prepared.defaultCount} command${prepared.defaultCount === 1 ? '' : 's'} on ${machine.name}.`,
    ...(prepared.peersWithOwnList.length > 0 ? [`Not affected (they have their own list): ${prepared.peersWithOwnList.join(', ')}.`] : []),
    context.delivery === 'install' ? `It is signed here, in this page, and installed on ${machine.name} (this machine).` : `It is signed here, in this page, and stored in the relay inbox of ${machine.name}.`,
  ];
  return (
    <ConfirmSignModal
      title={`Allow this command on ${machine.name}?`}
      details={[
        { label: 'Machine', value: machine.name },
        { label: 'Shell', value: row.shell },
        { label: 'Command', value: row.command },
        { label: 'Asked by', value: `${row.peerText} (${row.countText})` },
      ]}
      notes={notes}
      warning={`This widens what peers may run on ${machine.name}: the command is allowed to EVERY trusted peer, not only ${row.peerText}, byte for byte, until you remove it. Only the admin passphrase can sign it.`}
      confirmLabel="Allow and sign"
      busy={phase.kind === 'signing'}
      error={error}
      onConfirm={confirm}
      onCancel={onClose}
    />
  );
}

/**
 * The "Waiting for approval" table of the Requests page, with an Allow button on each row: it does what `machine admin allow <machine> --shell <s> -- <command>`
 * does, but the admin passphrase and the unlocked key exist ONLY in this page (decision 76). A confirmation names the machine, the shell and the exact command,
 * asks the passphrase, signs the next policy here (machine-webcrypto) and posts only the signed documents; the daemon verifies them before it stores them.
 *
 * @registryCategory composite
 * @registryTags requests allow policy admin
 */
export function AllowRequestsTable({ rows = [], allow, emptyMessage = 'No request is waiting for approval', onRefresh }: AllowRequestsTableProps) {
  const [selected, setSelected] = useState<PendingRequestRow | null>(null);
  const [allowed, setAllowed] = useState<ReadonlySet<string>>(new Set());
  const [result, setResult] = useState<string | null>(null);
  const api = useRef<AllowApi | null>(null);
  api.current ??= shellAllowApi();

  const visible = rows.filter(r => !allowed.has(rowKey(r)));
  const canAllow = allow?.available === true;

  const done = (row: PendingRequestRow, answer: AllowResult) => {
    setAllowed(prev => new Set(prev).add(rowKey(row)));
    setSelected(null);
    const where = answer.delivery === 'installed' ? `installed on ${answer.target.name}` : `stored in the relay inbox of ${answer.target.name}: its daemon installs it within about a minute`;
    setResult(`Allowed ${row.shell} ${JSON.stringify(row.command)}: policy version ${answer.version} is ${where}. \`machine allowed ${answer.target.name}\` lists it.`);
    // The page's own data catches up (the allowed command leaves the pending list); a failure is reported by the page's notifier.
    void onRefresh?.('requests');
  };

  return (
    <div className="flex flex-col gap-3">
      {result !== null && (
        <div role="status" className="rounded border border-green-600 bg-green-50 p-2 text-sm text-green-900 dark:bg-green-950 dark:text-green-100">{result}</div>
      )}
      {allow !== undefined && !canAllow && allow.note !== '' && (
        <div className="rounded border border-gray-300 p-2 text-sm text-gray-700 dark:text-gray-300">{allow.note}</div>
      )}
      {visible.length === 0 ? (
        <div className="py-2 text-sm text-gray-600 dark:text-gray-400">{emptyMessage}</div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-gray-300 text-gray-600 dark:text-gray-400">
                <th className="px-2 py-1 font-medium">From</th>
                <th className="px-2 py-1 font-medium">Shell</th>
                <th className="px-2 py-1 font-medium">Command</th>
                <th className="px-2 py-1 font-medium">Times</th>
                <th className="px-2 py-1 font-medium">First</th>
                <th className="px-2 py-1 font-medium">Last</th>
                <th className="px-2 py-1 font-medium">{canAllow ? 'Action' : 'To allow it'}</th>
              </tr>
            </thead>
            <tbody>
              {visible.map(r => (
                <tr key={rowKey(r)} className="border-b border-gray-200 align-top">
                  <td className="whitespace-nowrap px-2 py-1">{r.peerText}</td>
                  <td className="whitespace-nowrap px-2 py-1">{r.shell}</td>
                  <td className="break-all px-2 py-1 font-mono">{r.command}</td>
                  <td className="whitespace-nowrap px-2 py-1">{r.countText}</td>
                  <td className="whitespace-nowrap px-2 py-1">{r.firstSeenText}</td>
                  <td className="whitespace-nowrap px-2 py-1">{r.lastSeenText}</td>
                  <td className="px-2 py-1">
                    {canAllow ? (
                      <button type="button" aria-label={`Allow ${r.command}`} onClick={() => setSelected(r)} className="rounded bg-blue-600 px-3 py-1 text-white">
                        Allow
                      </button>
                    ) : (
                      <span className="break-all font-mono text-xs">{r.nextCommand}</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {selected !== null && allow !== undefined && (
        <AllowDialog key={rowKey(selected)} row={selected} machine={allow.machine} api={api.current} onClose={() => setSelected(null)} onDone={answer => done(selected, answer)} />
      )}
    </div>
  );
}
