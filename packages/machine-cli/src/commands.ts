import { resolveMachineRef, type MachineEntry, type Resolution } from '@wadeck-app/machine-core';
import { AliasConflictError, NoSuchAliasError, NotInitializedError } from './errors.js';
import { readMachine, type MachineIdentity } from './identity.js';
import { loadNetwork, readRevocationSeen, revocationState } from './network.js';
import { readAliases, removeAlias, setAlias } from './state.js';

// The daemon commands. Each is a plain function of the config directory, so the CLI runs the very same code in-process
// when no daemon is running and the tests need no network. No answer ever carries a secret.

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
  /** Version of the policy in force on this machine; absent when there is none (everything is refused). */
  policyVersion?: number;
  /** Version (issuedAt of the newest admin-signed list) of the revocations held here; 0 when none. Present when enrolled. */
  revocationVersion?: number;
  /** Peers whose revocations, announced (digest) at their last handshake, differ from ours: they may still trust a revoked machine until they meet a peer that has the lists. The version is informational. */
  peersBehind?: Array<{ uuid: string; name: string; revocationVersionSeen: number }>;
  /** What was left out of the network and why (invalid registration, tampered policy, ...). */
  problems: string[];
  configDir: string;
  note?: string;
}

export interface ListAnswer {
  initialized: true;
  self: MachineEntry;
  /** revocationVersionSeen: the revocation version the peer announced at its last handshake (absent: never seen), revocationSeenAt: when (epoch seconds). */
  peers: Array<MachineEntry & { aliases: string[]; revocationVersionSeen?: number; revocationSeenAt?: number }>;
  /** Why the revocation versions are missing (unreadable state file). */
  revocationWarning?: string;
  enrolled: boolean;
  note?: string;
}

export type ResolveAnswer = (Resolution & { name?: string }) | NotInitialized;
export type AliasAnswer = { ok: true; alias: string; uuid: string; previous?: string } | Exclude<Resolution, { ok: true }> | { ok: false; reason: 'conflict' | 'missing'; message: string } | NotInitialized;

const NOT_ENROLLED_NOTE = 'not enrolled: no admin key is pinned on this machine; pin the admin key (`machine admin pin <admin.json>`) and import peers (`machine peer import <bundle.json>`)';

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

const epochSeconds = () => Math.floor(Date.now() / 1000);

/** `version` is read only by `status`: a failure to determine it must not break the other commands. */
export function makeCommands(configDir: string, version: string | (() => string), now: () => number = epochSeconds) {
  const everyone = (self: MachineIdentity): MachineEntry[] => [{ uuid: self.uuid, name: self.name }, ...loadNetwork(configDir, now()).directory.machines()];
  return {
    status(): StatusAnswer | NotInitialized {
      const self = selfOf(configDir);
      if ('initialized' in self) return self;
      const network = loadNetwork(configDir, now());
      const problems = [...network.problems];
      let revocation: Pick<StatusAnswer, 'revocationVersion' | 'peersBehind'> = {};
      if (network.enrolled) {
        try {
          const own = revocationState(configDir);
          const seen = readRevocationSeen(configDir, (warning) => problems.push(warning));
          const behind = network.directory.machines().flatMap((m) => {
            const s = seen[m.uuid];
            return s !== undefined && s.digest !== own.digest ? [{ uuid: m.uuid, name: m.name, revocationVersionSeen: s.version }] : [];
          });
          revocation = { revocationVersion: own.version, peersBehind: behind };
        } catch (e) {
          problems.push(`revocation catch-up state unavailable: ${(e as Error).message}`);
        }
      }
      return {
        initialized: true,
        uuid: self.uuid,
        name: self.name,
        version: typeof version === 'string' ? version : version(),
        enrolled: network.enrolled,
        peers: network.directory.machines().length,
        ...(network.policy ? { policyVersion: network.policy.version } : {}),
        ...revocation,
        problems,
        configDir,
        ...(network.enrolled ? {} : { note: NOT_ENROLLED_NOTE }),
      };
    },

    list(): ListAnswer | NotInitialized {
      const self = selfOf(configDir);
      if ('initialized' in self) return self;
      const network = loadNetwork(configDir, now());
      const aliases = readAliases(configDir);
      let revocationWarning: string | undefined;
      const seen = readRevocationSeen(configDir, (warning) => (revocationWarning = `the revocation versions are not shown: ${warning}`));
      return {
        initialized: true,
        self: { uuid: self.uuid, name: self.name },
        peers: network.directory.machines().map((p) => ({
          ...p,
          aliases: Object.entries(aliases).filter(([, uuid]) => uuid === p.uuid).map(([alias]) => alias),
          ...(seen[p.uuid] ? { revocationVersionSeen: seen[p.uuid]?.version as number, revocationSeenAt: seen[p.uuid]?.at as number } : {}),
        })),
        ...(revocationWarning ? { revocationWarning } : {}),
        enrolled: network.enrolled,
        ...(network.enrolled ? {} : { note: NOT_ENROLLED_NOTE }),
      };
    },

    resolve(payload?: unknown): ResolveAnswer {
      const self = selfOf(configDir);
      if ('initialized' in self) return self;
      const machines = everyone(self);
      const result = resolveMachineRef(stringField(payload, 'ref'), machines, readAliases(configDir));
      if (!result.ok) return result;
      const machine = machines.find((m) => m.uuid === result.uuid);
      return { ...result, ...(machine ? { name: machine.name } : {}) };
    },

    aliasList(): Record<string, string> {
      return readAliases(configDir);
    },

    aliasSet(payload?: unknown): AliasAnswer {
      const self = selfOf(configDir);
      if ('initialized' in self) return self;
      const alias = stringField(payload, 'alias');
      const machines = everyone(self);
      // The target is resolved WITHOUT aliases: an alias always points to a machine, never to another alias.
      const target = resolveMachineRef(stringField(payload, 'ref'), machines, {});
      if (!target.ok) return target;
      const shadowed = machines.find((m) => m.name.toLowerCase() === alias.toLowerCase() && m.uuid !== target.uuid);
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
