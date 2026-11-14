import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseAddress, remoteExitCode } from './cliNetwork.js';
import { runCli } from './cli.js';

describe('remoteExitCode', () => {
  it('passes the exit code of the remote command through', () => {
    expect(remoteExitCode(0)).toBe(0);
    expect(remoteExitCode(7)).toBe(7);
    expect(remoteExitCode(254)).toBe(254);
  });

  it('never turns a failure into success: out-of-range and negative codes stay non-zero', () => {
    expect(remoteExitCode(-1073741819)).not.toBe(0);
    expect(remoteExitCode(-1)).not.toBe(0);
    expect(remoteExitCode(256)).not.toBe(0);
    expect(remoteExitCode(512)).not.toBe(0);
  });

  it('keeps 255 for machine-level failures only', () => {
    expect(remoteExitCode(255)).toBe(254);
    expect(remoteExitCode(null)).toBe(255);
  });
});

describe('parseAddress', () => {
  it('accepts host:port, a name and a bracketed IPv6 address', () => {
    expect(parseAddress('127.0.0.1:47921')).toEqual({ host: '127.0.0.1', port: 47921 });
    expect(parseAddress('desktop.lan:80')).toEqual({ host: 'desktop.lan', port: 80 });
    expect(parseAddress('[::1]:47921')).toEqual({ host: '::1', port: 47921 });
    expect(parseAddress('[fe80::1]:1')).toEqual({ host: 'fe80::1', port: 1 });
  });

  it.each(['', 'host', 'host:0', 'host:65536', '::1:80', '[::1]', '[::1]:x', ':80', 'a b:80'])('refuses %j', (text) => {
    expect(parseAddress(text)).toBeUndefined();
  });
});

describe('machine run failures are all 255', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'machine-run-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  async function run(...args: string[]) {
    let out = '';
    let err = '';
    const split = args.indexOf('--');
    const argv = split === -1 ? [...args, '--config-dir', dir] : [...args.slice(0, split), '--config-dir', dir, ...args.slice(split)];
    const code = await runCli(argv, { stdout: (t) => (out += t), stderr: (t) => (err += t) }, {});
    return { code, out, err };
  }

  it('on a machine that was never initialized', async () => {
    const r = await run('run', 'laptop', '--address', '127.0.0.1:1', '--', 'echo', 'hi');
    expect(r.code).toBe(255);
    expect(r.err).toMatch(/machine init/);
  });

  it('with an unknown shell, an invalid address or a missing command', async () => {
    await run('init', '--name', 'desktop');
    expect((await run('run', 'laptop', '--address', '127.0.0.1:1', '--shell', 'zsh', '--', 'x')).code).toBe(255);
    expect((await run('run', 'laptop', '--address', 'nope', '--', 'x')).code).toBe(255);
    expect((await run('run', 'laptop', '--address', '127.0.0.1:1')).code).toBe(255);
  });

  it('refuses a command whose words need quoting, asking for ONE quoted argument', async () => {
    await run('init', '--name', 'desktop');
    const r = await run('run', 'laptop', '--address', '127.0.0.1:1', '--', 'grep', 'foo bar', 'file');
    expect(r.code).toBe(255);
    expect(r.err).toMatch(/one (quoted )?argument/i);
  });
});

describe('admin register input checks', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'machine-reg-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  async function run(...args: string[]) {
    let out = '';
    let err = '';
    const prompt = async () => {
      throw new Error('the prompt must not be asked');
    };
    const code = await runCli([...args, '--config-dir', dir], { stdout: (t) => (out += t), stderr: (t) => (err += t), prompt }, {});
    return { code, out, err };
  }

  it('validates --days before telling the user to type the passphrase', async () => {
    await run('init', '--name', 'desktop');
    await run('admin', 'init');
    writeFileSync(join(dir, 'info.json'), '{}');
    for (const days of ['abc', '0', '99999']) {
      const r = await run('admin', 'register', join(dir, 'info.json'), '--out', join(dir, 'b.json'), '--days', days);
      expect(r.code).toBe(2);
      expect(r.err).toMatch(/--days/);
      expect(r.err).not.toMatch(/passphrase to sign/);
    }
  });

  it.each([['null'], ['5'], ['[]']])('reports an input file holding %s by name instead of a TypeError', async (content) => {
    await run('init', '--name', 'desktop');
    await run('admin', 'init');
    const file = join(dir, 'info.json');
    writeFileSync(file, content);
    const r = await run('admin', 'register', file, '--out', join(dir, 'b.json'));
    expect(r.code).toBe(1);
    expect(r.err).toContain('info.json');
    expect(r.err).not.toMatch(/Cannot read properties/);
    const p = await run('peer', 'import', file);
    expect(p.err).toContain('info.json');
    expect(p.err).not.toMatch(/Cannot read properties/);
    const q = await run('policy', 'install', file);
    expect(q.err).toContain('info.json');
    expect(q.err).not.toMatch(/Cannot read properties/);
  });
});
