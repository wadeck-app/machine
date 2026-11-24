import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { allowedLists, lastAcceptedUses, useKey, ACTIVITY_MAX_COUNT_LINES, type AllowedEntryView, type AllowedListView, type PolicyMode } from '@wadeck-app/machine-core';
import { reverseLines } from './activityLogs.js';
import { auditLogFile } from './requestsView.js';
import { FileUsageStore } from './stores.js';
import { recordedPolicy, REMOTE_VIEW_LINE } from './allowedView.js';
import { NotInitializedError } from './errors.js';
import { adminKeyFile } from './admin.js';
import { readMachine } from './identity.js';
import { loadNetwork } from './network.js';

// The `allowed` command of the daemon (the Allowed page of the module): the data of `machine allowed <machine>` for every machine, read-only.
// Same readers as the CLI: this machine reads its INSTALLED policy (and its call counters), another machine the last policy SIGNED HERE
// (the target never sends its list, T-03). Nothing is asked, sent, signed or written; no signature leaves this file.

/** An entry of the allow list; `lastUsedAt` (epoch seconds) only for the installed policy, and only when the audit log has an accepted use of it. */
export interface AllowedEntryUseView extends AllowedEntryView {
  lastUsedAt?: number;
}

export interface AllowedListUseView extends Omit<AllowedListView, 'entries'> {
  entries: AllowedEntryUseView[];
}

/** What the scan of the audit log of THIS machine read; absent on a policy signed here for another machine (its audit log is on that machine). */
export interface AllowedLastUse {
  scanned: number;
  damaged: number;
  /** False: the bound stopped the scan, an entry without a date was not used in the lines read, not necessarily never. */
  complete: boolean;
}

export interface AllowedMachineView {
  uuid: string;
  name: string;
  isSelf: boolean;
  /** `installed`: the policy in force on this machine. `signed-here`: what the admin signed on this machine, not necessarily installed on the target yet. */
  source: 'installed' | 'signed-here';
  /** Installed: who manages the list of this machine. Signed here: always the admin. */
  mode: PolicyMode;
  /** Null: nothing is known here (no policy installed, or none signed here). */
  policy: { version: number; issuedAt: number; lists: AllowedListUseView[] } | null;
  lastUse?: AllowedLastUse;
  /** A policy that could not be read, with its file and the fix. The machine has no list shown, never an empty one. */
  problem?: string;
  /** Signed here only: the line that says the target may differ (same wording as `machine allowed`). */
  remoteViewLine?: string;
  /** The command that adds an entry for this machine. */
  fillCommand: string;
  /** This machine can sign a change of this list (it holds the admin key and the list is the admin's): the page then offers delete and change of lifetime. */
  canEdit: boolean;
  /** Why not, with where to change it, when the list has entries and cannot be changed here; empty otherwise. */
  editNote: string;
}

/**
 * Whether THIS machine can sign a change of the list of a machine (the Allowed page offers actions only there). An installed list is the admin's only in
 * mode admin, and only the machine that holds the admin key signs it; a list signed here needs the admin key too. Never a silent "no": the note says why.
 */
export function editRights(input: { source: 'installed' | 'signed-here'; mode: PolicyMode; hasAdminKey: boolean; hasPolicy: boolean }): { canEdit: boolean; editNote: string } {
  if (!input.hasPolicy) {
    return { canEdit: false, editNote: '' };
  }
  if (input.source === 'installed' && input.mode === 'local') {
    return { canEdit: false, editNote: 'This machine manages its own list (policy mode local): no admin signature is used here. Change it from a terminal on this machine with `machine policy allow`; `machine policy delegate` gives the list back to the admin first.' };
  }
  if (!input.hasAdminKey) {
    return { canEdit: false, editNote: 'This machine does not hold the admin key (policy mode admin): only the admin machine signs this list. Change it from a terminal on the admin machine with `machine admin allow`.' };
  }
  return { canEdit: true, editNote: '' };
}

export type AllowedAnswer =
  | { initialized: false; message: string }
  | { initialized: true; ok: true; self: { uuid: string; name: string }; now: number; machines: AllowedMachineView[]; warnings: string[] };

export function allowedAnswer(configDir: string, nowSeconds: number): AllowedAnswer {
  let self;
  try {
    self = readMachine(configDir);
  } catch (e) {
    if (e instanceof NotInitializedError) {
      const { message } = e;
      return { initialized: false, message };
    }
    throw e;
  }
  const network = loadNetwork(configDir, nowSeconds);
  const everyone = [{ uuid: self.uuid, name: self.name }, ...network.directory.machines()];
  const nameOf = (uuid: string): string => everyone.find((m) => m.uuid === uuid)?.name ?? uuid;
  const warnings = [...network.problems];

  const hasAdminKey = existsSync(adminKeyFile(configDir));
  const machines = everyone.map((m): AllowedMachineView => {
    if (m.uuid === self.uuid) {
      const fillCommand = network.policyMode === 'local' ? 'machine policy allow -- <command>' : `machine admin allow ${m.name} -- <command>`;
      const body = network.policy;
      // The counters live on this machine: a limited entry shows the calls left. A counter file that cannot be read is said, never skipped.
      let counters: FileUsageStore | undefined;
      try {
        counters = new FileUsageStore(join(configDir, 'usage.json'));
      } catch (e) {
        warnings.push(`${(e as Error).message}; the calls left are not shown`);
      }
      const lists = body === undefined ? undefined : allowedLists(body, nameOf, nowSeconds, counters);
      // The audit log of this machine says when each installed entry was last accepted. An unreadable log is said, the page still shows the lists.
      let lastUse: AllowedLastUse | undefined;
      let shownLists: AllowedListUseView[] | undefined = lists;
      if (lists !== undefined) {
        const file = auditLogFile(configDir);
        try {
          const uses = lastAcceptedUses(existsSync(file) ? reverseLines(file, () => undefined) : [], lists, ACTIVITY_MAX_COUNT_LINES);
          lastUse = { scanned: uses.scanned, damaged: uses.damaged, complete: uses.complete };
          shownLists = lists.map((l) => ({ ...l, entries: l.entries.map((e) => { const at = uses.at.get(useKey(l, e.index)); return at === undefined ? e : { ...e, lastUsedAt: at }; }) }));
        } catch (e) {
          warnings.push(`${(e as Error).message}; the last use of the allowed commands is not shown`);
        }
      }
      return {
        uuid: m.uuid,
        name: m.name,
        isSelf: true,
        source: 'installed',
        mode: network.policyMode,
        policy: body === undefined || shownLists === undefined ? null : { version: body.version, issuedAt: body.issuedAt, lists: shownLists },
        ...(lastUse === undefined ? {} : { lastUse }),
        fillCommand,
        ...editRights({ source: 'installed', mode: network.policyMode, hasAdminKey, hasPolicy: body !== undefined && shownLists !== undefined }),
      };
    }
    const base = { uuid: m.uuid, name: m.name, isSelf: false, source: 'signed-here' as const, mode: 'admin' as const, fillCommand: `machine admin allow ${m.name} -- <command>` };
    const nothing = { canEdit: false, editNote: '' };
    try {
      const record = recordedPolicy(configDir, m.uuid);
      if (record === undefined) {
        return { ...base, policy: null, ...nothing };
      }
      const { body } = record;
      return { ...base, policy: { version: body.version, issuedAt: body.issuedAt, lists: allowedLists(body, nameOf, nowSeconds) }, remoteViewLine: REMOTE_VIEW_LINE(m.name), ...editRights({ source: 'signed-here', mode: 'admin', hasAdminKey, hasPolicy: true }) };
    } catch (e) {
      // A record that cannot be read names its file and the fix (readPolicyRecord): shown on its machine, never as "no policy".
      return { ...base, policy: null, problem: (e as Error).message, ...nothing };
    }
  });
  return { initialized: true, ok: true, self: { uuid: self.uuid, name: self.name }, now: nowSeconds, machines, warnings };
}
