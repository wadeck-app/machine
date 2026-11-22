import { join } from 'node:path';
import { allowedLists, type AllowedListView, type PolicyMode } from '@wadeck-app/machine-core';
import { FileUsageStore } from './stores.js';
import { recordedPolicy, REMOTE_VIEW_LINE } from './allowedView.js';
import { NotInitializedError } from './errors.js';
import { readMachine } from './identity.js';
import { loadNetwork } from './network.js';

// The `allowed` command of the daemon (the Allowed page of the module): the data of `machine allowed <machine>` for every machine, read-only.
// Same readers as the CLI: this machine reads its INSTALLED policy (and its call counters), another machine the last policy SIGNED HERE
// (the target never sends its list, T-03). Nothing is asked, sent, signed or written; no signature leaves this file.

export interface AllowedMachineView {
  uuid: string;
  name: string;
  isSelf: boolean;
  /** `installed`: the policy in force on this machine. `signed-here`: what the admin signed on this machine, not necessarily installed on the target yet. */
  source: 'installed' | 'signed-here';
  /** Installed: who manages the list of this machine. Signed here: always the admin. */
  mode: PolicyMode;
  /** Null: nothing is known here (no policy installed, or none signed here). */
  policy: { version: number; issuedAt: number; lists: AllowedListView[] } | null;
  /** A policy that could not be read, with its file and the fix. The machine has no list shown, never an empty one. */
  problem?: string;
  /** Signed here only: the line that says the target may differ (same wording as `machine allowed`). */
  remoteViewLine?: string;
  /** The command that adds an entry for this machine. */
  fillCommand: string;
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
      return {
        uuid: m.uuid,
        name: m.name,
        isSelf: true,
        source: 'installed',
        mode: network.policyMode,
        policy: body === undefined ? null : { version: body.version, issuedAt: body.issuedAt, lists: allowedLists(body, nameOf, nowSeconds, counters) },
        fillCommand,
      };
    }
    const base = { uuid: m.uuid, name: m.name, isSelf: false, source: 'signed-here' as const, mode: 'admin' as const, fillCommand: `machine admin allow ${m.name} -- <command>` };
    try {
      const record = recordedPolicy(configDir, m.uuid);
      if (record === undefined) {
        return { ...base, policy: null };
      }
      const { body } = record;
      return { ...base, policy: { version: body.version, issuedAt: body.issuedAt, lists: allowedLists(body, nameOf, nowSeconds) }, remoteViewLine: REMOTE_VIEW_LINE(m.name) };
    } catch (e) {
      // A record that cannot be read names its file and the fix (readPolicyRecord): shown on its machine, never as "no policy".
      return { ...base, policy: null, problem: (e as Error).message };
    }
  });
  return { initialized: true, ok: true, self: { uuid: self.uuid, name: self.name }, now: nowSeconds, machines, warnings };
}
