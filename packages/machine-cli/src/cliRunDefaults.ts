import { describeRunWait, describeSeconds, parseWait, resolveRunWait, type RunDefaults, type RunWait } from '@wadeck-app/machine-core';
import { EXIT, type CommandContext } from './cliTypes.js';
import { RunDefaultsError, clearRunDefaults, readRunDefaults, runDefaultsFile, updateRunDefaults } from './runDefaultsStore.js';

// `machine run-defaults [--on-refusal wait|fail] [--wait <10s..60m>] [--reset]`: the machine setting of `machine run` (what to do when the target
// does not allow the command yet). The precedence (flags, setting, built-in) lives in machine-core `resolveRunWait`; the file in runDefaultsStore.ts.

/** The effective behaviour of a `machine run` with no flag, with where each value comes from: the document of `--json` and of `machine status`. */
export function runDefaultsDocument(configDir: string, setting: RunDefaults | undefined, wait: RunWait): Record<string, unknown> {
  return {
    onRefusal: wait.onRefusal,
    onRefusalSource: wait.onRefusalSource,
    ...(wait.onRefusal === 'wait' ? { waitSeconds: wait.seconds, waitSecondsSource: wait.secondsSource } : {}),
    // A duration stored while the mode is fail: kept for the day the mode is wait again.
    ...(wait.onRefusal === 'fail' && setting?.waitSeconds !== undefined ? { storedWaitSeconds: setting.waitSeconds } : {}),
    file: runDefaultsFile(configDir),
    setting: setting ?? null,
  };
}

/** The one line of `machine status`. */
export function runDefaultsStatusLine(wait: RunWait): string {
  const described = describeRunWait(wait);
  const what = wait.onRefusal === 'wait' ? `wait ${described.wait ?? ''}` : `fail at once (${described.onRefusal.replace(/^fail \(/, '').replace(/\)$/, '')})`;
  return `run: when a target does not allow a command yet: ${what}; \`machine run-defaults\` shows and changes it`;
}

export function runDefaultsView(configDir: string): { setting: RunDefaults | undefined; wait: RunWait } {
  const setting = readRunDefaults(configDir);
  return { setting, wait: resolveRunWait({}, setting) };
}

function showText(configDir: string, setting: RunDefaults | undefined, wait: RunWait): string {
  const described = describeRunWait(wait);
  return [
    'machine run: what to do when the target does not allow the command yet',
    `  on refusal: ${described.onRefusal}`,
    ...(described.wait !== undefined ? [`  wait: ${described.wait}`] : []),
    ...(wait.onRefusal === 'fail' && setting?.waitSeconds !== undefined ? [`  stored wait: ${describeSeconds(setting.waitSeconds)} (used when on refusal is wait)`] : []),
    `  setting file: ${runDefaultsFile(configDir)}${setting === undefined ? ' (absent: built-in default)' : ''}`,
    'change it for every run: machine run-defaults --on-refusal wait|fail [--wait <10s..60m>]   (delete the setting: machine run-defaults --reset)',
    'change it for one run: machine run <machine> --no-wait | --wait <10s..60m> | --on-refusal wait|fail -- <command>',
    '',
  ].join('\n');
}

export async function runRunDefaults(ctx: CommandContext): Promise<number> {
  const { args, configDir, emit, fail } = ctx;
  const changing = args.onRefusal !== undefined || args.wait !== undefined;
  if (args.reset === true && changing) {
    return fail('--reset stands alone: it deletes the setting; to change a value run `machine run-defaults --on-refusal wait|fail` or `--wait <duration>` separately', EXIT.usage);
  }
  const change: { onRefusal?: 'wait' | 'fail'; waitSeconds?: number } = {};
  try {
    if (args.onRefusal !== undefined) {
      // The same wording as `machine run` for a value that is not a choice.
      const checked = resolveRunWait({ onRefusal: args.onRefusal }, undefined);
      change.onRefusal = checked.onRefusal;
    }
    if (args.wait !== undefined) {
      change.waitSeconds = parseWait(args.wait);
    }
  } catch (e) {
    // violations-suppress: ts/no-err-message-direct the errors of resolveRunWait and parseWait are Errors written for the user (the flag and the fix)
    return fail((e as Error).message, EXIT.usage);
  }
  try {
    if (args.reset === true) {
      // A damaged file is read first: the reset is the way out, so it must not depend on the file being valid.
      const removed = clearRunDefaults(configDir);
      const { setting, wait } = runDefaultsView(configDir);
      emit({ ...runDefaultsDocument(configDir, setting, wait), removed }, `${removed ? '[ok] the setting was deleted: the built-in default applies (wait 10m)' : '[ok] no setting file: the built-in default already applies (wait 10m)'}\n`);
      return EXIT.ok;
    }
    if (changing) {
      updateRunDefaults(configDir, change);
    }
    const { setting, wait } = runDefaultsView(configDir);
    emit(runDefaultsDocument(configDir, setting, wait), `${changing ? '[ok] saved\n' : ''}${showText(configDir, setting, wait)}`);
    return EXIT.ok;
  } catch (e) {
    if (e instanceof RunDefaultsError) {
      // violations-suppress: ts/no-err-message-direct RunDefaultsError carries the sentence for the user (path, cause, fix)
      return fail(e.message);
    }
    throw e;
  }
}
