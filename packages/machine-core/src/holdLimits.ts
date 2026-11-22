import { DEFAULT_HELD_PER_MACHINE, DEFAULT_HELD_PER_PEER, MAX_HELD_PER_MACHINE_SETTING, MAX_HELD_PER_PEER_SETTING } from './hold.js';

// How many requests this machine HOLDS (`machine run --wait` of its peers). Set by the OWNER of the target in `<configDir>/hold-limits.json`
// (`machine hold-limits`): public, unsigned, local. It is never read from a peer, a request or a signed policy: a peer must not raise its own
// limit (threat model T-64). Pure: no I/O. The daemon reads leniently (a bad value falls back to the built-in default FOR THAT VALUE, with the reason,
// never silently); the command that writes reads strictly.

export type HoldLimitSource = 'setting' | 'built-in';

/** The content of `hold-limits.json`. An absent field means "not set here": the built-in default applies. */
export interface HoldLimitsSetting {
  v: 1;
  perPeer?: number;
  perMachine?: number;
}

export interface EffectiveHoldLimits {
  perPeer: number;
  perMachine: number;
  perPeerSource: HoldLimitSource;
  perMachineSource: HoldLimitSource;
}

export interface HoldLimitsRead {
  setting: HoldLimitsSetting;
  /** Each one names the field, the cause and the fix; the value concerned is NOT in `setting`. */
  problems: string[];
}

const PEER_RANGE = `1 to ${MAX_HELD_PER_PEER_SETTING}`;
const MACHINE_RANGE = `1 to ${MAX_HELD_PER_MACHINE_SETTING}`;

function checkCount(name: 'perPeer' | 'perMachine', value: unknown): string | undefined {
  const max = name === 'perPeer' ? MAX_HELD_PER_PEER_SETTING : MAX_HELD_PER_MACHINE_SETTING;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > max) {
    return `"${name}" must be a whole number from 1 to ${max}, got ${JSON.stringify(value)}`;
  }
  return undefined;
}

/**
 * Reads the content of the file field by field: a valid field is kept, an invalid one is reported and left out. A structure that cannot be read
 * at all (not an object, wrong "v") reports one problem and keeps nothing.
 */
export function readHoldLimits(raw: unknown): HoldLimitsRead {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { setting: { v: 1 }, problems: [`not an object: expected {"v": 1, "perPeer": <${PEER_RANGE}>, "perMachine": <${MACHINE_RANGE}>}`] };
  }
  const field = (name: string): unknown => Reflect.get(raw, name);
  const problems: string[] = [];
  const unknown = Object.keys(raw).find((k) => k !== 'v' && k !== 'perPeer' && k !== 'perMachine');
  if (unknown !== undefined) {
    problems.push(`unknown field "${unknown}": the known fields are "v", "perPeer" and "perMachine"`);
  }
  if (field('v') !== 1) {
    return { setting: { v: 1 }, problems: [...problems, '"v" must be 1'] };
  }
  const setting: HoldLimitsSetting = { v: 1 };
  for (const name of ['perPeer', 'perMachine'] as const) {
    const value = field(name);
    if (value === undefined) {
      continue;
    }
    const problem = checkCount(name, value);
    if (problem !== undefined) {
      problems.push(problem);
    } else {
      setting[name] = value as number;
    }
  }
  return { setting, problems };
}

/** Strict: throws a message naming the field and the fix on the first problem (used by the command that writes). */
export function parseHoldLimits(raw: unknown): HoldLimitsSetting {
  const { setting, problems } = readHoldLimits(raw);
  if (problems.length > 0 || checkConsistency(setting) !== undefined) {
    throw new Error(problems[0] ?? checkConsistency(setting) ?? 'invalid');
  }
  return setting;
}

/** The per-machine limit must hold at least one full per-peer quota, on the EFFECTIVE values. */
export function checkConsistency(setting: HoldLimitsSetting): string | undefined {
  const perPeer = setting.perPeer ?? DEFAULT_HELD_PER_PEER;
  const perMachine = setting.perMachine ?? DEFAULT_HELD_PER_MACHINE;
  if (perMachine >= perPeer) {
    return undefined;
  }
  const origin = (set: number | undefined, builtIn: number): string => (set === undefined ? `${builtIn}, the built-in default` : `${set}`);
  return `the limit per machine (${origin(setting.perMachine, DEFAULT_HELD_PER_MACHINE)}) must be at least the limit per peer (${origin(setting.perPeer, DEFAULT_HELD_PER_PEER)}): set both together, for example \`machine hold-limits --per-peer ${perPeer} --per-machine ${Math.min(MAX_HELD_PER_MACHINE_SETTING, perPeer * 2)}\``;
}

export function serializeHoldLimits(setting: HoldLimitsSetting): string {
  return `${JSON.stringify(setting, null, 2)}\n`;
}

/**
 * The limits in force and where each comes from. Never throws: a per-machine value below the per-peer one (a hand-edited file) is raised to the
 * per-peer one and reported in `problems`.
 */
export function resolveHoldLimits(setting: HoldLimitsSetting | undefined): { limits: EffectiveHoldLimits; problems: string[] } {
  const perPeer = setting?.perPeer ?? DEFAULT_HELD_PER_PEER;
  let perMachine = setting?.perMachine ?? DEFAULT_HELD_PER_MACHINE;
  const problems: string[] = [];
  if (perMachine < perPeer) {
    problems.push(`${checkConsistency(setting ?? { v: 1 }) ?? ''}; using ${perPeer} per machine until it is fixed`);
    perMachine = perPeer;
  }
  return {
    limits: {
      perPeer,
      perMachine,
      perPeerSource: setting?.perPeer !== undefined ? 'setting' : 'built-in',
      perMachineSource: setting?.perMachine !== undefined && setting.perMachine === perMachine ? 'setting' : 'built-in',
    },
    problems,
  };
}

/** `5 (built-in default)` / `3 (setting hold-limits)`. */
export function describeHoldLimit(value: number, source: HoldLimitSource): string {
  return `${value} (${source === 'setting' ? 'setting hold-limits' : 'built-in default'})`;
}
