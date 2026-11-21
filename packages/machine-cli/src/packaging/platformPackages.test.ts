import { describe, expect, it } from 'vitest';
import { PLATFORM_TARGETS, platformPackageName } from '../platformBinary.ts';
import { UNPINNED, assertExactVersion, pinPlatformVersions, platformPackageJson, wrapperPackageJson } from './platformPackages.ts';

const V = '2026.11.14-001-abcd1234';

describe('platformPackageJson', () => {
  it.each(Object.keys(PLATFORM_TARGETS))('%s: name, os, cpu, files come from the table', (key) => {
    const pkg = platformPackageJson(key, V);
    const [os, cpu] = key.split('-');
    expect(pkg.name).toBe(platformPackageName(key));
    expect(pkg.os).toEqual([os]);
    expect(pkg.cpu).toEqual([cpu]);
    expect(pkg.files).toEqual([PLATFORM_TARGETS[key]?.fileName]);
    expect(pkg.version).toBe(V);
    expect(pkg).not.toHaveProperty('private');
    expect(pkg).not.toHaveProperty('bin');
  });

  it('refuses an unknown platform and names the supported ones', () => {
    expect(() => platformPackageJson('freebsd-x64', V)).toThrow(/freebsd-x64.*win32-x64/);
  });

  it('refuses a range or an empty version', () => {
    expect(() => platformPackageJson('win32-x64', '>=0.0.0-0')).toThrow(/not an exact version/);
    expect(() => platformPackageJson('win32-x64', '')).toThrow(/not an exact version/);
  });
});

describe('wrapperPackageJson', () => {
  it('lists every platform package, unpinned by default, with bin, engines, commonjs', () => {
    const pkg = wrapperPackageJson({ version: V, files: ['machine.cjs'] });
    expect(Object.keys(pkg.optionalDependencies as object).sort()).toEqual(Object.keys(PLATFORM_TARGETS).map(platformPackageName).sort());
    expect(Object.values(pkg.optionalDependencies as object)).toEqual([UNPINNED, UNPINNED, UNPINNED]);
    expect(pkg.bin).toEqual({ machine: 'bin/machine.js' });
    expect(pkg.engines).toEqual({ node: '>=24' });
    expect(pkg.type).toBe('commonjs');
    expect(pkg.files).toEqual(['bin/machine.js', 'machine.cjs']);
    expect(pkg).not.toHaveProperty('private');
  });
});

describe('pinPlatformVersions', () => {
  const wrapper = wrapperPackageJson({ version: V, files: [] });
  const versions = Object.fromEntries(Object.keys(PLATFORM_TARGETS).map((k) => [platformPackageName(k), `${V}-bin.0123456789ab`]));

  it('writes exact versions and leaves the rest untouched', () => {
    const pinned = pinPlatformVersions(wrapper, versions);
    expect(pinned.optionalDependencies).toEqual(versions);
    expect(pinned.name).toBe(wrapper.name);
    expect(JSON.stringify(pinned)).not.toContain('>=0.0.0-0');
    expect(JSON.stringify(pinned)).not.toContain(UNPINNED);
  });

  it('fails when a platform has no version', () => {
    const { [platformPackageName('win32-x64')]: _omit, ...partial } = versions;
    expect(() => pinPlatformVersions(wrapper, partial)).toThrow(/no version given for @wadeck-app\/machine-cli-win32-x64/);
  });

  it('fails on a range, and on a package the wrapper does not list', () => {
    expect(() => pinPlatformVersions(wrapper, { ...versions, [platformPackageName('win32-x64')]: '^1.0.0' })).toThrow(/not an exact version/);
    expect(() => pinPlatformVersions(wrapper, { ...versions, '@wadeck-app/other': '1.0.0' })).toThrow(/not an optional dependency/);
  });

  it('fails on a wrapper without optionalDependencies', () => {
    expect(() => pinPlatformVersions({ name: 'x', version: V }, versions)).toThrow(/no optionalDependencies/);
  });
});

describe('assertExactVersion', () => {
  it('accepts CalVer and hash suffixes, refuses ranges', () => {
    expect(() => assertExactVersion(V, 'v')).not.toThrow();
    expect(() => assertExactVersion(`${V}-bin.0123456789ab`, 'v')).not.toThrow();
    for (const bad of ['latest', '1.x', '~1.0.0', 'v1.0.0', '1.0']) expect(() => assertExactVersion(bad, 'v')).toThrow();
  });
});
