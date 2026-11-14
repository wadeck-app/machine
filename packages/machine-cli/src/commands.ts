import { resolveMachineRef, type MachineEntry, type Resolution } from '@wadeck-app/machine-core';
import { NOT_INITIALIZED_MESSAGE, readMachine, type MachineIdentity } from './identity.js';
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

/** Peers come from admin-signed registrations; enrollment (WP7) is what creates them. Until then there are none, and we say so. */
function peersOf(): { enrolled: boolean; peers: MachineEntry[] } {
  return { enrolled: false, peers: [] };
}

function selfOf(configDir: string): MachineIdentity | NotInitialized {
  try {
    return readMachine(configDir);
  } catch (e) {
    if ((e as Error).message === NOT_INITIALIZED_MESSAGE) return { initialized: false, message: NOT_INITIALIZED_MESSAGE };
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

export function makeCommands(configDir: string, appVersion: string) {
  const everyone = (self: MachineIdentity): MachineEntry[] => [{ uuid: self.uuid, name: self.name }, ...peersOf().peers];
  return {
    status(): StatusAnswer | NotInitialized {
      const self = selfOf(configDir);
      if ('initialized' in self) return self;
      const { enrolled, peers } = peersOf();
      return { initialized: true, uuid: self.uuid, name: self.name, version: appVersion, enrolled, peers: peers.length, configDir, ...(enrolled ? {} : { note: NOT_ENROLLED_NOTE }) };
    },

    list(): ListAnswer | NotInitialized {
      const self = selfOf(configDir);
      if ('initialized' in self) return self;
      const { enrolled, peers } = peersOf();
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
      try {
        const { previous } = setAlias(configDir, alias, target.uuid, { replace: payloadOf(payload).replace === true });
        return { ok: true, alias, uuid: target.uuid, ...(previous ? { previous } : {}) };
      } catch (e) {
        if (/already points to/.test((e as Error).message)) return { ok: false, reason: 'conflict', message: (e as Error).message };
        throw e;
      }
    },

    aliasRemove(payload?: unknown): { ok: true } | { ok: false; reason: 'missing'; message: string } {
      try {
        removeAlias(configDir, stringField(payload, 'alias'));
        return { ok: true };
      } catch (e) {
        if (/^no alias/.test((e as Error).message)) return { ok: false, reason: 'missing', message: (e as Error).message };
        throw e;
      }
    },
  };
}

export type MachineCommands = ReturnType<typeof makeCommands>;
