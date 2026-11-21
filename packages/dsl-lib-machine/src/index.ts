import { createRegistry } from '@wadeck-app/dsl-renderer';
import type { ComponentRegistryEntry } from '@wadeck-app/dsl-renderer';
import { ActivityLogEntry, AllowRequestsTableEntry, FinalCodeDisplayEntry, HeldRequestsEntry, PassphraseSignerEntry, RequestsOverviewEntry, VerticalTimelineEntry } from './generated/entries.js';

export { ActivityLog } from './components/ActivityLog.js'; // run-log
export type { ActivityLogProps, ActivityPageData, ActivityRowData } from './components/ActivityLog.js'; // run-log
export { AllowRequestsTable } from './components/AllowRequestsTable.js';
export type { AllowRequestsTableProps, PendingRequestRow } from './components/AllowRequestsTable.js';
export { ConfirmSignModal } from './components/ConfirmSignModal.js';
export type { ConfirmSignModalProps } from './components/ConfirmSignModal.js';

export { FinalCodeDisplay } from './components/FinalCodeDisplay.js';
export type { FinalCodeDisplayProps } from './components/FinalCodeDisplay.js';
export { HeldRequests } from './components/HeldRequests.js';
export type { HeldRequestRow, HeldRequestsProps } from './components/HeldRequests.js';
export { PassphraseSigner } from './components/PassphraseSigner.js';
export type { PassphraseSignerProps } from './components/PassphraseSigner.js';
export { RequestsOverview } from './components/RequestsOverview.js';
export type { RequestsOverviewProps } from './components/RequestsOverview.js';
export { VerticalTimeline } from './components/VerticalTimeline.js';
export type { TimelineStatus, TimelineStep, VerticalTimelineProps } from './components/VerticalTimeline.js';

/**
 * The registry entries the library ships. The names are the types the views use, prefixed by the host with the module id
 * (`machine:VerticalTimeline`).
 */
export function createMachineLibEntries(): ComponentRegistryEntry[] {
  return Object.values(createRegistry([ActivityLogEntry, AllowRequestsTableEntry, FinalCodeDisplayEntry, HeldRequestsEntry, PassphraseSignerEntry, RequestsOverviewEntry, VerticalTimelineEntry]));
}
