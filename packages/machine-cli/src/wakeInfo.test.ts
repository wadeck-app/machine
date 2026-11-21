import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readMachine } from './identity.js';
import { cli, provision } from './testing.js';
import { wakeInfoText } from './wakeInfo.js';

// `machine wake-info <machine>`: the checklist to prepare THE TARGET for Wake-on-LAN. Reads local files only: no connection, no packet, no write.

describe('wakeInfoText', () => {
  const base = { name: 'laptop', uuid: '3f2a9c10-1b2c-4d3e-8f40-0123456789ab', pinned: [], remembered: [], mac: undefined };

  it('lists what is known and what is not', () => {
    const text = wakeInfoText({ ...base, pinned: ['192.168.1.40:47921'], remembered: ['192.168.1.41:47921'], mac: 'aa:bb:cc:dd:ee:01' });
    expect(text).toMatch(/pinned address\s+192\.168\.1\.40:47921/);
    expect(text).toMatch(/relay record\s+192\.168\.1\.41:47921/);
    expect(text).toMatch(/wake MAC\s+aa:bb:cc:dd:ee:01/);
    const unknown = wakeInfoText(base);
    expect(unknown).toMatch(/pinned address\s+none/);
    expect(unknown).toMatch(/relay record\s+none/);
    expect(unknown).toMatch(/wake MAC\s+not configured/);
  });

  it('gives the Linux commands without any UNVERIFIED mark on them, and marks every Apple and Windows statement UNVERIFIED', () => {
    const text = wakeInfoText(base);
    const section = (title: string, next: string): string[] => {
      const from = text.indexOf(title);
      const to = text.indexOf(next, from);
      expect(from).toBeGreaterThan(-1);
      expect(to).toBeGreaterThan(from);
      return text.slice(from, to).split('\n');
    };
    expect(text).toContain('ethtool <interface>');
    expect(text).toContain('Wake-on: g');
    expect(text).toContain('sudo ethtool -s <interface> wol g');
    expect(text).toContain('nmcli connection modify <connection> 802-3-ethernet.wake-on-lan magic');
    expect(text).toMatch(/BIOS\/UEFI.*Wake on LAN/);
    for (const [title, next] of [['macOS', 'Windows'], ['Windows', 'Machine side']] as const) {
      const lines = section(title, next).filter((l) => /^\s+[-*]|^\s+\d\./.test(l));
      expect(lines.length).toBeGreaterThanOrEqual(2);
      for (const line of lines) expect(line).toContain('UNVERIFIED');
    }
    expect(text).toContain('Wake for network access');
    expect(text).toContain('Allow this device to wake the computer');
    expect(text).toContain('Only allow a magic packet to wake the computer');
    expect(text).toMatch(/Fast [Ss]tartup/);
    const linux = section('Linux', 'macOS').join('\n');
    expect(linux).not.toContain('UNVERIFIED');
  });

  it('states the machine-side requirements and how to find the MAC on each system', () => {
    const text = wakeInfoText(base);
    expect(text).toMatch(/suspend/i);
    expect(text).toMatch(/not shut/i);
    expect(text).toContain('machine startup enable');
    expect(text).toMatch(/same (LAN|network)/i);
    expect(text).toContain('ip link');
    expect(text).toContain('getmac');
    expect(text).toContain('ifconfig');
  });

  it('ends with the exact command to run on the caller: the pinned address is reused, a placeholder when there is none', () => {
    const withAddress = wakeInfoText({ ...base, pinned: ['192.168.1.40:47921'] });
    expect(withAddress).toContain('machine peer connect laptop --address 192.168.1.40:47921 --wake-mac <aa:bb:cc:dd:ee:ff>');
    const without = wakeInfoText(base);
    expect(without).toContain('machine peer connect laptop --address <ip>:47921 --wake-mac <aa:bb:cc:dd:ee:ff>');
    const configured = wakeInfoText({ ...base, pinned: ['192.168.1.40:47921'], mac: 'aa:bb:cc:dd:ee:01' });
    expect(configured).toContain('machine peer connect laptop --show');
    expect(configured).not.toContain('--wake-mac <aa:bb:cc:dd:ee:ff>');
    expect(configured).toContain('machine wake laptop');
  });

  it('says what the command does not know: nothing was checked on the target', () => {
    expect(wakeInfoText(base)).toMatch(/nothing here was checked on the target/i);
  });
});

describe('machine wake-info <machine>', () => {
  let root: string;
  let a: string;
  let b: string;
  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'machine-wakeinfo-'));
    a = join(root, 'a');
    b = join(root, 'b');
    await provision(root, a, b, []);
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('prints the checklist with the pinned address and the MAC, exits 0, writes nothing', async () => {
    await cli(a, ['peer', 'connect', 'laptop', '--address', '192.168.1.40:47921', '--wake-mac', 'AA-BB-CC-DD-EE-01']);
    const before = readdirSync(a).sort();
    const r = await cli(a, ['wake-info', 'laptop']);
    expect(r.code).toBe(0);
    expect(r.err).toBe('');
    expect(r.out).toContain(`"laptop" (${readMachine(b).uuid})`);
    expect(r.out).toMatch(/pinned address\s+192\.168\.1\.40:47921/);
    expect(r.out).toMatch(/wake MAC\s+aa:bb:cc:dd:ee:01/);
    expect(r.out).toContain('\n\n');
    expect(readdirSync(a).sort()).toEqual(before);
    expect(existsSync(join(a, 'wake-audit.log'))).toBe(false);
  });

  it('works for a peer with no settings at all', async () => {
    const r = await cli(a, ['wake-info', 'laptop']);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/wake MAC\s+not configured/);
    expect(r.out).toContain('machine peer connect laptop --address <ip>:47921 --wake-mac <aa:bb:cc:dd:ee:ff>');
  });

  it('an unknown machine is exit 3, a missing argument is a usage error, --json is refused', async () => {
    const unknown = await cli(a, ['wake-info', 'nobody']);
    expect(unknown.code).toBe(3);
    expect(unknown.err).toMatch(/nobody/);
    const none = await cli(a, ['wake-info']);
    expect(none.code).toBe(2);
    expect(none.err).toMatch(/usage: machine wake-info <machine>/);
    const json = await cli(a, ['wake-info', 'laptop', '--json']);
    expect(json.code).toBe(2);
    expect(json.err).toMatch(/--json does not apply to `machine wake-info`/);
  });

  it('this machine itself is refused: the checklist is for a peer', async () => {
    const r = await cli(a, ['wake-info', 'desktop']);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/that is this machine/);
  });
});
