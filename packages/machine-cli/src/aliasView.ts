import { existsSync } from 'node:fs';
import { aliasConflicts, type AliasConflict, type MachineEntry } from '@wadeck-app/machine-core';
import { readAdminPin } from './admin.js';
import { aliasesFile, readAliasesList } from './aliasesStore.js';
import { readAliases } from './state.js';

// What `machine alias list` shows (decision 116): the local aliases of this machine and the network aliases signed by the admin, each with its origin.

export interface AliasRow {
  alias: string;
  uuid: string;
  /** The name this machine knows the uuid by, absent when it does not know the machine. */
  name?: string;
}

export interface AliasOverview {
  local: AliasRow[];
  /** `shadowed`: a local alias of the same label points elsewhere and wins here. */
  network: Array<AliasRow & { shadowed: boolean }>;
  networkSerial?: number;
  networkSignedAt?: number;
  conflicts: AliasConflict[];
}

const short = (uuid: string): string => uuid.slice(0, 8);

export function aliasOverview(configDir: string, machines: readonly MachineEntry[]): AliasOverview {
  const nameOf = (uuid: string): { name?: string } => {
    const name = machines.find((m) => m.uuid === uuid)?.name;
    return name === undefined ? {} : { name };
  };
  const local = readAliases(configDir);
  const signed = existsSync(aliasesFile(configDir)) ? readAliasesList(configDir, readAdminPin(configDir).adminPublicKey) : undefined;
  const network = Object.fromEntries((signed?.body.entries ?? []).map((e) => [e.alias, e.uuid]));
  const conflicts = aliasConflicts(local, network);
  return {
    local: Object.entries(local).map(([alias, uuid]) => ({ alias, uuid, ...nameOf(uuid) })),
    network: (signed?.body.entries ?? []).map((e) => ({ alias: e.alias, uuid: e.uuid, ...nameOf(e.uuid), shadowed: conflicts.some((c) => c.alias === e.alias) })),
    ...(signed === undefined ? {} : { networkSerial: signed.body.serial, networkSignedAt: signed.body.issuedAt }),
    conflicts,
  };
}

const target = (row: AliasRow): string => (row.name === undefined ? row.uuid : `${row.name} (${row.uuid})`);

export function aliasListText(overview: AliasOverview): string {
  const lines = [
    ...overview.local.map((r) => `${r.alias} -> ${target(r)} (local)`),
    ...overview.network.map((r) => `${r.alias} -> ${target(r)} (network, list serial ${overview.networkSerial ?? '?'}${r.shadowed ? '; shadowed by a local alias' : ''})`),
  ];
  return lines.length === 0 ? 'no alias\n' : `${lines.join('\n')}\n`;
}

/** The loud message for a label that a local alias and a network alias point at different machines: the local one wins. */
export function conflictWarning(conflict: AliasConflict, nameOf: (uuid: string) => string): string {
  return `[warn] "${conflict.alias}" is a network alias of ${nameOf(conflict.network)} (${short(conflict.network)}) and a local alias of ${nameOf(conflict.local)} (${short(conflict.local)}): the local alias wins on this machine. Remove it (\`machine alias rm ${conflict.alias}\`) to follow the network alias`;
}
