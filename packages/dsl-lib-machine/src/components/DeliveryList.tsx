import React from 'react';
import { Badge, Collapsible } from '@wadeck-app/dsl-ui';
import type { DeliveryMachine, DeliveryState } from '../lib/approvalResult.js';
import { MONO_STYLE, TEXT_MUTED } from '../lib/styleTokens.js';

// What a dialog shows of a delivery of documents (admin-ui.md, "Result and progress UX"): one short line per machine (state, one reason, one next action) and the raw
// report of the CLI folded in "Details". Shared by the approval and the revocation, so both read the same.

const STATE_LABEL: Record<DeliveryState, string> = { delivered: 'Delivered', inbox: 'Waiting in the relay inbox', failed: 'Failed' };
const STATE_VARIANT = { delivered: 'success', inbox: 'info', failed: 'danger' } as const;

/** Commands are in backticks in the texts of the daemon: shown in the monospace font. */
function withCode(text: string): React.ReactNode[] {
  return text.split('`').map((part, i) => (i % 2 === 1 ? <code key={i} style={MONO_STYLE} className="break-all">{part}</code> : <React.Fragment key={i}>{part}</React.Fragment>));
}

export interface DeliveryListProps {
  machines: DeliveryMachine[];
  /** The raw report of the CLI, without the lines it repeats. */
  text: string;
  /** A failure opens the report: the cause is what the person needs to act. */
  openDetails: boolean;
}

export function DeliveryList({ machines, text, openDetails }: DeliveryListProps) {
  return (
    <>
      {machines.length > 0 && (
        <ul aria-label="Machines told" className="flex list-none flex-col gap-2 p-0 text-sm">
          {machines.map((m) => (
            <li key={m.uuid} className="flex flex-col gap-0.5">
              <span className="flex flex-wrap items-center gap-2">
                <Badge label={STATE_LABEL[m.state]} variant={STATE_VARIANT[m.state]} tone="subtle" size="sm" />
                <span style={MONO_STYLE}>{m.name}</span>
                <span className={TEXT_MUTED}>{m.reason}</span>
              </span>
              <span>{withCode(m.next)}</span>
            </li>
          ))}
        </ul>
      )}
      <Collapsible title="Details" defaultOpen={openDetails}>
        <pre style={MONO_STYLE} className="m-0 whitespace-pre-wrap break-words text-xs">{text}</pre>
      </Collapsible>
    </>
  );
}
