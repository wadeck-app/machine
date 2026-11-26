import { IDLE_SUSPEND_SERVICE_PATH, IDLE_SUSPEND_TIMER_PATH, idleSuspendScript, idleSuspendServiceUnit, idleSuspendTimerUnit, type IdleScriptOptions } from './idleSuspend.js';
import { IDLE_DARWIN_PLIST_PATH, idleSuspendDarwinPlist, idleSuspendDarwinScript } from './idleSuspendDarwin.js';
import { InstallError } from './installError.js';

// Platform dispatch of `machine install idle-suspend`: the script and the scheduler files are chosen by `process.platform` (as measured by the executor).
// Linux: the existing functions of idleSuspend.ts, untouched. darwin: idleSuspendDarwin.ts (a skeleton that fails loudly). Any other platform is an internal error:
// the registry refuses it first, with the supported list.

export type IdleSuspendPlatform = 'linux' | 'darwin';

/** A file of the scheduler (systemd units on Linux, the launchd plist on macOS); the plan adds owner, group and description. */
export interface IdleSchedulerFile {
  id: string;
  path: string;
  mode: string;
  content: string;
}

const unknownPlatform = (platform: string): InstallError => new InstallError(`internal: idle-suspend has no script or scheduler for the platform ${JSON.stringify(platform.slice(0, 20))} (supported: linux, darwin)`);

export function idleSuspendScriptFor(platform: string, o: IdleScriptOptions): string {
  switch (platform) {
    case 'linux':
      return idleSuspendScript(o);
    case 'darwin':
      return idleSuspendDarwinScript(o);
    default:
      throw unknownPlatform(platform);
  }
}

/** `scriptPath` is only read for darwin (the folder of the script is an open decision of the spec, U5: it has no default here). */
export function idleSuspendSchedulerFor(platform: string, o: { cadenceSeconds: number; scriptPath?: string }): IdleSchedulerFile[] {
  switch (platform) {
    case 'linux':
      return [
        { id: 'service', path: IDLE_SUSPEND_SERVICE_PATH, mode: '0644', content: idleSuspendServiceUnit() },
        { id: 'timer', path: IDLE_SUSPEND_TIMER_PATH, mode: '0644', content: idleSuspendTimerUnit(o.cadenceSeconds) },
      ];
    case 'darwin':
      if (o.scriptPath === undefined) {
        throw new InstallError('internal: the darwin scheduler needs the script path (the folder of the script is not decided yet)');
      }
      return [{ id: 'plist', path: IDLE_DARWIN_PLIST_PATH, mode: '0644', content: idleSuspendDarwinPlist({ cadenceSeconds: o.cadenceSeconds, scriptPath: o.scriptPath }) }];
    default:
      throw unknownPlatform(platform);
  }
}
