import { InputDeclarationError, SHELLS, type Shell } from '@wadeck-app/machine-core';
import { inputOf } from './allowText.js';
import type { Prompt } from './admin.js';
import { UnresolvedReferenceError } from './adminRevoke.js';
import { NotInitializedError } from './errors.js';
import { EXIT, parseIndex, type CommandContext } from './cliTypes.js';
import { readPolicyMode } from './policyMode.js';
import { runDelegate, runLocalAllow, runLocalEnable, type LocalIo } from './policyLocal.js';
import { unknownSubcommandMessage } from './cliHelp.js';

// `machine policy local enable | local | delegate | allow` (hard rule 4 as amended): the machine manages its own allow list.

export async function runPolicyModeCommand(ctx: CommandContext, io: { prompt: Prompt; ask: (label: string) => Promise<string> }): Promise<number> {
  const { args, rest, configDir, fail, emit } = ctx;
  const epochSeconds = () => Math.floor((ctx.io.now?.() ?? new Date()).getTime() / 1000);
  const [sub, first, second] = rest;
  // The questions and the explanations go to the normal output, the warnings to the error output; with --json the document is alone on stdout.
  const local: LocalIo = {
    prompt: io.prompt,
    ask: io.ask,
    say: args.json ? ctx.io.stderr : ctx.io.stdout,
    warn: ctx.io.stderr,
    now: epochSeconds,
  };
  try {
    if (sub === 'local') {
      if (first === undefined) {
        const mode = readPolicyMode(configDir);
        emit(
          mode.mode === 'local' ? { policyMode: 'local', localPolicyKeyId: mode.localKeyId, since: mode.since } : { policyMode: 'admin' },
          mode.mode === 'local'
            ? `policy mode: local (this machine manages its own allow list, policy key ${mode.localKeyId})\nedit it with \`machine policy allow\`, give it back with \`machine policy delegate\`\n`
            : 'policy mode: admin (the allow list is signed by the admin)\ntake it over with `machine policy local enable`\n',
        );
        return EXIT.ok;
      }
      if (first !== 'enable' || second !== undefined) return fail(first === 'enable' ? 'usage: machine policy local enable [--hint <text>]' : unknownSubcommandMessage('policy', `local ${first}`), EXIT.usage);
      const r = await runLocalEnable(configDir, { ...local, ...(args.hint !== undefined ? { hint: args.hint } : {}) });
      emit(
        { policyMode: 'local', localPolicyKeyId: r.keyId, setAside: r.setAside },
        [
          `[ok] this machine now manages its own allow list`,
          `policy key id: ${r.keyId}`,
          'the allow list is EMPTY: every command from a peer is refused until you allow one',
          'next: `machine policy allow -- <command>` (the exact command line a peer may run here); `machine policy allow --list` shows the list',
          'back to the admin: `machine policy delegate`. The passphrase is asked each time and cannot be recovered: if it is lost the list stays as it is (getting-started.md, "Forgotten local passphrase")',
          '',
        ].join('\n'),
      );
      return EXIT.ok;
    }

    if (sub === 'delegate') {
      if (first !== undefined) return fail('usage: machine policy delegate', EXIT.usage);
      const r = await runDelegate(configDir, local);
      emit(
        { policyMode: 'admin', archivedKey: r.archivedKey, ...(r.archivedPolicy !== undefined ? { archivedPolicy: r.archivedPolicy } : {}) },
        [
          '[ok] allow list given back to the admin: the allow list is EMPTY until the admin signs and sends a policy for this machine',
          `the local policy key was archived: ${r.archivedKey} (no longer used, delete it by hand when you do not need it)`,
          'on the admin machine: `machine admin allow <this machine> -- <command>`',
          '',
        ].join('\n'),
      );
      return EXIT.ok;
    }

    // sub === 'allow'
    const usage = 'usage: machine policy allow [--shell cmd|ps|bash|sh] [--peer <machine>] [--times <n> | --for <duration> | --until <date>] [--renew] -- <command> | machine policy allow --remove [--shell <shell>] [--peer <machine>] (-- <command> | --index <n>) | machine policy allow --list';
    if (args.list && args.remove) return fail(`--list and --remove cannot be combined. ${usage}`, EXIT.usage);
    if (args.shell !== undefined && !(SHELLS as readonly string[]).includes(args.shell)) return fail(`unknown shell "${args.shell}": expected one of ${SHELLS.join(', ')}`, EXIT.usage);
    const words = args.passthrough.length > 0 ? args.passthrough : rest.slice(1);
    const parsedIndex = parseIndex(args.index);
    const index = parsedIndex.ok ? parsedIndex.index : undefined;
    if (!parsedIndex.ok) {
      return fail(parsedIndex.message, EXIT.usage);
    }
    if (index !== undefined && words.length > 0) {
      return fail(`--index replaces the command: give one or the other. ${usage}`, EXIT.usage);
    }
    if (args.list) {
      if (words.length > 0 || args.peer !== undefined) return fail(`--list takes no command and no --peer. ${usage}`, EXIT.usage);
    } else if (index === undefined) {
      if (words.length === 0) return fail(usage, EXIT.usage);
      if (words.length > 1 && words.some((word) => /[\s"'`]/.test(word))) {
        return fail('the command has words with spaces or quotes: pass the whole command as ONE quoted argument, for example -- "grep \'foo bar\' file", so that it is allowed exactly as written', EXIT.usage);
      }
    }
    const mode = args.list ? 'list' : args.remove ? 'remove' : 'allow';
    let declared: ReturnType<typeof inputOf>;
    try {
      declared = inputOf(args);
    } catch (e) {
      if (e instanceof InputDeclarationError) return fail(`${e.message}. Nothing was signed`, EXIT.usage);
      throw e;
    }
    const r = await runLocalAllow(configDir, {
      ...local,
      mode,
      ...(mode !== 'list' && index === undefined ? { command: words.join(' ') } : {}),
      ...(index !== undefined ? { index } : {}),
      ...(mode === 'allow' ? { lifetime: { ...(args.times !== undefined ? { times: args.times } : {}), ...(args.for !== undefined ? { for: args.for } : {}), ...(args.until !== undefined ? { until: args.until } : {}) } } : {}),
      ...(mode === 'allow' && args.renew ? { renew: true } : {}),
      ...(declared !== undefined ? { input: declared.declaration, inputAdded: declared.added } : {}),
      ...(args.shell !== undefined ? { shell: args.shell as Shell } : {}),
      ...(args.peer !== undefined ? { peer: args.peer } : {}),
      defaultShell: process.platform === 'win32' ? 'cmd' : 'sh',
    });
    emit(r, '');
    return EXIT.ok;
  } catch (e) {
    if (e instanceof UnresolvedReferenceError) return fail(e.message, EXIT.reference);
    if (e instanceof NotInitializedError) return fail(e.message);
    throw e;
  }
}
