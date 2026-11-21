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

/** Text input (same look as dsl-ui's Field* inputs). */
export const INPUT = 'rounded border border-border bg-surface px-2 py-1 text-sm text-content focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary disabled:opacity-50';

// @formatter:on
