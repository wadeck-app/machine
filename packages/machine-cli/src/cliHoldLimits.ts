import { DEFAULT_HELD_PER_MACHINE, DEFAULT_HELD_PER_PEER, MAX_HELD_PER_MACHINE_SETTING, MAX_HELD_PER_PEER_SETTING, describeHoldLimit } from '@wadeck-app/machine-core';
import { EXIT, type CommandContext } from './cliTypes.js';
import { HoldLimitsError, clearHoldLimits, holdLimitsFile, holdLimitsView, updateHoldLimits, type HoldLimitsView } from './holdLimitsStore.js';

// `machine hold-limits [--per-peer <1..20>] [--per-machine <1..50>] [--reset]`: how many requests THIS machine holds for `machine run --wait` of its
// peers. Local owner command only: no peer, request or signed policy can set it (threat model T-64). The daemon applies a change at its next
// admission, no restart. Ranges and per machine >= per peer: machine-core holdLimits.ts; the file: holdLimitsStore.ts.

function parseCount(flag: '--per-peer' | '--per-machine', text: string, max: number): number {
  if (!/^\d+$/.test(text.trim()) || Number(text) < 1 || Number(text) > max) {
    throw new HoldLimitsError(`${flag} ${JSON.stringify(text)} is not a whole number from 1 to ${max}: for example \`machine hold-limits ${flag} ${flag === '--per-peer' ? DEFAULT_HELD_PER_PEER : DEFAULT_HELD_PER_MACHINE}\`. The cap exists because every held request keeps a connection of a peer open on this machine`);
  }
  return Number(text);
}

function document(configDir: string, view: HoldLimitsView): Record<string, unknown> {
  return {
    perPeer: view.limits.perPeer,
    perPeerSource: view.limits.perPeerSource,
    perMachine: view.limits.perMachine,
    perMachineSource: view.limits.perMachineSource,
    file: holdLimitsFile(configDir),
    setting: view.setting ?? null,
    ...(view.problems.length > 0 ? { problems: view.problems } : {}),
  };
}

function showText(configDir: string, view: HoldLimitsView): string {
  return [
    'requests this machine holds for `machine run --wait` of its peers',
    `  per peer: ${describeHoldLimit(view.limits.perPeer, view.limits.perPeerSource)}`,
    `  per machine: ${describeHoldLimit(view.limits.perMachine, view.limits.perMachineSource)}`,
    `  setting file: ${holdLimitsFile(configDir)}${view.setting === undefined ? ' (absent: built-in defaults)' : ''}`,
    ...view.problems.map((p) => `  [warn] ${p}`),
    `change them: machine hold-limits --per-peer <1..${MAX_HELD_PER_PEER_SETTING}> --per-machine <1..${MAX_HELD_PER_MACHINE_SETTING}>   (per machine must be at least per peer; delete the setting: machine hold-limits --reset)`,
    'the running daemon applies a change at its next held request, no restart',
    '',
  ].join('\n');
}

/** The one line of `machine status`. */
export function holdLimitsStatusLine(view: HoldLimitsView): string {
  return `hold: this machine keeps at most ${describeHoldLimit(view.limits.perPeer, view.limits.perPeerSource)} requests waiting for approval per peer, ${describeHoldLimit(view.limits.perMachine, view.limits.perMachineSource)} in all; \`machine hold-limits\` shows and changes it`;
}

export async function runHoldLimits(ctx: CommandContext): Promise<number> {
  const { args, configDir, emit, fail } = ctx;
  const changing = args.perPeer !== undefined || args.perMachine !== undefined;
  if (args.reset === true && changing) {
    return fail('--reset stands alone: it deletes the setting; to change a value run `machine hold-limits --per-peer <n>` or `--per-machine <n>` separately', EXIT.usage);
  }
  try {
    if (args.reset === true) {
      // A damaged file is not read first: the reset is the way out.
      const removed = clearHoldLimits(configDir);
      const view = holdLimitsView(configDir);
      emit({ ...document(configDir, view), removed }, `${removed ? '[ok] the setting was deleted' : '[ok] no setting file'}: the built-in defaults apply (${DEFAULT_HELD_PER_PEER} per peer, ${DEFAULT_HELD_PER_MACHINE} per machine)\n`);
      return EXIT.ok;
    }
    if (changing) {
      const change: { perPeer?: number; perMachine?: number } = {};
      if (args.perPeer !== undefined) {
        change.perPeer = parseCount('--per-peer', args.perPeer, MAX_HELD_PER_PEER_SETTING);
      }
      if (args.perMachine !== undefined) {
        change.perMachine = parseCount('--per-machine', args.perMachine, MAX_HELD_PER_MACHINE_SETTING);
      }
      updateHoldLimits(configDir, change);
    }
    const view = holdLimitsView(configDir);
    emit(document(configDir, view), `${changing ? '[ok] saved\n' : ''}${showText(configDir, view)}`);
    return EXIT.ok;
  } catch (e) {
    if (e instanceof HoldLimitsError) {
      // violations-suppress: ts/no-err-message-direct HoldLimitsError carries the sentence for the user (path or flag, cause, fix)
      return fail(e.message, changing ? EXIT.usage : EXIT.failure);
    }
    throw e;
  }
}
