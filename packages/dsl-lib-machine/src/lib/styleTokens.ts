// Class names shared by the components of this library. EVERY colour is a semantic token of the app (dsl-ui theme.css, mapped by its Tailwind
// preset): never a Tailwind palette class (a hue name and a shade number) and never a hex value. The tokens follow the theme (light, dark) and the
// palette the person picked in the shell, so these components look like the rest of the app. Tailwind scans this file (src/**/*.ts).

// @formatter:off

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

/** The Allow button of a table row: dsl-ui's primary solid fill (same pair as its Badge) with a visible keyboard focus ring. */
export const ALLOW_BUTTON = 'inline-flex items-center rounded bg-primary px-3 py-1 text-xs font-medium text-on-solid transition-colors hover:opacity-90 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-1';

/** A held request (a caller waits for the answer): a card that stands out from the table below it. */
export const HELD_ITEM = 'flex flex-col gap-2 rounded-lg border border-warning bg-warning-bg p-3 text-warning-text';

/** The command of a held request: it is what the owner reads before answering, so it is the largest text of the card. */
export const HELD_COMMAND = 'break-all font-mono text-lg font-semibold text-content';

/** The countdown of a held request, and the same in red when it is nearly over. */
export const HELD_COUNTDOWN = 'whitespace-nowrap text-sm font-medium tabular-nums';
export const HELD_COUNTDOWN_URGENT = 'whitespace-nowrap text-sm font-semibold tabular-nums text-danger-text';

/** The Deny button of a held request: dsl-ui's danger outline (same pair as its Badge) with a visible keyboard focus ring. */
export const DENY_BUTTON = 'inline-flex items-center rounded border border-danger bg-surface px-3 py-1 text-xs font-medium text-danger-text transition-colors hover:bg-danger-bg focus:outline-none focus-visible:ring-2 focus-visible:ring-danger focus-visible:ring-offset-1';

/** The passphrase hint above the passphrase field: larger than the surrounding text, on its own line (it is what the person needs to read first). */
export const PASSPHRASE_HINT = 'rounded border border-border bg-surface p-2 text-base text-content';
export const PASSPHRASE_HINT_LABEL = 'font-semibold text-muted';

/** Text input (same look as dsl-ui's Field* inputs). */
export const INPUT = 'rounded border border-border bg-surface px-2 py-1 text-sm text-content focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary disabled:opacity-50';

/** Activity page (run-log): the outcome of a command, one pair of tokens per tone (same pairs as dsl-ui's Badge). */
export const OUTCOME_SUCCESS = 'inline-block whitespace-nowrap rounded border border-success bg-success-bg px-2 py-0.5 text-xs text-success-text';
export const OUTCOME_WARNING = 'inline-block whitespace-nowrap rounded border border-warning bg-warning-bg px-2 py-0.5 text-xs text-warning-text';
export const OUTCOME_DANGER = 'inline-block whitespace-nowrap rounded border border-danger bg-danger-bg px-2 py-0.5 text-xs text-danger-text';
export const OUTCOME_NEUTRAL = 'inline-block whitespace-nowrap rounded border border-border px-2 py-0.5 text-xs text-muted';

/** Activity page: the command column and the pager buttons. */
export const COMMAND_TEXT = 'break-all font-mono text-sm text-content';
export const PAGE_BUTTON = 'inline-flex items-center rounded border border-border bg-surface px-3 py-1 text-xs font-medium text-content transition-colors hover:opacity-90 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-1 disabled:opacity-40';

// @formatter:on

/** Progress after an Allow (decision 86): the track and the fill of the bar, and one text colour per state of a step. Theme tokens only. */
export const PROGRESS_TRACK = 'h-2 w-full overflow-hidden rounded bg-border';
export const PROGRESS_FILL = 'h-2 rounded bg-primary transition-all';
export const PROGRESS_FILL_FAILED = 'h-2 rounded bg-danger transition-all';
export const STEP_DONE = 'text-success-text';
export const STEP_ACTIVE = 'font-medium text-content';
export const STEP_PENDING = 'text-muted';
export const STEP_FAILED = 'text-danger-text';
