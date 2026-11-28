// What this module still styles ITSELF, because dsl-ui has no standard component for it. Everything else is a standard dsl-ui component (Notice, Badge, Card,
// Progress, Dialog, DataTable, IconButton ...): see .claude/specs/2026-11-13_machine-network/admin-ui.md, "Custom styles audit". EVERY colour here is a semantic token of
// the app (dsl-ui theme.css, mapped by its Tailwind preset): never a Tailwind palette class and never a hex value. Tailwind scans this file (src/**/*.ts).
//
// Each token below is a request to dsl-owner: when dsl-ui offers the component, the token goes.

import type { CSSProperties } from 'react';

// @formatter:off

/**
 * The monospace stack of the module for the LARGE or spaced monospace texts (the security code, a held command): the Text atom of dsl-ui draws the
 * inline monospace of running text (machine names, commands, shells) but has no size above sm, no weight and no letter spacing. The theme of the app defines NO monospace family (dsl-ui's preset only defines `sans: Inter`, so Tailwind's `font-mono` is a
 * generic stack that differs from one shell stylesheet to the other): this is the ONE token, applied with `style={MONO_STYLE}` (never with the class `font-mono`).
 */
export const MONO_FONT_STACK = "'JetBrains Mono', 'Cascadia Mono', 'SF Mono', Consolas, 'Liberation Mono', ui-monospace, monospace";
export const MONO_STYLE: CSSProperties = { fontFamily: MONO_FONT_STACK };

/** The command of a held or expired request, the largest text of its card: no standard text component with a size and a monospace font. */
export const HELD_COMMAND = 'break-all text-lg font-semibold text-content';

// @formatter:on
