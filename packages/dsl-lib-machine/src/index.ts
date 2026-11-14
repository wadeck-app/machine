import { createRegistry } from '@wadeck-app/dsl-renderer';
import type { ComponentRegistryEntry } from '@wadeck-app/dsl-renderer';
import { FinalCodeDisplayEntry, PassphraseSignerEntry, VerticalTimelineEntry } from './generated/entries.js';

export { FinalCodeDisplay } from './components/FinalCodeDisplay.js';
export type { FinalCodeDisplayProps } from './components/FinalCodeDisplay.js';
export { PassphraseSigner } from './components/PassphraseSigner.js';
export type { PassphraseSignerProps } from './components/PassphraseSigner.js';
export { VerticalTimeline } from './components/VerticalTimeline.js';
export type { TimelineStatus, TimelineStep, VerticalTimelineProps } from './components/VerticalTimeline.js';

/**
 * The registry entries the library ships. The names are the types the views use, prefixed by the host with the module id
 * (`machine:VerticalTimeline`).
 */
export function createMachineLibEntries(): ComponentRegistryEntry[] {
  return Object.values(createRegistry([FinalCodeDisplayEntry, PassphraseSignerEntry, VerticalTimelineEntry]));
}
