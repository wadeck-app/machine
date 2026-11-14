import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Where things are. Kept apart from the scripts because those import build tools that cannot load in the jsdom environment. */
export const PACKAGE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const PACKAGES_DIR = path.resolve(PACKAGE_DIR, '..');
export const MODULE_DIR = path.join(PACKAGES_DIR, 'app-module-machine');
export const SRC_DIR = path.join(PACKAGE_DIR, 'src');
export const COMPONENTS_DIR = path.join(SRC_DIR, 'components');
/** Entries generated from dsl-ui and src/components by scripts/generate-entries.ts (committed, like any generated source). */
export const LIB_ENTRIES = path.join(SRC_DIR, 'generated', 'entries.tsx');
/** Stylesheet source: what dsl-ui does not own. */
export const LIB_CSS = path.join(SRC_DIR, 'styles', 'machine.css');
export const MODULE_VIEWS_DIR = path.join(MODULE_DIR, 'src', 'dsl-views');
/** Where `app-core-cli package` looks for the stylesheet it copies as built. */
export const MODULE_STYLE_CSS = path.join(MODULE_DIR, 'src', 'dsl-components', 'style.css');
