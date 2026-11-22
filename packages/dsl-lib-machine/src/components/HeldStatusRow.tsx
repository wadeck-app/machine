import React from 'react';
import { IconButton } from '@wadeck-app/dsl-ui';
import { ChevronDown, ChevronUp } from 'lucide-react';
import { askRisk, choiceFromAsk } from '../lib/callerAsk.js';
import { cardStatus, readOnlyVerdict } from '../lib/quickAllow.js';
import { OUTCOME_NEUTRAL, OUTCOME_WARNING, TEXT_MUTED } from '../lib/styleTokens.js';
import { InfoTip } from './InfoTip.js';
import type { HeldRequestRow } from './HeldRequests.js';

// The ONE status line of a held card (what is not the command): badges that flag what must be seen before the click, one short grey line, the Details toggle.
// Every fact and every long sentence lives in HeldDetails.

export interface HeldStatusRowProps {
  row: HeldRequestRow;
  /** What is flagged by the lifetime chosen in the select (the ask of the caller has its own badge). */
  choiceFlags: string[];
  open: boolean;
  panelId: string;
  onToggle: () => void;
}

export function HeldStatusRow({ row, choiceFlags, open, panelId, onToggle }: HeldStatusRowProps) {
  const readOnly = readOnlyVerdict(row);
  // The chip says Permanent only when nothing else decides the starting lifetime (the caller's ask for a lifetime, a renewal).
  const startedHere = readOnly.readOnly && row.renewal === undefined && (row.ask === undefined || choiceFromAsk(row.ask) === undefined);
  const callerRisk = row.ask !== undefined ? askRisk(row.ask) : undefined;
  const status = cardStatus({ shell: row.shell, ...(row.renewal !== undefined ? { renewal: row.renewal } : {}), ...(row.ask !== undefined ? { ask: row.ask } : {}), isNotice: row.note !== undefined, ...(row.commandTruncated === true ? { commandTruncated: true } : {}) });
  return (
    <div className="flex min-w-0 items-center gap-1.5 text-xs">
      {row.renewal !== undefined && <span data-testid="renewal-badge" className={OUTCOME_WARNING}>Renewal</span>}
      {callerRisk !== undefined && <span data-testid="caller-ask-warning" role="note" className={OUTCOME_WARNING}>Caller asks: {callerRisk}</span>}
      {/* The choice that is the caller's own ask is already flagged by its badge: only a DIFFERENT flagged choice is added. */}
      {choiceFlags.filter((f) => f !== callerRisk).map((f) => (
        <span key={f} data-testid="choice-warning" role="note" className={OUTCOME_WARNING}>Chosen: {f}</span>
      ))}
      {/* Neutral on purpose: it informs, it never warns. The rule that matched is in the tooltip so the owner sees WHY; the select below can still be changed. */}
      {readOnly.readOnly && (
        <span className="inline-flex shrink-0 items-center gap-0.5">
          <span data-testid="read-only-chip" className={OUTCOME_NEUTRAL}>
            read-only (recognised){startedHere ? ': permanent by default' : ''}
          </span>
          <InfoTip label="About: read-only (recognised)" text={`${readOnly.why}${startedHere ? ' Allow starts from Permanent for it; you can pick anything else, and nothing is signed until you click.' : " The caller's own ask or the entry being renewed decides the starting lifetime instead."}`} />
        </span>
      )}
      {status !== '' && <span data-testid="held-status" className={`min-w-0 truncate ${TEXT_MUTED}`} title={status}>{status}</span>}
      <span className="ml-auto shrink-0">
        <IconButton icon={open ? <ChevronUp size={14} aria-hidden="true" /> : <ChevronDown size={14} aria-hidden="true" />} aria-label="Details" aria-expanded={open} aria-controls={panelId} size="icon-xs" onClick={onToggle} />
      </span>
    </div>
  );
}
