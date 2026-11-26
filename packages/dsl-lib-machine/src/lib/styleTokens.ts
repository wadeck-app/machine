// Class names shared by the components of this library. EVERY colour is a semantic token of the app (dsl-ui theme.css, mapped by its Tailwind
// preset): never a Tailwind palette class (a hue name and a shade number) and never a hex value. The tokens follow the theme (light, dark) and the
// palette the person picked in the shell, so these components look like the rest of the app. Tailwind scans this file (src/**/*.ts).

import type { CSSProperties } from 'react';

// @formatter:off

/**
 * The monospace stack of the module, for machine names, commands and shells. The theme of the app defines NO monospace family (dsl-ui's preset only defines
 * `sans: Inter`, so Tailwind's `font-mono` is a generic stack that differs from one shell stylesheet to the other): this is the ONE token, applied with
 * `style={MONO_STYLE}` (never with the class `font-mono`). A real family first, the generic ones as the fallback.
 */
export const MONO_FONT_STACK = "'JetBrains Mono', 'Cascadia Mono', 'SF Mono', Consolas, 'Liberation Mono', ui-monospace, monospace";
export const MONO_STYLE: CSSProperties = { fontFamily: MONO_FONT_STACK };

/** Floating panel (tooltip, popover): the same surface as dsl-ui's Popover. */
export const POPOVER_SURFACE = 'rounded-lg border border-border bg-surface text-content shadow-lg';

/** Modal backdrop and panel: the same as dsl-ui's Dialog. */
export const MODAL_BACKDROP = 'fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4';
export const MODAL_PANEL = `flex w-full max-w-xl flex-col gap-3 p-5 ${POPOVER_SURFACE} shadow-xl`;

/** Boxed messages: success, caution, neutral. Same pairs as dsl-ui's Badge. */
export const NOTICE_SUCCESS = 'rounded border border-success bg-success-bg p-2 text-sm text-success-text';
export const NOTICE_WARNING = 'rounded border border-warning bg-warning-bg p-2 text-sm text-warning-text';
export const NOTICE_NEUTRAL = 'rounded border border-border p-2 text-sm text-muted';

/** Inline error under a form. */
export const TEXT_ERROR = 'text-sm text-danger-text';

export const TEXT_MUTED = 'text-muted';
export const TEXT_MUTED_SM = 'text-sm text-muted';

/** Table of the Requests page. */
export const TABLE_HEAD_ROW = 'border-b border-border text-muted';
export const TABLE_BODY_ROW = 'border-b border-border align-top';

/** A body row whose cells are all centred vertically (the Allow table: one-line cells and the button sit on the middle of a two-line row). */
export const TABLE_ROW_MIDDLE = 'border-b border-border align-middle';


/** A held request (a caller waits for the answer): a card that stands out from the table below it. */
export const HELD_ITEM = 'flex flex-col gap-1.5 rounded-lg border border-warning bg-warning-bg px-3 py-2 text-warning-text';

/** The command of a held request: it is what the owner reads before answering, so it is the largest text of the card. */
export const HELD_COMMAND = 'break-all text-lg font-semibold text-content';

/** The countdown of a held request, and the same in red when it is nearly over. */
export const HELD_COUNTDOWN = 'whitespace-nowrap text-sm font-medium tabular-nums';
export const HELD_COUNTDOWN_URGENT = 'whitespace-nowrap text-sm font-semibold tabular-nums text-danger-text';


/** The passphrase hint above the passphrase field: larger than the surrounding text, on its own line (it is what the person needs to read first). */
export const PASSPHRASE_HINT = 'rounded border border-border bg-surface p-2 text-base text-content';
export const PASSPHRASE_HINT_LABEL = 'font-semibold text-muted';

/** Activity page (run-log): the outcome of a command, one pair of tokens per tone (same pairs as dsl-ui's Badge). */
export const OUTCOME_SUCCESS = 'inline-block whitespace-nowrap rounded border border-success bg-success-bg px-2 py-0.5 text-xs text-success-text';
export const OUTCOME_WARNING = 'inline-block whitespace-nowrap rounded border border-warning bg-warning-bg px-2 py-0.5 text-xs text-warning-text';
export const OUTCOME_DANGER = 'inline-block whitespace-nowrap rounded border border-danger bg-danger-bg px-2 py-0.5 text-xs text-danger-text';
export const OUTCOME_NEUTRAL = 'inline-block whitespace-nowrap rounded border border-border px-2 py-0.5 text-xs text-muted';

/** The unlocked-key pill of the Requests page: fixed at the top right on the row of the page title (the h1 of app-core starts 113 px below the top of the viewport, measured on the real page at 1500 and 1100 px), so it takes no room in the flow. */
export const KEY_PILL = 'fixed right-4 top-[116px] z-30 inline-flex items-center gap-2 whitespace-nowrap rounded-full border border-border bg-surface px-3 py-1 text-xs text-muted shadow-sm';

/** Activity page (activity-paging): the exit code cell, green for 0, red for any other code, a timeout or a kill, muted when no command ran. */
export const EXIT_OK = 'whitespace-nowrap font-medium tabular-nums text-success-text';
export const EXIT_FAIL = 'whitespace-nowrap font-medium tabular-nums text-danger-text';
export const EXIT_NONE = 'whitespace-nowrap text-muted';

/** Activity page: the command column. */
export const COMMAND_TEXT = 'break-all text-sm text-content';

// @formatter:on

/** Progress after an Allow (decision 86): one text colour per state of a step. Theme tokens only. */
export const STEP_DONE = 'text-success-text';
export const STEP_ACTIVE = 'font-medium text-content';
export const STEP_PENDING = 'text-muted';
export const STEP_FAILED = 'text-danger-text';

/** The thin stepper of a request (4 segments, one word each): a segment per state, and the row it sits in (compact, slim once finished). */
export const STEPPER_SEGMENT = 'h-1 w-full rounded';
export const SEGMENT_DONE = 'bg-primary';
export const SEGMENT_ACTIVE = 'bg-primary opacity-50';
export const SEGMENT_PENDING = 'bg-border';
export const SEGMENT_FAILED = 'bg-danger';
/** The card of a request that is only a progress display: one line and the stepper (px-3 py-2: the `sm` padding of the dsl-ui Card, tighter vertically). */
export const PROGRESS_CARD_ACTIVE = 'flex flex-col gap-1 rounded-lg border border-border bg-surface px-3 py-2 text-content';
export const PROGRESS_CARD_SUCCESS = 'flex flex-col gap-1 rounded-lg border border-success bg-success-bg px-3 py-2 text-content';
export const PROGRESS_CARD_DANGER = 'flex flex-col gap-1 rounded-lg border border-danger bg-danger-bg px-3 py-2 text-content';
/** The same, finished and collapsed: one line of about 34 px. */
export const PROGRESS_SLIM_SUCCESS = 'flex flex-col gap-1 rounded-lg border border-success bg-success-bg px-3 py-0.5 text-content';
