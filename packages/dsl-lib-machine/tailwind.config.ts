import type { Config } from 'tailwindcss';
// @ts-expect-error - plain JS preset shipped by dsl-ui, no type declarations
import dslUiPreset, { dslUiContent } from '@wadeck-app/dsl-ui/tailwind-preset';

/**
 * Tailwind config of the library's stylesheet (scripts/build-css.ts, which sets the content globs to absolute paths).
 * The preset owns the generic colour mapping and the dark-mode selector: nothing is restated here.
 */
export default {
  presets: [dslUiPreset],
  content: [
    './src/**/*.{ts,tsx}',
    // Required: Tailwind reads `content` from the top-level config only, so the preset cannot contribute scan paths.
    ...(dslUiContent as string[]),
  ],
  plugins: [],
} satisfies Config;
