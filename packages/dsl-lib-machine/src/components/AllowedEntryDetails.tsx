import { COMMAND_TEXT, MONO_STYLE, TEXT_MUTED_SM } from '../lib/styleTokens.js';
import type { AllowedEntryData, AllowedMachineData } from './AllowedList.js';

// Sticky and bounded: on a narrow screen the table scrolls sideways and the text would otherwise run under the edge.
const DETAILS = 'sticky left-0 flex max-w-[calc(100vw-9rem)] flex-col gap-1 text-sm';
const NO_COMMAND = 'No terminal command withdraws an entry of a per-peer list of an admin policy: `machine admin allow` edits the default list only.';
const USE_BUTTON = 'No terminal command withdraws an entry of a per-peer list of an admin policy; use the Delete button of the row.';

/** The secondary facts of an entry, reachable from the keyboard (a tooltip is not). */
export function AllowedEntryDetails({ row, machine }: { row: AllowedEntryData; machine: AllowedMachineData }) {
  return (
    <div role="group" aria-label={`Details of ${row.text}`} className={DETAILS}>
      <p><span className="text-muted">List: </span>{row.listTitle}<span className="ml-2 text-muted">place</span> <span>{`#${row.index}`}</span></p>
      {row.typed ? <p className={TEXT_MUTED_SM}>Typed entry: the command is a template, each placeholder accepts only a value of its type.</p> : null}
      {row.limitNote !== '' ? <p className={TEXT_MUTED_SM}>{row.limitNote}</p> : null}
      {row.lastUsedNote !== '' ? <p className={TEXT_MUTED_SM}>{`Last used: ${row.lastUsedNote}`}</p> : null}
      {machine.deliveryNote !== '' ? <p className={TEXT_MUTED_SM}>{machine.deliveryNote}</p> : null}
      <p>
        <span className="text-muted">Withdraw it from a terminal: </span>
        {row.removeCommand === '' ? <span className="text-muted">{machine.canEdit ? USE_BUTTON : NO_COMMAND}</span> : <code className={COMMAND_TEXT} style={MONO_STYLE}>{row.removeCommand}</code>}
      </p>
    </div>
  );
}
