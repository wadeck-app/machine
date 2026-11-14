import { describe, expect, it } from 'vitest';
import { contentHash, planPublish, platformVersion, requireAllPublished } from './publishPlan.ts';

const bins = (): Record<string, Uint8Array> => ({
  'win32-x64': Buffer.from('win'),
  'darwin-arm64': Buffer.from('mac'),
  'linux-x64': Buffer.from('lin'),
});
const BUILD = '2026.11.14-002-bbbbbbbb';

describe('contentHash', () => {
  it('is stable, 12 hex, and changes with any one launcher', () => {
    const a = contentHash(bins());
    expect(a).toMatch(/^[0-9a-f]{12}$/);
    expect(contentHash(bins())).toBe(a);
    expect(contentHash({ ...bins(), 'linux-x64': Buffer.from('lix') })).not.toBe(a);
  });

  it('changes when bytes move between platforms', () => {
    const swapped = { ...bins(), 'darwin-arm64': Buffer.from('lin'), 'linux-x64': Buffer.from('mac') };
    expect(contentHash(swapped)).not.toBe(contentHash(bins()));
  });

  it('fails loudly on a missing, empty or unexpected launcher', () => {
    const { 'darwin-arm64': _m, ...missing } = bins();
    expect(() => contentHash(missing)).toThrow(/no launcher for darwin-arm64.*build-launcher/);
    expect(() => contentHash({ ...bins(), 'linux-x64': Buffer.alloc(0) })).toThrow(/linux-x64 is empty/);
    expect(() => contentHash({ ...bins(), 'freebsd-x64': Buffer.from('x') })).toThrow(/unexpected launcher "freebsd-x64"/);
  });
});

describe('planPublish', () => {
  const hash = '0123456789ab';

  it('publishes <build>-bin.<hash> when no published version carries the hash', () => {
    expect(planPublish(BUILD, hash, [])).toEqual({ version: `${BUILD}-bin.${hash}`, action: 'publish' });
    expect(planPublish(BUILD, hash, ['2026.11.13-001-aaaaaaaa-bin.ffffffffffff'])).toEqual({ version: `${BUILD}-bin.${hash}`, action: 'publish' });
  });

  it('reuses the newest published version with the same hash', () => {
    const older = `2026.11.12-001-aaaaaaaa-bin.${hash}`;
    const newer = `2026.11.13-004-cccccccc-bin.${hash}`;
    expect(planPublish(BUILD, hash, [newer, 'x', older])).toEqual({ version: newer, action: 'reuse' });
  });

  it('rejects a malformed hash or build version', () => {
    expect(() => platformVersion(BUILD, 'XYZ')).toThrow(/12 lowercase hex/);
    expect(() => platformVersion('latest', hash)).toThrow(/not an exact version/);
  });
});

describe('requireAllPublished', () => {
  it('passes when every package has the version, names the missing ones otherwise', () => {
    expect(() => requireAllPublished('1.0.0-bin.a', { p1: ['1.0.0-bin.a'], p2: ['1.0.0-bin.a'] })).not.toThrow();
    expect(() => requireAllPublished('1.0.0-bin.a', { p1: ['1.0.0-bin.a'], p2: [] })).toThrow(/not published for p2.*publish the missing/);
  });
});
