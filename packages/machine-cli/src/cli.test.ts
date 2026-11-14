import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runCli } from './cli.js';
import { readMachine } from './identity.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'machine-cli-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

async function run(...args: string[]): Promise<{ code: number; out: string; err: string }> {
  let out = '';
  let err = '';
  const code = await runCli([...args, '--config-dir', dir], { stdout: (t) => (out += t), stderr: (t) => (err += t) });
  return { code, out, err };
}

describe('machine init / status', () => {
  it('status before init fails with the command to run', async () => {
    const r = await run('status');
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/machine init --name/);
  });

  it('init prints the UUID and name, never the private key', async () => {
    const r = await run('init', '--name', 'desktop');
    expect(r.code).toBe(0);
    const m = readMachine(dir);
    expect(r.out).toContain(m.uuid);
    expect(r.out).toContain('desktop');
    expect(r.out + r.err).not.toContain(Buffer.from(m.identity.privateKeyPkcs8).toString('base64url'));
  });

  it('init without --name is a usage error naming the option', async () => {
    const r = await run('init');
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/--name/);
  });

  it('init twice fails and says the machine is already initialized', async () => {
    await run('init', '--name', 'desktop');
    const r = await run('init', '--name', 'desktop');
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/already initialized/);
  });

  it('status --json is machine-readable and says the machine is not enrolled yet', async () => {
    await run('init', '--name', 'desktop');
    const r = await run('status', '--json');
    expect(r.code).toBe(0);
    const s = JSON.parse(r.out) as { name: string; enrolled: boolean; uuid: string };
    expect(s).toMatchObject({ name: 'desktop', enrolled: false });
    expect(s.uuid).toBe(readMachine(dir).uuid);
  });

  it('status in text says what is missing, not just that something is', async () => {
    await run('init', '--name', 'desktop');
    const r = await run('status');
    expect(r.out).toMatch(/not enrolled/);
    expect(r.out).toMatch(/machine join/);
  });
});

describe('machine list / resolve / alias', () => {
  it('list before enrollment shows this machine and states there are no peers because enrollment is missing', async () => {
    await run('init', '--name', 'desktop');
    const r = await run('list');
    expect(r.code).toBe(0);
    expect(r.out).toContain('desktop');
    expect(r.out).toMatch(/not enrolled/);
  });

  it('list --json returns self and an empty peer list', async () => {
    await run('init', '--name', 'desktop');
    const r = await run('list', '--json');
    const l = JSON.parse(r.out) as { self: { name: string }; peers: unknown[]; enrolled: boolean };
    expect(l.self.name).toBe('desktop');
    expect(l.peers).toEqual([]);
    expect(l.enrolled).toBe(false);
  });

  it('resolve finds this machine by its name and by a UUID prefix', async () => {
    await run('init', '--name', 'desktop');
    const uuid = readMachine(dir).uuid;
    expect((await run('resolve', 'desktop')).out).toContain(uuid);
    expect((await run('resolve', uuid.slice(0, 6))).out).toContain(uuid);
  });

  it('resolve of an unknown machine exits 3 and lists what is known', async () => {
    await run('init', '--name', 'desktop');
    const r = await run('resolve', 'nas');
    expect(r.code).toBe(3);
    expect(r.err).toMatch(/unknown machine "nas".*desktop/);
  });

  it('alias set / list / rm round trip through references', async () => {
    await run('init', '--name', 'desktop');
    const uuid = readMachine(dir).uuid;
    expect((await run('alias', 'set', 'home', 'desktop')).code).toBe(0);
    expect(JSON.parse((await run('alias', 'list', '--json')).out)).toEqual({ home: uuid });
    expect((await run('resolve', 'home')).out).toContain(uuid);
    expect((await run('alias', 'rm', 'home')).code).toBe(0);
    expect((await run('resolve', 'home')).code).toBe(3);
  });

  it('alias set to an unknown machine fails with the resolution error', async () => {
    await run('init', '--name', 'desktop');
    const r = await run('alias', 'set', 'nas', 'nowhere');
    expect(r.code).toBe(3);
    expect(r.err).toMatch(/unknown machine "nowhere"/);
  });
});

describe('machine usage', () => {
  it('prints help with the exit codes and exits 0', async () => {
    const r = await run('--help');
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/init/);
    expect(r.out).toMatch(/exit codes/i);
  });

  it('an unknown command exits 2 and points to --help', async () => {
    const r = await run('frobnicate');
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/unknown command "frobnicate".*--help/);
  });

  it('no command at all prints the help on stderr and exits 2', async () => {
    const r = await run();
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/Usage/);
  });
});

describe('machine strictness', () => {
  it.each([['status', 'foo'], ['list', 'bar'], ['init', 'desktop']])('refuses a stray argument for %s: %s', async (...args) => {
    const r = await run(...args);
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/unexpected argument/);
  });

  it('no command says so before showing the help', async () => {
    const r = await run();
    expect(r.err).toMatch(/^\[fail\] no command given/);
    expect(r.err).not.toMatch(/Usage: machine - private/);
  });

  it('accepts an alias equal to the name of the machine it points to', async () => {
    await run('init', '--name', 'desktop');
    const r = await run('alias', 'set', 'desktop', 'desktop');
    // Pointing a name at itself is harmless.
    expect(r.code).toBe(0);
  });
});
