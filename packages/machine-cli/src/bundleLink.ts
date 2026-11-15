import * as nodeFs from 'node:fs';
import { win32 } from 'node:path';

// Windows only: the staged launcher (`<configDir>/bin/<stamp>/machine.exe`, a copy made outside node_modules) finds the bundle only
// next to itself, under `<folder of node>/node_modules/<spec>`, or by walking up node_modules from its own folder (singleton-daemon-kit
// go-launcher/nodescript.go). A staged copy has no node_modules above it, so with the global modules in %APPDATA%\npm it fails with
// "cannot find the bundle". A directory junction `<staged folder>\node_modules` -> the folder that holds the package fixes it without admin
// rights. Port of orch's bundle-link.ts. The junction targets the modules folder, not the bundle: an in-place update needs no new link.

/** The subset of node:fs used here (injectable for the failure cases). */
export type BundleLinkFs = Pick<typeof nodeFs, 'lstatSync' | 'realpathSync' | 'unlinkSync' | 'symlinkSync'>;

export interface BundleLinkPlan {
  /** The `node_modules` folder that holds the package (the junction target). */
  modulesDir: string;
  /** The staged folder, `<configDir>/bin/<stamp>`. */
  stageDir: string;
  /** `<stageDir>\node_modules`. */
  link: string;
}

/**
 * Null when no link is wanted or possible: not Windows (the other platforms carry LAUNCHER_BUNDLE_OVERRIDE), or the bundle is not at
 * `<node_modules>/<spec>` (a checkout, which has no node_modules to show). The caller asks only when the launcher cannot find the bundle itself.
 */
export function planBundleLink(opts: { platform: NodeJS.Platform; bundle: string; spec: string; stageDir: string }): BundleLinkPlan | null {
  if (opts.platform !== 'win32') return null;
  const tail = win32.join(...opts.spec.split('/'));
  const bundle = win32.normalize(opts.bundle);
  if (!bundle.toLowerCase().endsWith(tail.toLowerCase())) return null;
  const modulesDir = bundle.slice(0, bundle.length - tail.length).replace(/[\\/]+$/, '');
  if (win32.basename(modulesDir).toLowerCase() !== 'node_modules') return null;
  return { modulesDir, stageDir: opts.stageDir, link: win32.join(opts.stageDir, 'node_modules') };
}

export interface BundleLinkReport {
  /** created/replaced: the link was missing or stale and is now right. failed: the cause is in `message`. not-staged: nothing to link into yet. */
  state: 'created' | 'replaced' | 'unchanged' | 'failed' | 'not-staged';
  link: string;
  modulesDir: string;
  message?: string;
}

const same = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

function errorCode(e: unknown): string | undefined {
  return (e as NodeJS.ErrnoException).code;
}

/**
 * Makes `<stageDir>\node_modules` lead to the modules folder: creates it, repoints a stale one (unlink on a junction removes the junction
 * only), leaves a correct one alone. Never throws: a failure is `failed` with the cause. A real folder under that name is never touched.
 * The staged folder is never created here (that is the launcher staging's job): absent is `not-staged`.
 */
export function syncBundleLink(plan: BundleLinkPlan, fs: BundleLinkFs = nodeFs): BundleLinkReport {
  const base = { link: plan.link, modulesDir: plan.modulesDir };
  const fail = (why: string): BundleLinkReport => ({ ...base, state: 'failed', message: why });
  try {
    try {
      if (!fs.lstatSync(plan.stageDir).isDirectory()) return fail(`${plan.stageDir} is not a folder`);
    } catch (e) {
      if (errorCode(e) === 'ENOENT') return { ...base, state: 'not-staged' };
      throw e;
    }
    let existing: nodeFs.Stats | undefined;
    try {
      existing = fs.lstatSync(plan.link);
    } catch (e) {
      if (errorCode(e) !== 'ENOENT') throw e;
    }
    if (existing !== undefined) {
      if (!existing.isSymbolicLink()) {
        return fail(`${plan.link} is not a link, so it was left alone and the launcher cannot find the bundle through it: delete it (it is inside the staged launcher folder), then run \`machine startup enable\``);
      }
      let current: string | undefined;
      try {
        current = fs.realpathSync(plan.link);
      } catch {
        // A link to a folder that is gone.
      }
      if (current !== undefined && same(current, fs.realpathSync(plan.modulesDir))) return { ...base, state: 'unchanged' };
      fs.unlinkSync(plan.link);
      fs.symlinkSync(plan.modulesDir, plan.link, 'junction');
      return { ...base, state: 'replaced' };
    }
    fs.symlinkSync(plan.modulesDir, plan.link, 'junction');
    return { ...base, state: 'created' };
  } catch (e) {
    const code = errorCode(e);
    return fail(`cannot link ${plan.link} to ${plan.modulesDir} (${code === undefined ? '' : `${code}: `}${(e as Error).message})`);
  }
}

/** One status line: `[ok]` when the launcher can find the bundle through the junction, `[warn]` with the fix otherwise. */
export function bundleLinkLine(report: BundleLinkReport): string {
  switch (report.state) {
    case 'unchanged':
      return `[ok] bundle link: ${report.link} -> ${report.modulesDir}`;
    case 'created':
      return `[ok] bundle link created: ${report.link} -> ${report.modulesDir}`;
    case 'replaced':
      return `[ok] bundle link repaired (it was stale): ${report.link} -> ${report.modulesDir}`;
    case 'not-staged':
      return `[warn] bundle link: the launcher is not staged yet, so ${report.link} does not exist: run \`machine startup enable\``;
    case 'failed':
      return `[warn] bundle link: ${report.message}. The launcher may not find the bundle on its own (the wscript wrapper still hands it over): check that the staged folder is writable, then run \`machine startup enable\``;
  }
}
