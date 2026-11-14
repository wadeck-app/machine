import { resolveMachineRef, type MachineEntry, type Resolution } from '@wadeck-app/machine-core';
import { readMachine, type MachineIdentity } from './identity.js';
import { AliasConflictError, NoSuchAliasError, NotInitializedError } from './errors.js';
import { readAliases, removeAlias, setAlias } from './state.js';

// The daemon commands. Each is a plain function of the config directory, so the CLI runs the very same code in-process
// when no daemon is running and the tests need no network.

export interface NotInitialized {
  initialized: false;
  message: string;
}

export interface StatusAnswer {
  initialized: true;
  uuid: string;
  name: string;
  version: string;
  enrolled: boolean;
  peers: number;
  configDir: string;
  note?: string;
}

export interface ListAnswer {
  initialized: true;
  self: MachineEntry;
  peers: Array<MachineEntry & { aliases: string[] }>;
  enrolled: boolean;
  note?: string;
}

export type ResolveAnswer = (Resolution & { name?: string }) | NotInitialized;
export type AliasAnswer = { ok: true; alias: string; uuid: string; previous?: string } | Exclude<Resolution, { ok: true }> | { ok: false; reason: 'conflict' | 'missing'; message: string } | NotInitialized;

const NOT_ENROLLED_NOTE = 'not enrolled: no admin key is pinned and no peer is registered yet; run `machine join` (enrollment) to get peers';

/** Peers come from admin-signed registrations; enrollment (WP7) is what creates them. Until then there are none, and we say so. `injected` is for tests. */
function peersOf(injected: MachineEntry[]): { enrolled: boolean; peers: MachineEntry[] } {
  return { enrolled: false, peers: injected };
}

function selfOf(configDir: string): MachineIdentity | NotInitialized {
  try {
    return readMachine(configDir);
  } catch (e) {
    if (e instanceof NotInitializedError) return { initialized: false, message: e.message };
    throw e;
  }
}

function payloadOf(payload: unknown): Record<string, unknown> {
  return typeof payload === 'object' && payload !== null ? (payload as Record<string, unknown>) : {};
}

function stringField(payload: unknown, field: string): string {
  const value = payloadOf(payload)[field];
  if (typeof value !== 'string') throw new Error(`missing "${field}" in the request`);
  return value;
}

/** `version` is read only by `status`: a failure to determine it must not break the other commands. */
export function makeCommands(configDir: string, version: string | (() => string), testPeers: MachineEntry[] = []) {
  const everyone = (self: MachineIdentity): MachineEntry[] => [{ uuid: self.uuid, name: self.name }, ...peersOf(testPeers).peers];
  return {
    status(): StatusAnswer | NotInitialized {
      const self = selfOf(configDir);
      if ('initialized' in self) return self;
      const { enrolled, peers } = peersOf(testPeers);
      return { initialized: true, uuid: self.uuid, name: self.name, version: typeof version === 'string' ? version : version(), enrolled, peers: peers.length, configDir, ...(enrolled ? {} : { note: NOT_ENROLLED_NOTE }) };
    },

    list(): ListAnswer | NotInitialized {
      const self = selfOf(configDir);
      if ('initialized' in self) return self;
      const { enrolled, peers } = peersOf(testPeers);
      const aliases = readAliases(configDir);
      return {
        initialized: true,
        self: { uuid: self.uuid, name: self.name },
        peers: peers.map((p) => ({ ...p, aliases: Object.entries(aliases).filter(([, uuid]) => uuid === p.uuid).map(([alias]) => alias) })),
        enrolled,
        ...(enrolled ? {} : { note: NOT_ENROLLED_NOTE }),
      };
    },

    resolve(payload?: unknown): ResolveAnswer {
      const self = selfOf(configDir);
      if ('initialized' in self) return self;
      const result = resolveMachineRef(stringField(payload, 'ref'), everyone(self), readAliases(configDir));
      if (!result.ok) return result;
      const machine = everyone(self).find((m) => m.uuid === result.uuid);
      return { ...result, ...(machine ? { name: machine.name } : {}) };
    },

    aliasList(): Record<string, string> {
      return readAliases(configDir);
    },

    aliasSet(payload?: unknown): AliasAnswer {
      const self = selfOf(configDir);
      if ('initialized' in self) return self;
      const alias = stringField(payload, 'alias');
      // The target is resolved WITHOUT aliases: an alias always points to a machine, never to another alias.
      const target = resolveMachineRef(stringField(payload, 'ref'), everyone(self), {});
      if (!target.ok) return target;
      const shadowed = everyone(self).find((m) => m.name.toLowerCase() === alias.toLowerCase() && m.uuid !== target.uuid);
      if (shadowed) {
        return {
          ok: false,
          reason: 'conflict',
          message: `the machine named "${shadowed.name}" (${shadowed.uuid.slice(0, 8)}) would be shadowed by this alias, which would silently redirect commands meant for it: choose another alias`,
        };
      }
      try {
        const { previous } = setAlias(configDir, alias, target.uuid, { replace: payloadOf(payload).replace === true });
        return { ok: true, alias, uuid: target.uuid, ...(previous ? { previous } : {}) };
      } catch (e) {
        if (e instanceof AliasConflictError) return { ok: false, reason: 'conflict', message: e.message };
        throw e;
      }
    },

    aliasRemove(payload?: unknown): { ok: true } | { ok: false; reason: 'missing'; message: string } {
      try {
        removeAlias(configDir, stringField(payload, 'alias'));
        return { ok: true };
      } catch (e) {
        if (e instanceof NoSuchAliasError) return { ok: false, reason: 'missing', message: e.message };
        throw e;
      }
    },
  };
}

export type MachineCommands = ReturnType<typeof makeCommands>;
