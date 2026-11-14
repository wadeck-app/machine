// Kept out of entry.ts on purpose: that module runs the updater as a side effect of being imported, so a test importing it
// would launch a real upgrade. This one is pure.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export type SelfCheckTarget = { ok: true; target: string } | { ok: false; reason: string };

/**
 * Locates the CLI entry point that the post-install self-check will run.
 *
 * The command is built before the upgrade but runs after it, so it must name a path the future package still has. `bin` is the
 * published contract and bin/machine.js resolves the bundle itself, so it survives renames of anything else in the package.
 * Existence is verified rather than assumed: arming a doomed command makes every update roll back, forever.
 */
export function resolveSelfCheckTarget(npmRoot: string, pkgName: string): SelfCheckTarget {
  const pkgDir = join(npmRoot, pkgName);
  const manifestPath = join(pkgDir, 'package.json');
  let binRel: string | undefined;
  try {
    binRel = (JSON.parse(readFileSync(manifestPath, 'utf8')) as { bin?: Record<string, string> }).bin?.machine;
  } catch (e) {
    return { ok: false, reason: `cannot read ${manifestPath}: ${(e as Error).message}` };
  }
  if (binRel === undefined) return { ok: false, reason: `${manifestPath} declares no bin.machine entry` };
  const target = join(pkgDir, binRel);
  if (!existsSync(target)) return { ok: false, reason: `bin.machine points at ${target}, which does not exist` };
  return { ok: true, target };
}

/** Present in the failing command so a log line or a test can tell it from a real self-check. */
export const FAILING_SELF_CHECK_MARKER = 'machine-self-check-unavailable';

export type SelfCheckArming = { command: string; note?: string; abort?: undefined } | { abort: string; command?: undefined; note?: undefined };

/**
 * Decides the command shared-updater runs after an install (or while repairing an interrupted one).
 *
 * Normally an unresolvable target aborts the run: shared-updater treats a missing command as "passed", so going on would install
 * an unverified upgrade with no rollback.
 *
 * With an 'applying' state journaled (an install was killed) the same condition is the expected one: the package is half-removed.
 * Aborting would stop shared-updater before its repair. The repair keeps the target only when the self-check passes, so arming a
 * command that fails makes it restore the previous version, which is the safe outcome.
 */
export function armSelfCheck(args: { nodeExe: string; resolved: SelfCheckTarget; interrupted: boolean }): SelfCheckArming {
  const { nodeExe, resolved, interrupted } = args;
  // Run through a shell: both paths are quoted, a default Windows install of node sits under "Program Files".
  if (resolved.ok) return { command: `"${nodeExe}" "${resolved.target}" cli self-check` };
  if (interrupted) {
    return {
      command: `"${nodeExe}" -e "process.exit(1)" ${FAILING_SELF_CHECK_MARKER}`,
      note: `an interrupted install is journaled and the self-check cannot be armed (${resolved.reason}): the repair will restore the previous version`,
    };
  }
  return {
    abort: `${resolved.reason}. Without a usable entry point the post-install self-check cannot be armed, and an unverified update would not be rollback-able. Repair with: npm install -g @wadeck-app/machine-cli@latest`,
  };
}
