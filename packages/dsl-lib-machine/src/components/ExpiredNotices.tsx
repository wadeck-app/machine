import React, { useRef, useState } from 'react';
import { ButtonAction, Notice, Text } from '@wadeck-app/dsl-ui';
import { shellAllowApi, type AllowApi } from '../lib/allowFlow.js';
import { dismissFailureMessage, dismissNotice, type DismissTarget } from '../lib/dismissNotice.js';
import { MachineName } from './MachineName.js';
import { MONO_STYLE, HELD_COMMAND } from '../lib/styleTokens.js';

/** Above this many rows the Clear expired button is offered. */
export const CLEAR_ABOVE = 2;

export interface ExpiredRow {
  id: string;
  /** The machine that reported the request (uuid and name): where it was held. */
  machine: { uuid: string; name: string };
  peerText: string;
  shell: string;
  command: string;
  commandTruncated?: boolean;
  /** Muted text: who reported it and when. */
  note: string;
}

export interface ExpiredNoticesProps {
  rows: ExpiredRow[];
  /**
   * Re-runs the page's sources, so the list is the daemon's own after a dismiss. Defaults to the page's `$refresh`.
   * @ctxDefault $refresh
   */
  onRefresh?: (source?: string) => Promise<void>;
}

const keyOf = (r: ExpiredRow): string => `${r.machine.uuid}\u0000${r.id}`;

/**
 * Held requests whose deadline passed with no end notice received (decision 100): the machine that held them never said how they ended (an older build, a
 * lost frame). They are NOT live: no Allow, no Deny (a caller no longer waits), only Dismiss, which removes the notice from this machine's notices.json (never an audit
 * line). Dismiss is a local action on a display row: no passphrase and no PIN. Clear expired removes all of them at once.
 */
export function ExpiredNotices({ rows, onRefresh }: ExpiredNoticesProps) {
  const [gone, setGone] = useState<ReadonlySet<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const api = useRef<AllowApi | null>(null);
  api.current ??= shellAllowApi();

  const visible = rows.filter((r) => !gone.has(keyOf(r)));
  if (visible.length === 0) {
    return null;
  }

  const run = (target: DismissTarget, keys: string[]) => {
    setBusy(true);
    setError(null);
    dismissNotice(api.current as AllowApi, target).then(
      () => {
        setGone((prev) => new Set([...prev, ...keys]));
        setBusy(false);
        // The page's own data catches up; a failure is reported by the page's notifier.
        void onRefresh?.('requests');
      },
      (e: unknown) => {
        setBusy(false);
        setError(dismissFailureMessage(e));
      },
    );
  };

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-base font-semibold text-content">Expired (no end notice received)</h3>
        {visible.length > CLEAR_ABOVE && <ButtonAction label="Clear expired" variant="secondary" size="sm" disabled={busy} onClick={() => run({ expired: true }, visible.map(keyOf))} />}
      </div>
      <Notice variant="default" label="The deadline of these held requests has passed and the machine that held them never said how they ended: nobody waits for an answer any more. Dismiss removes them from this list only." />
      {error !== null && <Notice variant="danger" label={error} />}
      <ul className="flex flex-col gap-2">
        {visible.map((r) => (
          <li key={keyOf(r)} aria-label={`Expired request ${r.command}`} data-testid="expired-row" className="flex flex-col gap-1.5 rounded-lg border border-border px-3 py-2">
            <div className="flex flex-wrap items-baseline justify-between gap-x-2">
              <span className="text-sm text-muted">
                From <MachineName name={r.peerText} /> on <MachineName name={r.machine.name} /> in <Text mono text={r.shell} />
              </span>
              <span className="text-sm font-medium text-muted">expired, no end notice received</span>
            </div>
            {/* The command is untrusted text (a notice comes from another machine): a text node only, never interpreted. */}
            <div className={HELD_COMMAND} style={MONO_STYLE}>{r.command}</div>
            {r.commandTruncated === true && <Notice variant="default" label="Truncated: only the first part of the command was reported." />}
            <div className="text-xs text-muted">{r.note}</div>
            <div>
              <ButtonAction label="Dismiss" variant="secondary" size="sm" disabled={busy} onClick={() => run({ machine: r.machine.uuid, id: r.id }, [keyOf(r)])} />
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
