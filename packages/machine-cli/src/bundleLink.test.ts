import * as realFs from 'node:fs';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { bundleLinkLine, planBundleLink, syncBundleLink, type BundleLinkFs } from './bundleLink.js';

// The Windows junction `<staged folder>\node_modules` -> the folder that holds @wadeck-app/machine-cli (port of orch bundle-link.ts).
// The Go launcher, staged out of node_modules, finds the bundle only through <node dir>\node_modules or by walking up node_modules from its own folder.

const SPEC = '@wadeck-app/machine-cli/machine.cjs';
const STAGE = 'C:\\cfg\\bin\\1.0.0';

describe('planBundleLink', () => {
  it('names the node_modules folder that holds the bundle and the link to create in the staged folder', () => {
    const plan = planBundleLink({ platform: 'win32', bundle: 'C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\@wadeck-app\\machine-cli\\machine.cjs', spec: SPEC, stageDir: STAGE });
    expect(plan).toEqual({ modulesDir: 'C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules', stageDir: STAGE, link: `${STAGE}\\node_modules` });
  });

  it('is case-insensitive on the package part (Windows paths)', () => {
    const plan = planBundleLink({ platform: 'win32', bundle: 'C:\\npm\\node_modules\\@Wadeck-App\\Machine-CLI\\machine.cjs', spec: SPEC, stageDir: STAGE });
    expect(plan?.modulesDir).toBe('C:\\npm\\node_modules');
  });

  it('a bundle that is not at <node_modules>/<spec> (a checkout) gets no link', () => {
    expect(planBundleLink({ platform: 'win32', bundle: 'C:\\src\\machine\\dist\\machine.cjs', spec: SPEC, stageDir: STAGE })).toBeNull();
    expect(planBundleLink({ platform: 'win32', bundle: 'C:\\lib\\@wadeck-app\\machine-cli\\machine.cjs', spec: SPEC, stageDir: STAGE })).toBeNull();
  });

  it('is a no-op outside Windows (the Unix job carries LAUNCHER_BUNDLE_OVERRIDE)', () => {
    expect(planBundleLink({ platform: 'linux', bundle: '/usr/lib/node_modules/@wadeck-app/machine-cli/machine.cjs', spec: SPEC, stageDir: '/c/bin/1' })).toBeNull();
    expect(planBundleLink({ platform: 'darwin', bundle: '/x/node_modules/@wadeck-app/machine-cli/machine.cjs', spec: SPEC, stageDir: '/c/bin/1' })).toBeNull();
  });
});

describe('syncBundleLink with a failing fs', () => {
  const plan = { modulesDir: 'C:\\npm\\node_modules', stageDir: STAGE, link: `${STAGE}\\node_modules` };
  const failing = (code: string): BundleLinkFs => ({
    lstatSync: ((p: string) => {
      if (p === STAGE) return { isDirectory: () => true };
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    }) as unknown as BundleLinkFs['lstatSync'],
    realpathSync: ((p: string) => p) as unknown as BundleLinkFs['realpathSync'],
    unlinkSync: () => undefined,
    symlinkSync: () => {
      throw Object.assign(new Error('operation not permitted'), { code });
    },
  });

  it('a creation failure is reported (never thrown) with the cause, the consequence and the fix', () => {
    const report = syncBundleLink(plan, failing('EPERM'));
    expect(report.state).toBe('failed');
    const line = bundleLinkLine(report);
    expect(line).toMatch(/^\[warn\]/);
    expect(line).toContain(plan.link);
    expect(line).toContain('EPERM');
    expect(line).toMatch(/machine startup enable/);
  });
});

describe.runIf(process.platform === 'win32')('junction on the real file system (temp folders only)', () => {
  let root: string;
  let modules: string;
  let bundle: string;
  let stage: string;
  const planFor = (modulesDir: string) => ({ modulesDir, stageDir: stage, link: join(stage, 'node_modules') });
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'machine-bundle-link-'));
    modules = join(root, 'npm', 'node_modules');
    bundle = join(modules, '@wadeck-app', 'machine-cli', 'machine.cjs');
    mkdirSync(join(modules, '@wadeck-app', 'machine-cli'), { recursive: true });
    writeFileSync(bundle, '// bundle');
    stage = join(root, 'config', 'bin', '1.0.0');
    mkdirSync(stage, { recursive: true });
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('creates the junction and the bundle resolves through it', () => {
    const report = syncBundleLink(planFor(modules));
    expect(report.state).toBe('created');
    expect(readFileSync(join(stage, 'node_modules', '@wadeck-app', 'machine-cli', 'machine.cjs'), 'utf8')).toBe('// bundle');
    expect(bundleLinkLine(report)).toMatch(/^\[ok\]/);
  });

  it('an already correct junction is left alone', () => {
    syncBundleLink(planFor(modules));
    const report = syncBundleLink(planFor(modules));
    expect(report.state).toBe('unchanged');
    expect(bundleLinkLine(report)).toMatch(/^\[ok\]/);
  });

  it('a stale junction (the npm prefix moved) is pointed at the new folder and reported as repaired', () => {
    const other = join(root, 'other', 'node_modules');
    mkdirSync(other, { recursive: true });
    syncBundleLink(planFor(other));
    const report = syncBundleLink(planFor(modules));
    expect(report.state).toBe('replaced');
    expect(realpathSync(join(stage, 'node_modules'))).toBe(realpathSync(modules));
    expect(bundleLinkLine(report)).toMatch(/^\[ok\].*repaired/);
  });

  it('a junction to a folder that is gone is repaired', () => {
    const gone = join(root, 'gone', 'node_modules');
    mkdirSync(gone, { recursive: true });
    syncBundleLink(planFor(gone));
    rmSync(join(root, 'gone'), { recursive: true });
    expect(syncBundleLink(planFor(modules)).state).toBe('replaced');
  });

  it('a real folder named node_modules is never touched: warning with the fix', () => {
    mkdirSync(join(stage, 'node_modules'));
    writeFileSync(join(stage, 'node_modules', 'keep.txt'), 'x');
    const report = syncBundleLink(planFor(modules));
    expect(report.state).toBe('failed');
    expect(bundleLinkLine(report)).toMatch(/^\[warn\].*not a link.*delete it/);
    expect(existsSync(join(stage, 'node_modules', 'keep.txt'))).toBe(true);
  });

  it('a staged folder that does not exist yet is reported, not created', () => {
    rmSync(stage, { recursive: true });
    const report = syncBundleLink(planFor(modules));
    expect(report.state).toBe('not-staged');
    expect(bundleLinkLine(report)).toMatch(/^\[warn\].*machine startup enable/);
    expect(existsSync(stage)).toBe(false);
  });

  it('removing the staged folder removes the junction and never what it leads to', () => {
    syncBundleLink(planFor(modules));
    expect(lstatSync(join(stage, 'node_modules')).isSymbolicLink()).toBe(true);
    rmSync(stage, { recursive: true });
    expect(existsSync(bundle)).toBe(true);
    expect(realFs.readFileSync(bundle, 'utf8')).toBe('// bundle');
  });
});
