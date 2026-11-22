import React from 'react';
import { COMMAND_TEXT, MONO_STYLE, NOTICE_WARNING, TABLE_BODY_ROW, TEXT_MUTED_SM } from '../lib/styleTokens.js';
import type { AllowedEntryData, AllowedListData, AllowedMachineData } from './AllowedList.js';
import { MachineName } from './MachineName.js';

const BLOCK = 'flex flex-col gap-2 rounded border border-border p-3';
const SHELL_HEAD = 'py-1 pt-2 text-left text-xs font-medium text-muted';
const TYPED_TAG = 'ml-2 rounded border border-border px-1 text-xs text-muted';
const ALERT = 'rounded border border-danger bg-danger-bg p-2 text-sm text-danger-text';

/** True when the entry shows under the search word (empty: all): its command, shell, peer or lifetime contains it. */
export const matches = (needle: string, e: AllowedEntryData, list: AllowedListData): boolean =>
  needle === '' || [e.text, e.shell, list.peerName, e.lifetimeText].some((field) => field.toLowerCase().includes(needle));

/** The entries of a list grouped under their shell (shells in the order of their first entry), each keeping its place in the list. */
function byShell(entries: AllowedEntryData[]): Array<{ shell: string; entries: AllowedEntryData[] }> {
  const shells = [...new Set(entries.map((e) => e.shell))];
  return shells.map((shell) => ({ shell, entries: entries.filter((e) => e.shell === shell) }));
}

/** One machine of the Allowed page: its header, where its list comes from, and its entries by shell. Read-only; every command is text. */
export function AllowedMachineBlock({ machine, needle }: { machine: AllowedMachineData; needle: string }) {
  const visible = machine.lists.map((l) => ({ list: l, entries: l.entries.filter((e) => matches(needle, e, l)) }));
  const total = machine.lists.reduce((n, l) => n + l.entries.length, 0);
  const none = visible.every((v) => v.entries.length === 0);
  return (
    <section className={BLOCK} aria-label={`Allowed on ${machine.name}`}>
      <header className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h3 className="text-base font-semibold"><MachineName name={machine.name} /></h3>
        {machine.version !== null ? <span className={TEXT_MUTED_SM}>{`version ${machine.version}`}</span> : null}
        {machine.version !== null ? <span className={TEXT_MUTED_SM}>{`mode ${machine.mode}`}</span> : null}
        {machine.signedText !== '' ? <span className={TEXT_MUTED_SM} title={machine.signedIso}>{machine.signedText}</span> : null}
        {machine.version !== null ? <span className={TEXT_MUTED_SM}>{`${total} ${total === 1 ? 'entry' : 'entries'}`}</span> : null}
      </header>
      <p className={TEXT_MUTED_SM}>{machine.sourceText}</p>
      {machine.deliveryNote !== '' ? <p className={NOTICE_WARNING}>{machine.deliveryNote}</p> : null}
      {machine.problem !== '' ? (
        <div role="alert" className={ALERT}>{machine.problem}</div>
      ) : null}
      {machine.emptyText !== '' ? (
        <div className="flex flex-col gap-1">
          <p className={TEXT_MUTED_SM}>{machine.emptyText}</p>
          <p className={TEXT_MUTED_SM}>
            Allow a first command with
            {' '}
            <code className={COMMAND_TEXT} style={MONO_STYLE}>{machine.fillCommand}</code>
          </p>
        </div>
      ) : null}
      {machine.version !== null && total === 0 ? <p className={TEXT_MUTED_SM}>{`Nothing is allowed for ${machine.name}: this policy has no entry, so every command is refused.`}</p> : null}
      {total > 0 && none ? <p className={TEXT_MUTED_SM}>{`No entry matches "${needle}" on ${machine.name}. Clear the search to see all ${total}.`}</p> : null}
      {visible.map(({ list, entries }) =>
        entries.length === 0 ? null : (
          <div key={list.key} className="flex flex-col gap-1">
            <h4 className="text-sm font-medium">{list.title}</h4>
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead className="sr-only">
                  <tr>
                    <th>Place</th>
                    <th>Command</th>
                    <th>Lifetime</th>
                  </tr>
                </thead>
                <tbody>
                  {byShell(entries).map((group) => (
                    <React.Fragment key={group.shell}>
                      <tr className="border-b border-border">
                        <th scope="row" colSpan={3} className={SHELL_HEAD}>{group.shell}</th>
                      </tr>
                      {group.entries.map((e) => (
                        <tr key={e.key} className={TABLE_BODY_ROW}>
                          <td className="whitespace-nowrap py-1 pr-3 text-muted">{`#${e.index}`}</td>
                          <td className="py-1 pr-3">
                            <span className={COMMAND_TEXT} style={MONO_STYLE}>{e.text}</span>
                            {e.typed ? <span className={TYPED_TAG}>typed</span> : null}
                          </td>
                          <td className="py-1">
                            <span className={e.limited ? '' : 'text-muted'}>{e.lifetimeText}</span>
                            {e.limitNote !== '' ? <div className="text-xs text-muted">{e.limitNote}</div> : null}
                          </td>
                        </tr>
                      ))}
                    </React.Fragment>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        ),
      )}
    </section>
  );
}
