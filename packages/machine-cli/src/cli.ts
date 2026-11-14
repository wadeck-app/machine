import { existsSync } from 'node:fs';
import { createDaemonClient } from '@wadeck-app/singleton-daemon-kit';
import { adminInit, signPolicyFile, type Prompt } from './admin.js';
import { makeCommands, type AliasAnswer, type ListAnswer, type NotInitialized, type ResolveAnswer, type StatusAnswer } from './commands.js';
import { startMachineDaemon } from './daemonEntry.js';
import { writeFileAtomic } from './fsutil.js';
import { initMachine } from './identity.js';
import { resolveConfigDir } from './paths.js';
import { promptHidden } from './prompt.js';
import { appVersion } from './version.js';

export interface CliIo {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  /** Hidden passphrase prompt; defaults to the terminal. Tests inject one. */
  prompt?: Prompt;
}

export const EXIT = { ok: 0, failure: 1, usage: 2, reference: 3 } as const;

const HELP = `machine - private network between your machines

Usage: machine <command> [options]

Commands:
  init --name <name>             create this machine's UUID and identity key
  status                         identity, enrollment state, version
  list                           this machine and its registered peers
  resolve <reference>            show which machine a reference means
  alias list                     local aliases
  alias set <alias> <reference>  create an alias (--replace to repoint it)
  alias rm <alias>               remove an alias
  daemon                         run the daemon in the foreground (started by orch)
  admin init                     create the admin key on this machine (passphrase shown once)
  admin sign-policy <draft.json> sign a policy draft after showing it (--out <file>, else stdout)

Options:
  --json                 machine-readable output
  --out <file>           write the signed document to a file (--force to overwrite)
  --config-dir <path>    configuration directory (default: MACHINE_CONFIG_DIR or ~/.config/machine)
  --help, -h             this help

A reference is a machine name, a local alias, a UUID or a unique UUID prefix of 4+ hex characters.

Exit codes: 0 ok, 1 failure, 2 usage error, 3 unknown or ambiguous machine reference
`;

interface Parsed {
  positional: string[];
  json: boolean;
  help: boolean;
  replace: boolean;
  force: boolean;
  name?: string;
  out?: string;
  configDir?: string;
}

function parse(argv: string[]): Parsed {
  const out: Parsed = { positional: [], json: false, help: false, replace: false, force: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    const valueOf = (flag: string): string => {
      const v = argv[++i];
      if (v === undefined || v.startsWith('--')) throw new UsageError(`${flag} needs a value`);
      return v;
    };
    if (a === '--json') out.json = true;
    else if (a === '--help' || a === '-h') out.help = true;
    else if (a === '--replace') out.replace = true;
    else if (a === '--force') out.force = true;
    else if (a === '--name') out.name = valueOf('--name');
    else if (a === '--out') out.out = valueOf('--out');
    else if (a === '--passphrase' || a.startsWith('--passphrase=')) {
      throw new UsageError('a passphrase is never accepted as an argument (it would stay in your shell history and in the process list): it is typed at the prompt');
    }
    else if (a === '--config-dir') out.configDir = valueOf('--config-dir');
    else if (a.startsWith('--')) throw new UsageError(`unknown option "${a}": see \`machine --help\``);
    else out.positional.push(a);
  }
  return out;
}

class UsageError extends Error {}

export async function runCli(argv: string[], io: CliIo, env: Record<string, string | undefined> = process.env): Promise<number> {
  let args: Parsed;
  try {
    args = parse(argv);
  } catch (e) {
    io.stderr(`[fail] ${(e as Error).message}\n`);
    return EXIT.usage;
  }
  if (args.help) {
    io.stdout(HELP);
    return EXIT.ok;
  }
  const [command, ...rest] = args.positional;
  if (command === undefined) {
    io.stderr(`[fail] no command given

${HELP}`);
    return EXIT.usage;
  }

  const fail = (message: string, code: number = EXIT.failure): number => {
    io.stderr(`[fail] ${message}\n`);
    return code;
  };
  const emit = (value: unknown, text: string): void => io.stdout(args.json ? `${JSON.stringify(value, null, 2)}\n` : text);

  // Commands that take no positional argument refuse one instead of silently ignoring a typo.
  const maxPositional: Record<string, number> = { init: 0, status: 0, list: 0, daemon: 0, resolve: 1 };
  const allowed = maxPositional[command];
  if (allowed !== undefined && rest.length > allowed) {
    return fail(`unexpected argument "${rest[allowed]}" for \`machine ${command}\`: see \`machine --help\``, EXIT.usage);
  }

  try {
    const configDir = resolveConfigDir(args.configDir, env);

    if (command === 'init') {
      if (args.name === undefined) return fail('init needs --name <name>, for example `machine init --name desktop`', EXIT.usage);
      const m = initMachine(configDir, args.name);
      emit({ uuid: m.uuid, name: m.name }, `[ok] initialized "${m.name}"\nuuid: ${m.uuid}\nnext: enroll this machine (\`machine join\`) to reach your other machines\n`);
      return EXIT.ok;
    }

    if (command === 'daemon') {
      const daemon = await startMachineDaemon(configDir, { version: appVersion() });
      io.stdout(`[ok] machine daemon listening on 127.0.0.1:${daemon.port} (config ${configDir})\n`);
      await daemon.stopped;
      return EXIT.ok;
    }

    if (command === 'admin') {
      const [sub, draft] = rest;
      for (const name of ['MACHINE_PASSPHRASE', 'MACHINE_ADMIN_PASSPHRASE']) {
        if (env[name] !== undefined) {
          io.stderr(`[warn] ${name} is set but ignored: passphrases are only read from the terminal prompt, never from the environment. Unset it\n`);
        }
      }
      if (sub === 'init') {
        if (draft !== undefined) return fail(`unexpected argument "${draft}" for \`machine admin init\``, EXIT.usage);
        const r = adminInit(configDir);
        // The passphrase goes to the terminal channel only: stdout may be redirected or captured in a log.
        io.stderr(`Admin passphrase (shown only once, write it down now; it cannot be recovered):\n  ${r.passphrase}\n`);
        emit({ adminKeyId: r.adminKeyId, adminPublicKey: r.adminPublicKey }, `[ok] admin key created (id ${r.adminKeyId})\n`);
        return EXIT.ok;
      }
      if (sub === 'sign-policy') {
        if (draft === undefined || rest.length > 2) return fail('usage: machine admin sign-policy <draft.json> [--out <file>]', EXIT.usage);
        // Fail before the passphrase is typed, not after the key was unlocked.
        if (args.out && existsSync(args.out) && !args.force) return fail(`${args.out} already exists: choose another file or pass --force to overwrite it`);
        const prompt = io.prompt ?? promptHidden;
        const { signed } = await signPolicyFile(configDir, draft, {
          now: Math.floor(Date.now() / 1000),
          prompt,
          onSummary: (summary) => io.stderr(`${summary}\nSigning this exact policy. Enter the admin passphrase to confirm, Ctrl-C to cancel.\n`),
        });
        const text = `${JSON.stringify(signed, null, 2)}\n`;
        if (args.out) {
          writeFileAtomic(args.out, text, 0o644);
          io.stderr(`[ok] signed policy written to ${args.out}\n`);
        } else {
          io.stdout(text);
        }
        return EXIT.ok;
      }
      return fail('usage: machine admin init | sign-policy <draft.json>', EXIT.usage);
    }

    // Everything else goes through the daemon when it runs and through the same code in-process when it does not.
    const client = createDaemonClient({ configDir, commands: makeCommands(configDir, appVersion) });
    const notInitialized = (r: { initialized?: boolean; message?: string }): r is NotInitialized => r.initialized === false;

    switch (command) {
      case 'status': {
        const r = (await client.send('status')) as StatusAnswer | NotInitialized;
        if (notInitialized(r)) return fail(r.message);
        emit(r, `${r.name} (${r.uuid})\nversion: ${r.version}\nconfig: ${r.configDir}\n${r.enrolled ? `enrolled, ${r.peers} peer(s)` : (r.note ?? 'not enrolled')}\n`);
        return EXIT.ok;
      }
      case 'list': {
        const r = (await client.send('list')) as ListAnswer | NotInitialized;
        if (notInitialized(r)) return fail(r.message);
        const lines = [`${r.self.name} (${r.self.uuid}) [this machine]`, ...r.peers.map((p) => `${p.name} (${p.uuid})${p.aliases.length ? ` aliases: ${p.aliases.join(', ')}` : ''}`)];
        emit(r, `${lines.join('\n')}\n${r.note ? `${r.note}\n` : ''}`);
        return EXIT.ok;
      }
      case 'resolve': {
        const ref = rest[0];
        if (ref === undefined) return fail('resolve needs a reference: `machine resolve <name|alias|uuid>`', EXIT.usage);
        const r = (await client.send('resolve', { ref })) as ResolveAnswer;
        if ('initialized' in r) return fail(r.message);
        if (!r.ok) return fail(r.message, EXIT.reference);
        emit(r, `${r.uuid}${r.name ? ` (${r.name})` : ''} via ${r.via}\n`);
        return EXIT.ok;
      }
      case 'alias': {
        const [sub, a, b] = rest;
        const arity: Record<string, number> = { list: 0, set: 2, rm: 1 };
        const expected = sub === undefined ? undefined : arity[sub];
        if (expected !== undefined && rest.length - 1 > expected) return fail(`unexpected argument "${rest[expected + 1]}" for \`machine alias ${sub}\``, EXIT.usage);
        if (sub === 'list') {
          const aliases = (await client.send('aliasList')) as Record<string, string>;
          emit(aliases, Object.keys(aliases).length ? `${Object.entries(aliases).map(([k, v]) => `${k} -> ${v}`).join('\n')}\n` : 'no alias\n');
          return EXIT.ok;
        }
        if (sub === 'set') {
          if (a === undefined || b === undefined) return fail('usage: machine alias set <alias> <reference>', EXIT.usage);
          const r = (await client.send('aliasSet', { alias: a, ref: b, replace: args.replace })) as AliasAnswer;
          if ('initialized' in r) return fail(r.message);
          if (!r.ok) return fail(r.message, r.reason === 'conflict' ? EXIT.failure : EXIT.reference);
          emit(r, `[ok] ${r.alias} -> ${r.uuid}${r.previous ? ` (was ${r.previous})` : ''}\n`);
          return EXIT.ok;
        }
        if (sub === 'rm') {
          if (a === undefined) return fail('usage: machine alias rm <alias>', EXIT.usage);
          const r = (await client.send('aliasRemove', { alias: a })) as { ok: boolean; message?: string };
          if (!r.ok) return fail(r.message ?? 'no such alias');
          emit(r, `[ok] removed ${a}\n`);
          return EXIT.ok;
        }
        return fail('usage: machine alias list | set <alias> <reference> | rm <alias>', EXIT.usage);
      }
      default:
        return fail(`unknown command "${command}": see \`machine --help\``, EXIT.usage);
    }
  } catch (e) {
    return fail((e as Error).message);
  }
}
