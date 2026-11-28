import React, { useRef, useState } from 'react';
import { Badge, ButtonAction, Collapsible, HorizontalStack, Notice, Text, VerticalStack } from '@wadeck-app/dsl-ui';
import type { DeliveryMachine, DeliveryState } from '../lib/approvalResult.js';
import { MONO_STYLE } from '../lib/styleTokens.js';
import { CodeText } from './CommandNotice.js';

// What a dialog shows of a delivery of documents (admin-ui.md, "Result and progress UX"): one short line per machine (state, one reason, one next action), "Retry delivery"
// when the delivery can be sent again without the passphrase, the raw report of the CLI folded in "Details", and the terminal command folded as the last resort (with
// Copy). The command is said ONCE (UX review 4: it was in the headline, in each machine line and again in the open details). Shared by the approval and the revocation.

const STATE_LABEL: Record<DeliveryState, string> = { delivered: 'Delivered', inbox: 'Waiting in the relay inbox', failed: 'Failed' };
const STATE_VARIANT = { delivered: 'success', inbox: 'info', failed: 'danger' } as const;

/** What the daemon says when there is nothing to do: not a line of its own. */
const NOTHING_TO_DO = /^nothing to do.?$/i;

/**
 * What replaces the command in the raw report: it is given once, in the folded terminal section. With a Retry delivery button the report sends the person to it FIRST
 * (the terminal is for when the daemon holds nothing to send again), so the two never contradict each other (UX review 5).
 */
const SAID_BELOW = 'the terminal command (under "Run it in a terminal instead")';
const SAID_BELOW_WITH_RETRY = 'Retry delivery (or, only if Retry delivery says nothing is kept, the terminal command under "Run it in a terminal instead")';

/** A next action is a line only when it says something: not the bare "nothing to do", not a command the headline already gave. */
function shownNext(next: string, said: string | undefined): boolean {
  return !NOTHING_TO_DO.test(next.trim()) && !(said !== undefined && said !== '' && next.includes(said));
}

/** The raw report without the command (it is in the folded terminal section): every mention, with or without its backticks, points there. */
function withoutCommand(text: string, command: string | undefined, saidBelow: string): string {
  if (command === undefined || command === '') {
    return text;
  }
  return text.split(`\`${command}\``).join(saidBelow).split(command).join(saidBelow);
}

export interface DeliveryListProps {
  machines: DeliveryMachine[];
  /** The raw report of the CLI, without the lines it repeats. It is always folded (UX review 5): the machine lines and the buttons come first, the report is there to read when they are not enough. */
  text: string;
  /** A command the result already says above (the retry command of its headline): a next action that holds it is not repeated on every machine. */
  said?: string;
  /** The terminal command that finishes the job (asks the admin passphrase): folded under "Run it in a terminal instead", with Copy. Absent: nothing to finish. */
  retryCommand?: string;
  /** One clause that explains the command when it looks odd (`machine admin rename box box`: the same name twice): shown with it, in the folded section. */
  retryNote?: string;
  /**
   * Sends the delivery again without the passphrase (the dialog then shows the new report). Resolves when the new report is shown; rejects with the sentence of whoever
   * refused, shown here as an alert. Absent: no button (delivered, or nothing can be retried).
   */
  onRetry?: () => Promise<void>;
}

const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export function DeliveryList({ machines, text, said, retryCommand, retryNote, onRetry }: DeliveryListProps) {
  const [retrying, setRetrying] = useState(false);
  const [problem, setProblem] = useState<string | undefined>(undefined);
  const [copyNote, setCopyNote] = useState<{ ok: boolean; text: string } | undefined>(undefined);
  // A second click while the first retry runs must not send twice (the button is disabled, this covers the render before it).
  const running = useRef(false);

  const retry = async (): Promise<void> => {
    if (onRetry === undefined || running.current) {
      return;
    }
    running.current = true;
    setRetrying(true);
    setProblem(undefined);
    try {
      await onRetry();
    } catch (e) {
      setProblem(errorText(e));
    } finally {
      running.current = false;
      setRetrying(false);
    }
  };

  const copy = async (command: string): Promise<void> => {
    try {
      if (navigator.clipboard === undefined) {
        throw new Error('this browser gives the page no clipboard');
      }
      await navigator.clipboard.writeText(command);
      setCopyNote({ ok: true, text: 'Command copied.' });
    } catch (e) {
      setCopyNote({ ok: false, text: `Could not copy (${errorText(e)}): select the command and copy it by hand.` });
    }
  };

  return (
    <VerticalStack gap="gap-2">
      {machines.length > 0 && (
        <ul aria-label="Machines told" className="flex list-none flex-col gap-2 p-0 text-sm">
          {machines.map((m) => (
            <li key={m.uuid} className="flex flex-col gap-0.5">
              <span className="flex flex-wrap items-center gap-2">
                <Badge label={STATE_LABEL[m.state]} variant={STATE_VARIANT[m.state]} tone="subtle" size="sm" />
                <Text mono text={m.name} />
                <Text tone="muted" text={m.reason} />
              </span>
              {shownNext(m.next, said ?? retryCommand) && (
                <span>
                  <CodeText text={m.next} />
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
      {onRetry !== undefined && (
        <HorizontalStack gap="gap-2" align="items-center" wrap>
          <ButtonAction label="Retry delivery" variant="primary" size="sm" loading={retrying} disabled={retrying} onClick={() => void retry()} />
          <Text tone="muted" size="sm" text="Sends the documents again. No passphrase needed: nothing is signed again." />
        </HorizontalStack>
      )}
      {problem !== undefined && <Notice variant="danger" label={problem} />}
      <Collapsible title="Details">
        <pre style={MONO_STYLE} className="m-0 whitespace-pre-wrap break-words text-xs">{withoutCommand(text, retryCommand, onRetry === undefined ? SAID_BELOW : SAID_BELOW_WITH_RETRY)}</pre>
      </Collapsible>
      {retryCommand !== undefined && retryCommand !== '' && (
        <Collapsible title="Run it in a terminal instead">
          <VerticalStack gap="gap-2">
            <Text
              size="sm"
              text={
                onRetry === undefined
                  ? 'On this machine, in a terminal (it asks the admin passphrase; safe to run again):'
                  : 'Only when Retry delivery says the daemon holds nothing to send again (it restarted since): on this machine, in a terminal (it asks the admin passphrase; safe to run again):'
              }
            />
            {/* `break-words`: the command breaks only when it is longer than the line (a long uuid), never because it could. */}
            <div className="break-words">
              <Text mono size="sm" text={retryCommand} />
            </div>
            {retryNote !== undefined && retryNote !== '' && (
              <p className="m-0 text-sm text-muted">
                <CodeText text={retryNote} />
              </p>
            )}
            <HorizontalStack gap="gap-2" align="items-center" wrap>
              <ButtonAction label="Copy command" variant="neutral" size="xs" onClick={() => void copy(retryCommand)} />
              {copyNote !== undefined && <Text tone={copyNote.ok ? 'success' : 'danger'} size="sm" text={copyNote.text} />}
            </HorizontalStack>
          </VerticalStack>
        </Collapsible>
      )}
    </VerticalStack>
  );
}
