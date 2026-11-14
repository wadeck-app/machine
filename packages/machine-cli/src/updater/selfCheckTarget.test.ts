import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { armSelfCheck, FAILING_SELF_CHECK_MARKER, resolveSelfCheckTarget } from './selfCheckTarget.js';

// Port of orch's self-check-target and self-check-arming tests (bin.orch -> bin.machine).

const PKG = '@wadeck-app/machine-cli';
const roots: string[] = [];
afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop() as string, { recursive: true, force: true });
});

/** A fake global npm root holding the package with the given manifest and files. */
function fakeNpmRoot(manifest: unknown, files: string[] = []): string {
  const root = mkdtempSync(join(tmpdir(), 'machine-sct-'));
  roots.push(root);
  const pkgDir = join(root, PKG);
  mkdirSync(pkgDir, { recursive: true });
  writeFileSync(join(pkgDir, 'package.json'), JSON.stringify(manifest));
  for (const f of files) {
    const p = join(pkgDir, f);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, '');
  }
  return root;
}

describe('resolveSelfCheckTarget', () => {
  it('resolves bin.machine to its absolute path', () => {
    const root = fakeNpmRoot({ bin: { machine: 'bin/machine.js' } }, ['bin/machine.js']);
    expect(resolveSelfCheckTarget(root, PKG)).toEqual({ ok: true, target: join(root, PKG, 'bin', 'machine.js') });
  });

  it('refuses to arm when bin.machine is declared but absent on disk (the self-check would fail and roll back every update forever)', () => {
    const r = resolveSelfCheckTarget(fakeNpmRoot({ bin: { machine: 'dist/cli.js' } }), PKG);
    expect(r.ok).toBe(false);
    expect((r as { reason: string }).reason).toMatch(/dist[\\/]cli\.js.*does not exist/);
  });

  it('refuses to arm when the manifest declares no bin.machine', () => {
    const r = resolveSelfCheckTarget(fakeNpmRoot({ bin: { other: 'bin/other.js' } }, ['bin/other.js']), PKG);
    expect(r.ok).toBe(false);
    expect((r as { reason: string }).reason).toMatch(/no bin\.machine entry/);
  });

  it('refuses to arm when the package is not installed', () => {
    const root = mkdtempSync(join(tmpdir(), 'machine-sct-empty-'));
    roots.push(root);
    const r = resolveSelfCheckTarget(root, PKG);
    expect(r.ok).toBe(false);
    expect((r as { reason: string }).reason).toMatch(/cannot read/);
  });

  it('refuses to arm on a malformed manifest instead of throwing', () => {
    const root = fakeNpmRoot({});
    writeFileSync(join(root, PKG, 'package.json'), '{ not json');
    const r = resolveSelfCheckTarget(root, PKG);
    expect(r.ok).toBe(false);
    expect((r as { reason: string }).reason).toMatch(/cannot read/);
  });
});

describe('armSelfCheck', () => {
  const NODE = 'C:\\Program Files\\nodejs\\node.exe';

  it('a resolvable target is armed with both paths quoted', () => {
    expect(armSelfCheck({ nodeExe: NODE, resolved: { ok: true, target: 'C:\\npm\\machine.js' }, interrupted: false })).toEqual({ command: `"${NODE}" "C:\\npm\\machine.js" cli self-check` });
  });

  it('an unresolvable target aborts a normal run and names the manual fix', () => {
    const r = armSelfCheck({ nodeExe: NODE, resolved: { ok: false, reason: 'cannot read x' }, interrupted: false });
    expect(r.command).toBeUndefined();
    expect(r.abort).toMatch(/cannot read x/);
    expect(r.abort).toMatch(/npm install -g @wadeck-app\/machine-cli@latest/);
  });

  it('with an interrupted install journaled, an unresolvable target arms a self-check that FAILS so the repair restores the previous version', () => {
    const r = armSelfCheck({ nodeExe: NODE, resolved: { ok: false, reason: 'cannot read x' }, interrupted: true });
    expect(r.abort).toBeUndefined();
    expect(r.command).toContain(FAILING_SELF_CHECK_MARKER);
    expect(r.command?.startsWith(`"${NODE}" `)).toBe(true);
    expect(r.note).toMatch(/cannot read x/);
  });

  it('with an interrupted install journaled, a resolvable target is armed normally', () => {
    expect(armSelfCheck({ nodeExe: NODE, resolved: { ok: true, target: '/p/machine.js' }, interrupted: true }).command).toBe(`"${NODE}" "/p/machine.js" cli self-check`);
  });
});
