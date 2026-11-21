import React, { useId, useState } from 'react';
import { Info } from 'lucide-react';
import { POPOVER_SURFACE } from '../lib/styleTokens.js';

// The "i" button and its explanation. dsl-ui's Tooltip cannot be used here: it is hover-only, centred ABOVE its trigger (it covered the page title), and
// paints a hardcoded navy (#111827) that ignores the theme and the palette. This one opens on hover AND on keyboard focus, to the RIGHT of the button
// (never over what is above), uses the same surface as dsl-ui's Popover, stays open while the pointer is on it (WCAG 1.4.13) and closes with Escape.

export interface InfoTipProps {
  /** Accessible name of the button, e.g. "About: Details checked". */
  label: string;
  /** The explanation: the accessible description of the button and the content of the bubble. */
  text: string;
}

// @formatter:off
const WRAPPER = 'relative inline-flex';
// The ring is `primary` (the accent) and not `border`: the border token is a hairline on purpose and its ring was 1.25:1 against the page.
const BUTTON = 'inline-flex h-5 w-5 items-center justify-center rounded-full text-muted transition-colors hover:text-content focus:outline-none focus-visible:ring-2 focus-visible:ring-primary';
// pl-2 is inside the hover area, so moving the pointer from the button to the bubble does not close it.
// top-0: the bubble starts at the top of the button and grows DOWN, so a long text never reaches the title or the text above the first step.
const BUBBLE_POSITION = 'absolute left-full top-0 z-50 pl-2';
const BUBBLE_HIDDEN = 'invisible opacity-0';
const BUBBLE_SHOWN = 'visible opacity-100';
const BUBBLE_BOX = `w-max max-w-xs px-3 py-2 text-left text-sm font-normal leading-snug ${POPOVER_SURFACE}`;
// @formatter:on

export function InfoTip({ label, text }: InfoTipProps) {
  const id = useId();
  const [open, setOpen] = useState(false);
  return (
    <span
      className={WRAPPER}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      onFocus={() => setOpen(true)}
      onBlur={() => setOpen(false)}
      onKeyDown={e => {
        if (e.key === 'Escape') {
          setOpen(false);
        }
      }}
    >
      {/* violations-suppress: react/no-raw-button dsl-ui's Button has no variant whose focus ring is visible on the page (ghost and chip use ring-border, 1.25:1) and none without a padding box; this 20px icon trigger needs the primary ring */}
      <button type="button" aria-label={label} aria-describedby={id} className={BUTTON}>
        <Info size={14} aria-hidden="true" />
      </button>
      <span id={id} role="tooltip" data-open={open} className={`${BUBBLE_POSITION} ${open ? BUBBLE_SHOWN : BUBBLE_HIDDEN}`}>
        <span className={`block ${BUBBLE_BOX}`}>{text}</span>
      </span>
    </span>
  );
}
