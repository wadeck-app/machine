import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runCli } from './cli.js';
import type { CliMetaDeps } from './cliMeta.js';

// Decision 66: every command group answers `--help`, `help`, `machine help <group>` and `<group> <sub> --help` with its own help
// (no configuration directory needed), refuses an unknown subcommand with the list, and shows a read-only view when invoked bare.

const GROUPS: Record<string, string[]> = {
  admin: ['init', 'login', 'approve', 'revoke', 'allow', 'distribute', 'forget-relay-record', 'pin', 'register', 'sign-policy'],
  peer: ['info', 'import', 'connect', 'wake', 'forget-record'],
  startup: ['status', 'enable', 'disable'],
  cli: ['version', 'update', 'rollback', 'self-check', 'logs', 'post-update', 'register'],
  alias: ['list', 'set', 'rm'],
  policy: ['install'],
};

let root: string;
let missing: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'machine-help-'));
  // Never created: help must not need it, nor create it, nor log into it.
  missing = join(root, 'not-created');
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

async function run(args: string[], dir = missing, cliMeta: Partial<CliMetaDeps> = {}): Promise<{ code: number; out: string; err: string }> {
  let out = '';
  let err = '';
  const code = await runCli([...args, '--config-dir', dir], { stdout: (t) => (out += t), stderr: (t) => (err += t), cliMeta });
  return { code, out, err };
}

describe('group help: the four forms', () => {
  it.each(Object.entries(GROUPS))('%s: --help, help and `machine help %s` print the same group help on stdout, exit 0, nothing else', async (group, subs) => {
    const forms = [[group, '--help'], [group, 'help'], ['help', group], [group, '-h']];
    const answers = [];
    for (const args of forms) {
      const r = await run(args);
      expect(r.code, args.join(' ')).toBe(0);
      expect(r.err, args.join(' ')).toBe('');
      answers.push(r.out);
    }
    expect(new Set(answers).size).toBe(1);
    const text = answers[0] as string;
    expect(text).toMatch(new RegExp(`^machine ${group} - `));
    for (const sub of subs) expect(text, sub).toMatch(new RegExp(`^  ${sub}\\b`, 'm'));
    expect(text).toContain('Examples:');
    expect(text).toContain(`machine ${group} <subcommand> --help`);
    // Contextual: not the global list.
    expect(text).not.toContain('Getting started');
    // Needs no configuration directory: nothing was created (no folder, no log).
    expect(existsSync(missing)).toBe(false);
  });

  it.each(Object.entries(GROUPS).flatMap(([group, subs]) => subs.map((sub) => [group, sub] as const)))('machine %s %s --help prints that subcommand only, with an example, exit 0', async (group, sub) => {
    for (const args of [[group, sub, '--help'], [group, 'help', sub], ['help', group, sub]]) {
      const r = await run(args);
      expect(r.code, args.join(' ')).toBe(0);
      expect(r.err, args.join(' ')).toBe('');
      expect(r.out).toMatch(new RegExp(`^machine ${group} ${sub}\\b`));
      expect(r.out).toContain('Examples:');
      expect(r.out).toContain(`machine ${group} --help`);
    }
    expect(existsSync(missing)).toBe(false);
  });

  it('an unknown subcommand with --help is still a usage error', async () => {
    const r = await run(['admin', 'frobnicate', '--help']);
    expect(r.code).toBe(2);
    expect(r.out).toBe('');
    expect(r.err).toMatch(/unknown admin subcommand "frobnicate"/);
  });

  it('machine help alone is the global help; an unknown topic is a usage error naming the groups', async () => {
    const all = await run(['help']);
    expect(all.code).toBe(0);
    expect(all.out).toBe((await run(['--help'])).out);
    const bad = await run(['help', 'frobnicate']);
    expect(bad.code).toBe(2);
    expect(bad.out).toBe('');
    expect(bad.err).toMatch(/unknown help topic "frobnicate".*admin, peer, startup, cli, alias, policy/);
  });

  it('a non-group command keeps the global help for --help', async () => {
    const r = await run(['ping', '--help']);
    expect(r.code).toBe(0);
    expect(r.out).toContain('Getting started');
  });

  it('the global help says what a bare group does and where the group help is', async () => {
    const r = await run(['--help']);
    expect(r.out).toMatch(/machine <group>.*current state/s);
    expect(r.out).toMatch(/machine <group> --help/);
  });
});

describe('unknown subcommand: usage error, names it, one-line list, points to the group help', () => {
  it.each(Object.entries(GROUPS))('%s', async (group, subs) => {
    // A configuration directory that exists, as in real use.
    const r = await run([group, 'frobnicate'], root);
    expect(r.code).toBe(2);
    expect(r.out).toBe('');
    expect(r.err).toContain(`"frobnicate"`);
    // The order of the list is the order of the help (startup writes `[status] | enable | disable`, see startup.test.ts).
    for (const sub of subs) expect(r.err).toContain(sub);
    expect(r.err).toContain(`machine ${group} --help`);
    // One line, not a dump of the global list.
    expect(r.err.trim().split('\n')).toHaveLength(1);
  });
});

describe('a bare group shows its read-only view (or its help), exit 0', () => {
  it('alias: the list of aliases', async () => {
    expect((await run(['init', '--name', 'desktop'], root)).code).toBe(0);
    expect((await run(['alias', 'set', 'home', 'desktop'], root)).code).toBe(0);
    const bare = await run(['alias'], root);
    expect(bare.code, bare.err).toBe(0);
    expect(bare.out).toContain('home -> ');
    expect(bare.out).toContain('machine alias --help');
    expect(JSON.parse((await run(['alias', '--json'], root)).out)).toEqual((JSON.parse((await run(['alias', 'list', '--json'], root)).out)));
  });

  it('peer: the peers this machine knows, like machine list, then where the peer commands are', async () => {
    await run(['init', '--name', 'desktop'], root);
    const list = await run(['list'], root);
    const bare = await run(['peer'], root);
    expect(bare.code, bare.err).toBe(0);
    expect(bare.out.startsWith(list.out)).toBe(true);
    expect(bare.out).toContain('machine peer --help');
    expect((await run(['peer', '--json'], root)).out).toBe((await run(['list', '--json'], root)).out);
  });

  it('peer before init: the same actionable failure as machine list', async () => {
    const list = await run(['list'], root);
    const bare = await run(['peer'], root);
    expect(bare.code).toBe(1);
    expect(bare.err).toBe(list.err);
  });

  it('cli: the version view of `machine cli version`, no update is started', async () => {
    const seen: string[] = [];
    const r = await run(['cli'], root, { version: '2026.11.14-592-bbbbbbbb', showVersion: async (pkg, v) => void seen.push(`${pkg} ${v}`) });
    expect(r.code, r.err).toBe(0);
    expect(seen).toEqual(['@wadeck-app/machine-cli 2026.11.14-592-bbbbbbbb']);
    expect(r.out).toContain('machine cli --help');
  });

  it('policy: no read-only view exists, so the group help (stdout, exit 0)', async () => {
    const r = await run(['policy'], root);
    expect(r.code).toBe(0);
    expect(r.err).toBe('');
    expect(r.out).toMatch(/^machine policy - /);
  });

  it('a stray option on a bare group is still refused (never silently ignored)', async () => {
    const r = await run(['admin', '--reject'], root);
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/--reject/);
  });
});
