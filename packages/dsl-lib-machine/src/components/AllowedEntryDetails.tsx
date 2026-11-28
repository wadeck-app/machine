import { Notice } from '@wadeck-app/dsl-ui';
import type { AllowedEntryData, AllowedMachineData } from './AllowedList.js';
import { MONO_STYLE, COMMAND_TEXT } from '../lib/styleTokens.js';

// Sticky and bounded: on a narrow screen the table scrolls sideways and the text would otherwise run under the edge.
const DETAILS = 'sticky left-0 flex max-w-[calc(100vw-9rem)] flex-col gap-1 text-sm';
const NO_COMMAND = 'No terminal command withdraws an entry of a per-peer list of an admin policy: `machine admin allow` edits the default list only.';
const USE_BUTTON = 'No terminal command withdraws an entry of a per-peer list of an admin policy; use the Delete button of the row.';

/** The secondary facts of an entry, reachable from the keyboard (a tooltip is not). */
export function AllowedEntryDetails({ row, machine }: { row: AllowedEntryData; machine: AllowedMachineData }) {
  return (
    <div role="group" aria-label={`Details of ${row.text}`} className={DETAILS}>
      <p><span className="text-muted">List: </span>{row.listTitle}<span className="ml-2 text-muted">place</span> <span>{`#${row.index}`}</span></p>
      {row.typed ? <Notice variant="default" label="Typed entry: the command is a template, each placeholder accepts only a value of its type." /> : null}
      {row.limitNote !== '' ? <Notice variant="default" label={row.limitNote} /> : null}
      {row.lastUsedNote !== '' ? <Notice variant="default" label={`Last used: ${row.lastUsedNote}`} /> : null}
      {machine.deliveryNote !== '' ? <Notice variant="default" label={machine.deliveryNote} /> : null}
      <p>
        <span className="text-muted">Withdraw it from a terminal: </span>
        {row.removeCommand === '' ? <span className="text-muted">{machine.canEdit ? USE_BUTTON : NO_COMMAND}</span> : <code className={COMMAND_TEXT} style={MONO_STYLE}>{row.removeCommand}</code>}
      </p>
    </div>
  );
}
