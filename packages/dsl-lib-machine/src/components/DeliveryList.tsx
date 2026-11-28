import React from 'react';
import { Badge, Collapsible, Text } from '@wadeck-app/dsl-ui';
import type { DeliveryMachine, DeliveryState } from '../lib/approvalResult.js';
import { MONO_STYLE } from '../lib/styleTokens.js';
import { CodeText } from './CommandNotice.js';

// What a dialog shows of a delivery of documents (admin-ui.md, "Result and progress UX"): one short line per machine (state, one reason, one next action) and the raw
// report of the CLI folded in "Details". Shared by the approval and the revocation, so both read the same.

const STATE_LABEL: Record<DeliveryState, string> = { delivered: 'Delivered', inbox: 'Waiting in the relay inbox', failed: 'Failed' };
const STATE_VARIANT = { delivered: 'success', inbox: 'info', failed: 'danger' } as const;

/** What the daemon says when there is nothing to do: not a line of its own. */
const NOTHING_TO_DO = /^nothing to do.?$/i;

/** A next action is a line only when it says something: not the bare "nothing to do", not a command the headline already gave. */
function shownNext(next: string, said: string | undefined): boolean {
  return !NOTHING_TO_DO.test(next.trim()) && !(said !== undefined && said !== '' && next.includes(said));
}

export interface DeliveryListProps {
  machines: DeliveryMachine[];
  /** The raw report of the CLI, without the lines it repeats. */
  text: string;
  /** A failure opens the report: the cause is what the person needs to act. */
  openDetails: boolean;
  /** A command the result already says above (the retry command of its headline): a next action that holds it is not repeated on every machine. */
  said?: string;
}

export function DeliveryList({ machines, text, openDetails, said }: DeliveryListProps) {
  return (
    <>
      {machines.length > 0 && (
        <ul aria-label="Machines told" className="flex list-none flex-col gap-2 p-0 text-sm">
          {machines.map((m) => (
            <li key={m.uuid} className="flex flex-col gap-0.5">
              <span className="flex flex-wrap items-center gap-2">
                <Badge label={STATE_LABEL[m.state]} variant={STATE_VARIANT[m.state]} tone="subtle" size="sm" />
                <Text mono text={m.name} />
                <Text tone="muted" text={m.reason} />
              </span>
              {shownNext(m.next, said) && (
                <span>
                  <CodeText text={m.next} />
                </span>
              )}
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
